// Sandboxed by ptylib; never resolves or calls a model. Sequential manifests prove delivery.
const fs = require('node:fs');
const { once } = require('node:events');
const scenario = process.env.RESIZE_SCENARIO || 'stream';
const count = Number(process.env.RESIZE_EVENTS || 400);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const native = process.env.RESIZE_NATIVE_PROVIDER;
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('Usage: --print --output-format --model --conversation');process.exit(0);}
if(args.includes('--version')){console.log('fixture 1.0.0');process.exit(0);}
let accumulated='';
let seq = 0;
async function emit(event) {
 event.seq = ++seq;
 fs.appendFileSync(process.env.RESIZE_MANIFEST, JSON.stringify(event) + '\n');
 let wire = event;
 if(native && event.kind==='text') {
  accumulated+=event.text;
  if(native==='anthropic')wire={type:'assistant',message:{id:'text-'+seq,content:[{type:'text',text:event.text}]}};
  else if(native==='google')wire={event:'step_update',step_update:{step_index:seq,state:'DONE',step_type:'agent_response',text_delta:event.text}};
  else wire={type:'message',id:'text-'+seq,generation_status:'completed',role:'assistant',content:[{type:'text',text:event.text}]};
 }
 if(native && event.kind==='tool') {
  const t=event.tool, done=t.status==='completed';
  if(native==='anthropic')wire=done?{type:'user',message:{content:[{type:'tool_result',tool_use_id:t.id,content:t.summary}]}}:{type:'assistant',message:{content:[{type:'tool_use',id:t.id,name:'Bash',input:{command:t.command}}]}};
  else if(native==='google')wire={event:'step_update',step_update:{step_index:Number(t.id.slice(5)),state:done?'DONE':'ACTIVE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:t.command},output:t.summary}}};
  else { if(!done)return;wire={type:'effect',id:t.id,generation_status:'completed',title:t.command,state:{status:'completed',output_text:t.summary,duration_ms:10}}; }
 }
 if (!process.stdout.write(JSON.stringify(wire) + '\n')) await once(process.stdout, 'drain');
}
(async () => {
 if(scenario==='code')await emit({kind:'text',text:'```typescript\n'});
 for (let i = 0; i < count; i++) {
  if (scenario === 'approval' && i === 8) {
   await emit({kind:'approval'});
   await new Promise(resolve => process.stdin.once('data', resolve));
   process.stdin.destroy();
  }
  if ((scenario === 'tools' || scenario === 'large' || scenario === 'approval') && i % 8 === 0) {
   const id = 'tool-' + i, command = `fixture action TOOL_${i}`;
   await emit({kind:'tool',tool:{id,command,status:'running',startedAt:Date.now()}});
   await delay(10);
   fs.writeFileSync(`fixture-file-${i}.txt`, `file event ${i}\n`);
   await emit({kind:'tool',tool:{id,command,status:'completed',startedAt:Date.now()-10,completedAt:Date.now(),summary: `RESULT_${i}`, ...(scenario === 'large' ? {output: `LARGE_${i} 雪 output `.repeat(4000)} : {})}});
  }
  if(scenario==='code')await emit({kind:'text',text:`const value${i} = 'LINE_${String(i).padStart(4,'0')} 雪 👩🏽‍💻';\n`});
  else await emit({kind:'text',text:`LINE_${String(i).padStart(4,'0')} ${i%9===0?'Unicode 雪 👩🏽‍💻 **bold** and `code`':'streaming resize response'}\n\n`});
  await delay(Number(process.env.RESIZE_EVENT_MS || 8));
 }
 if(scenario==='code')await emit({kind:'text',text:'```\n'});
 await emit({kind:'text',text:'RESIZE_FINAL_COMPLETE\n'});
 if(native==='anthropic')console.log(JSON.stringify({type:'result',subtype:'success',result:accumulated,session_id:'resize-claude'}));
 if(native==='google')console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:accumulated,conversation_id:'resize-google'}}));
})().catch(error => { console.error(error); process.exitCode=1; });
