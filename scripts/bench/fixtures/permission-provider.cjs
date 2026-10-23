// Test-only native protocol peer. Never executes the displayed shell command.
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
if(process.argv.includes('--help')){console.log('Usage: --agent --enabled-tools --output --permission-prompt-tool --input-format --permission-mode --model --output-format --print');process.exit(0);}
if(process.argv.includes('--version')){console.log('fixture 3.0.0');process.exit(0);}
if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
if(['model','models'].includes(process.argv[2])){console.log(JSON.stringify({models:[]}));process.exit(0);}
const vibe=process.env.PERMISSION_PROVIDER==='vibe';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const log=value=>fs.appendFileSync(process.env.PERMISSION_LOG,JSON.stringify(value)+'\n');
const command='printf "%s\\n" "'+ '/long path/雪/é/'.repeat(14) +'" | cat && printf FINAL_ARGUMENT';
let step=0;let promptId;
const ask=()=>{
 step++;
 if(vibe)send({jsonrpc:'2.0',id:'permission-'+step,method:'session/request_permission',params:{sessionId:'permission-session',toolCall:{toolCallId:'tool-'+step,title:'PERMISSION_EVIDENCE',kind:'execute',rawInput:{command}},options:[
 {optionId:'persistent',kind:'allow_always',name:'Persistent (forbidden)'},
 {optionId:'native-allow',kind:'allow_once',name:'Allow once'},
 {optionId:'native-reject',kind:'reject_once',name:'Deny'}]}});
 else send({type:'control_request',request_id:'permission-'+step,request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'tool-'+step,input:{command,description:'PERMISSION_EVIDENCE'}}});
 if(process.env.PERMISSION_SCENARIO==='disconnect')setTimeout(()=>process.exit(3),600);
};
const finish=()=>{
 if(vibe){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'permission-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PERMISSION_TEST_COMPLETE'}}}});send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});}
 else {send({type:'assistant',message:{id:'final',content:[{type:'text',text:'PERMISSION_TEST_COMPLETE'}]}});send({type:'result',subtype:'success',result:'PERMISSION_TEST_COMPLETE',session_id:'permission-session'});}
};
rl.on('line',line=>{
 if(!line.trim())return;
 const m=JSON.parse(line);
 if(vibe&&m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false}}});
 if(vibe&&m.method==='session/new')return send({jsonrpc:'2.0',id:m.id,result:{sessionId:'permission-session',modes:{currentModeId:'ask',availableModes:[{id:'accept-edits'},{id:'smart-approve'}]}}});
 if(vibe&&m.method==='session/set_mode')return send({jsonrpc:'2.0',id:m.id,result:{}});
 if((vibe&&m.method==='session/prompt')||(!vibe&&m.type==='user')){
  promptId=m.id;
  if(!vibe)send({type:'system',subtype:'init',session_id:'permission-session'});
  setTimeout(ask,300);return;
 }
 if((vibe&&m.id&&m.result)||(!vibe&&m.type==='control_response')){
  const allowed=vibe?m.result.outcome.optionId==='native-allow':m.response.response.behavior==='allow';
  log({step,allowed,response:m});
  if(allowed)fs.writeFileSync(process.env.PERMISSION_MARKER,'explicit approval');
  if(step===1&&process.env.PERMISSION_SCENARIO!=='cancel'&&process.env.PERMISSION_SCENARIO!=='disconnect')setTimeout(ask,80);
  else finish();
 }
});
process.stdin.on('end',()=>process.exit(0));
