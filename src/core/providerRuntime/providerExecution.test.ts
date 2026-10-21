import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../test/environment.js";
import { createFakeExecutable } from "../../test/fakeExecutable.js";

const driver = fileURLToPath(
  new URL("../../test/fixtures/providerReliability.ts", import.meta.url),
);
// This script executes actual local commands and emits each provider's own wire protocol.
const body = `
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), provider = scenario.provider;
if (args.includes('--help')) { console.log('Usage: exec --config --model --conversation --print'); process.exit(0); }
if (args.includes('--version')) { console.log('fixture 1.0.0'); process.exit(0); }
if (args.includes('--auto-approve') || args.includes('--dangerously-skip-permissions')) throw Error('Permission bypass');
const output = async text => { if (!process.stdout.write(text)) await new Promise(r => process.stdout.once('drain',r)); };
const send = async record => { const text=JSON.stringify(record)+'\\n'; for(let i=0;i<text.length;i+=4093) await output(text.slice(i,i+4093)); };
async function main() {
  let prompt = args.at(-1);
  if (provider==='mistral'||provider==='openai'||provider==='codex') { prompt=''; for await(const chunk of process.stdin) prompt+=chunk; }
  const cd=args.indexOf('--cd'); if(cd>=0)process.chdir(args[cd+1]);
  log({args,cwd:process.cwd(),prompt});
  if (prompt.includes('failure')) { console.error('Fixture authentication expired'); process.exitCode=1;return; }
  if (prompt.includes('protocol')) { await output('{invalid-json}\\n');setInterval(()=>{},1000);return; }
  const sid=provider+'-session';
  if (provider==='anthropic') await send({type:'system',subtype:'init',session_id:sid});
  else if(provider==='google') await send({event:'init',conversation_id:sid,init:{cwd:process.cwd()}});
  else if(provider==='openai'||provider==='codex') await send({type:'thread.started',thread_id:sid});
  for(let i=0;i<3;i++) {
    const id='tool-'+i, command='create fixture-'+i+'.txt';
    if(provider==='anthropic')await send({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command}}]}});
    else if(provider==='google')await send({event:'step_update',step_update:{step_index:i,state:'ACTIVE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:command}}}});
    else if(provider==='openai'||provider==='codex')await send({type:'item.started',item:{id,type:'command_execution',command,status:'in_progress'}});
    cp.execFileSync(process.execPath,['-e','require("node:fs").writeFileSync('+JSON.stringify('fixture-'+i+'.txt')+',"ok")']);
    const output='large tool output 雪 '.repeat(12000);
    if(provider==='anthropic')await send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:output}]}});
    else if(provider==='google')await send({event:'step_update',step_update:{step_index:i,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:command},output}}});
    else if(provider==='mistral')await send({type:'effect',id,session_id:sid,generation_status:'completed',title:command,state:{status:'completed',output_text:output,duration_ms:5}});
    else await send({type:'item.completed',item:{id,type:'command_execution',command,status:'completed',aggregated_output:output,exit_code:0}});
    if(prompt.includes('cancel')||prompt.includes('timeout')){setInterval(()=>{},1000);return;}
  }
  // A completed tool does not finish the request. Continue after a quiet interval.
  await new Promise(r=>setTimeout(r,80));
  const answer='DONE:'+provider+':雪';
  if(provider==='anthropic') { await send({type:'assistant',message:{id:'final',content:[{type:'text',text:answer}]}});await output(JSON.stringify({type:'result',subtype:'success',result:answer,session_id:sid})); }
  else if(provider==='google') { await send({event:'step_update',step_update:{step_index:10,state:'DONE',step_type:'agent_response',text_delta:answer}});await output(JSON.stringify({event:'result',result:{status:'SUCCESS',response:answer,conversation_id:sid}})); }
  else if(provider==='mistral')await output(JSON.stringify({type:'message',id:'final',session_id:sid,generation_status:'completed',role:'assistant',content:[{type:'text',text:answer}]}));
  else {await send({type:'item.completed',item:{id:'final',type:'agent_message',text:answer}});await send({type:'turn.completed',usage:{input_tokens:5,output_tokens:5}});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
`;

