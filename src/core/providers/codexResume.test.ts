import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import { toProviderConversationHistory } from "../../session/conversation.js";
import { createTestEnvironment, withEnvironment } from "../../test/environment.js";
import {
  completedNativeSession,
  nativeContinuation,
} from "../providerRuntime/nativeContinuation.js";
import type { ProviderChatRequest } from "../providerRuntime/types.js";
import { codexSubprocessProvider } from "./codexSubprocess.js";

const fake = `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), scenario = process.env.RESUME_CASE;
if(args.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if(args.includes('--help')) {
 console.log(args.includes('resume') ? '--json --config --model --image --skip-git-repo-check' : '--config --model --image ' + (scenario==='unsupported' ? '' : 'Commands: resume')); process.exit(0);
}
(async()=>{
 let prompt='';for await(const chunk of process.stdin) prompt+=chunk;
 fs.appendFileSync(process.env.RESUME_LOG,JSON.stringify({args,prompt,cwd:process.cwd()})+'\\n');
 if(args[1]==='resume' && scenario==='legacy-productive') { console.log('tool ran; legacy output'); console.error('Session native-fixture not found'); process.exit(1); }
 if(args[1]==='resume' && scenario!=='native') {
   if(scenario==='productive') console.log(JSON.stringify({type:'item.completed',item:{id:'tool',type:'command_execution',command:'historical-looking text',status:'completed',aggregated_output:'done',exit_code:0}}));
   console.log(JSON.stringify({type:'error',message:scenario==='auth'?'Authentication expired: session not found':'Session native-fixture not found'}));process.exit(1);
 }
 console.log(JSON.stringify({type:'thread.started',thread_id:'continued-fixture'}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'fresh answer'}}));
 console.log(JSON.stringify({type:'turn.completed'}));
})();
`;

for (const scenario of [
  "native",
  "missing",
  "unsupported",
  "auth",
  "productive",
  "legacy-productive",
])
  test(`Codex continuation: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-codex-resume-"));
    const workspace = join(root, "workspace with spaces");
    mkdirSync(workspace);
    const executable = join(root, "fake-codex");
    writeFileSync(executable, fake, { mode: 0o700 });
    const log = join(root, "calls.jsonl");
    try {
      await withEnvironment(
        createTestEnvironment(root, {
          CODEX_EXECUTABLE: executable,
          RESUME_CASE: scenario,
          RESUME_LOG: log,
        }),
        async () => {
          const runtime = resolveRuntimeConfig(
            normalizeRuntimeConfig({
              model: "fixture",
              mode: "suggest",
              policy: { approvalPolicy: "on-request", sandboxMode: "read-only" },
            }),
          );
          const request: ProviderChatRequest = {
            prompt: "previous question",
            workspaceRoot: workspace,
            runtime,
            route: { providerId: "openai", modelId: "fixture", backendKind: "codex-cli-auth" },
          };
          const reference = completedNativeSession(
            request,
            "codex",
            "native-fixture",
            "previous answer",
          );
          const references: (typeof reference)[] = [];
          const notices: string[] = [];
          const result = await new Promise<string>((resolve) => {
            codexSubprocessProvider.run!(
              "new task",
              {
                runtime,
                workspaceRoot: workspace,
                conversationHistory: [
                  { role: "user", content: request.prompt },
                  { role: "assistant", content: "previous answer" },
                ],
                nativeSessions: [reference],
              },
              {
                onResponse: resolve,
                onError: (error) => resolve(`ERROR:${error}`),
                onNativeSession: (value) => references.push(value),
                onProgress: (update) => notices.push(update.text),
              },
            );
          });
          const calls = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert(calls.every((call) => call.cwd === workspace));
          assert.equal(calls.length, scenario === "missing" ? 2 : 1);
          if (scenario === "unsupported") {
            assert(!calls[0].args.includes("resume"));
            assert(calls[0].prompt.includes("previous answer"));
            assert(notices.some((text) => text.includes("reconstructing")));
          } else {
            assert.deepEqual(calls[0].args.slice(0, 2), ["exec", "resume"]);
            assert(calls[0].args.includes('sandbox_mode="read-only"'));
            assert(calls[0].args.includes('approval_policy="on-request"'));
            assert(
              !calls[0].prompt.includes("previous answer"),
              "native session already owns historical context",
            );
          }
          if (scenario === "missing") {
            assert(!calls[1].args.includes("resume"));
            assert(calls[1].prompt.includes("previous answer"));
          }
          if (
            scenario === "auth" ||
            scenario === "productive" ||
            scenario === "legacy-productive"
          ) {
            assert(result.startsWith("ERROR:"));
            assert.equal(references.length, 0);
          } else {
            assert.equal(result, "fresh answer");
            assert.equal(references[0]?.throughMessageCount, 4);
            assert.equal(references[0]?.modelId, "fixture");
          }
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("native continuity hashes dialogue independently of generated tool activity summaries", () => {
  const request = { prompt: "question", route: { modelId: "fixture" } } as ProviderChatRequest;
  const reference = completedNativeSession(request, "claude", "native", "answer");
  const history = toProviderConversationHistory(
    [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer", activitySummary: "Files changed: a.ts" },
    ],
    { includeActivitySummaries: true },
  );
  assert.equal(
    nativeContinuation(
      { ...request, nativeSessions: [reference], conversationHistory: history },
      "claude",
    )?.sessionId,
    "native",
  );
});