async function runFixture(provider: string, mode: string, root: string) {
  const workspace = join(root, `${provider}-${mode}`);
  mkdirSync(workspace, { recursive: true });
  const fake = createFakeExecutable("agent", body, { provider });
  const child = spawn(process.execPath, [driver, provider, fake.path, workspace, mode], {
    env: createTestEnvironment(root, { UBUME_DATA_DIR: join(root, "data") }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise((resolve) => child.once("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const value = JSON.parse(stdout);
    return {
      value,
      workspace,
      calls: fake.readLog() as { args: string[]; cwd: string; prompt: string }[],
    };
  } finally {
    clearTimeout(deadline);
    fake.cleanup();
  }
}

for (const provider of ["openai", "codex", "anthropic", "google", "mistral"]) {
  test(`${provider}: multi-file commands, repeated tools, large fragmented output and delayed final response`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-execution-"));
    try {
      const { value, workspace, calls } = await runFixture(provider, "stress", root);
      expect(value.response).toBe(`DONE:${provider}:雪`);
      expect(value.deltas).toBe(value.response);
      expect(value.tools.filter((t: { status: string }) => t.status === "completed")).toHaveLength(
        3,
      );
      for (let i = 0; i < 3; i++)
        expect(readFileSync(join(workspace, `fixture-${i}.txt`), "utf8")).toBe("ok");
      expect(calls[0]!.cwd).toBe(workspace);
      expect(calls[0]!.prompt).toBe(`stress:${provider}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test(`${provider}: cancellation after a completed tool drains the owned process`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-cancel-"));
    try {
      const { value } = await runFixture(provider, "cancel", root);
      expect(value.canceled).toBe(true);
      expect(value.response).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test(`${provider}: explicit authentication failure allows a subsequent successful task`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-recovery-"));
    try {
      const failed = await runFixture(provider, "failure", root);
      expect(failed.value.error).toMatch(/authenticat/i);
      const recovered = await runFixture(provider, "stress", root);
      expect(recovered.value.response).toBe(`DONE:${provider}:雪`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const provider of ["anthropic", "google", "mistral"]) {
  test(`${provider}: malformed protocol output cancels a stalled child and releases ownership`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-protocol-"));
    try {
      const { value } = await runFixture(provider, "protocol", root);
      expect(value.error).toContain("malformed JSON");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test(`${provider}: an explicitly configured task deadline still terminates stalled execution`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-deadline-"));
    try {
      const { value } = await runFixture(provider, "timeout", root);
      expect(value.error).toContain("configured deadline");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("four Ubume processes in separate workspaces preserve their provider and file ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-four-processes-"));
  try {
    const providers = ["openai", "anthropic", "google", "mistral"];
    const outcomes = await Promise.all(
      providers.map((provider) => runFixture(provider, "stress", root)),
    );
    expect(outcomes.map(({ value }) => value.response)).toEqual(
      providers.map((provider) => `DONE:${provider}:雪`),
    );
    for (const { workspace } of outcomes)
      expect(existsSync(join(workspace, "fixture-2.txt"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canceling one of four concurrent workspaces does not cancel the other providers", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-four-cancel-"));
  try {
    const providers = ["openai", "anthropic", "google", "mistral"];
    const outcomes = await Promise.all(
      providers.map((provider) =>
        runFixture(provider, provider === "anthropic" ? "cancel" : "stress", root),
      ),
    );
    expect(outcomes[1]!.value.canceled).toBe(true);
    for (const index of [0, 2, 3])
      expect(outcomes[index]!.value.response).toBe(`DONE:${providers[index]}:雪`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
