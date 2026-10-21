#!/usr/bin/env python3
"""Deterministic /resume PTY regression: no real provider or user session store is used."""
import argparse, hashlib, importlib.util, json, os, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "bench"))
from ptylib import REPO, Sandbox, Session
spec = importlib.util.spec_from_file_location("terminal_check", REPO / "scripts/pty-terminal-check.py")
terminal_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal_check)

FAKE_CODEX = r"""
const fs = require('node:fs'), args = process.argv.slice(2);
if(args.includes('--version')) { console.log('codex-cli resume-fixture'); process.exit(0); }
if(args.includes('--help')) { console.log(args.includes('resume') ? '--json --config --model --image --skip-git-repo-check' : 'Commands: resume\n--config --model --image'); process.exit(0); }
if(args[0]==='resume') { console.log('NATIVE_SESSION_OWNS_INPUT'); process.stdin.once('data',()=>{console.log('NATIVE_SESSION_EXIT');process.exit(0);});return; }
if(args[0]==='login') { console.log(JSON.stringify({loggedIn:true,authMode:'chatgpt'})); process.exit(0); }
if(args[0]==='app-server') {
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id==null)return;
  const model=id=>({id,model:id,displayName:id,supportedReasoningEfforts:[],defaultReasoningEffort:'medium'});
  const result=m.method==='model/list'?{data:[model('resume-fixture'),model('gpt-5.4')],nextCursor:null}:m.method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:false}:{};
  console.log(JSON.stringify({id:m.id,result}));
 });return;
}
(async()=>{
 let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
 fs.appendFileSync(process.env.RESUME_CALLS,JSON.stringify({args,prompt,cwd:process.cwd()})+'\n');
 fs.writeFileSync(require('node:path').join(process.cwd(),'authorized-execution.txt'),'fixture execution\n');
 const events=[{type:'thread.started',thread_id:'native-resume-fixture'},
 {type:'item.completed',item:{id:'tool',type:'command_execution',command:'fixture tool (no shell execution)',status:'failed',exit_code:4,aggregated_output:'fixture failed tool'}},
 {type:'item.completed',item:{id:'answer',type:'agent_message',text:'CONTINUATION_COMPLETE'}},{type:'turn.completed'}];
 const data=events.map(JSON.stringify).join('\n')+'\n';process.stdout.write(data.slice(0,27));setTimeout(()=>process.stdout.write(data.slice(27)),15);
})();
"""

def seed(sandbox, workspace, sid, title, messages, minute=0):
    key = hashlib.sha256(str(workspace).encode()).hexdigest()[:16]
    root = sandbox.root / "data/chats" / key
    directory = root / "conversations" / sid
    directory.mkdir(parents=True, exist_ok=True)
    (root / "workspace.json").write_text(json.dumps({"version": 1, "workspaceRoot": str(workspace)}))
    metadata = {"version": 1, "id": sid, "title": title, "createdAt": "2026-10-01T00:00:00Z", "updatedAt": f"2026-10-20T10:{minute:02}:00Z", "providerId": "openai", "modelId": "resume-fixture", "backendKind": "codex-cli-auth", "messageCount": len(messages), "workspaceRoot": str(workspace)}
    path = directory / "snapshot.json"
    path.write_text(json.dumps({"version": 2, "metadata": metadata, "messages": messages}))
    return path

class Driver:
    def __init__(self, sandbox, columns=100, rows=22, argv=None):
        self.session = Session(sandbox, argv=argv, columns=columns, rows=rows)
        self.screen = terminal_check.Screen(rows, columns)
        self.offset = 0
        self.snapshots = []
        self.resizes = []
        self.columns, self.rows = columns, rows
    def update(self):
        self.screen.feed(self.session.output[self.offset:].decode("utf8", "replace"))
        self.offset = len(self.session.output)
    def text(self):
        self.update()
        return "\n".join(self.screen.history())
    def frame(self, name):
        self.update()
        self.snapshots.append({"name": name, "columns": self.columns, "rows": self.rows, "lines": self.screen.lines()})
    def command(self, text, settle=0.35):
        self.session.command(text, settle=settle); self.update()
    def keys(self, keys, settle=0.15):
        self.session.send(keys, settle); self.update()
    def resize(self, columns, rows):
        self.update(); self.screen.resize(rows, columns)
        self.columns, self.rows = columns, rows
        self.resizes.append([max(0, (time.time()*1000-self.session.started_ms)/1000), "r", f"{columns}x{rows}"])
        self.session.resize(rows, columns); self.session.pump(0.45); self.update()
    def wait(self, predicate, label, timeout=12):
        end = time.monotonic()+timeout
        while time.monotonic()<end:
            if predicate(): return
            self.session.pump(0.05); self.update()
        raise AssertionError(label+"\n"+self.text())
    def save(self, output, label):
        self.frame(label)
        (output / f"{label}.frames.json").write_text(json.dumps(self.snapshots, ensure_ascii=False, indent=2))
        header = {"version": 2, "width": self.snapshots[0]["columns"], "height": self.snapshots[0]["rows"], "timestamp": int(time.time()), "title": "Ubume deterministic resume regression"}
        recording = []
        for index, (timestamp, offset) in enumerate(self.session.chunks):
            end = self.session.chunks[index+1][1] if index+1 < len(self.session.chunks) else len(self.session.output)
            recording.append([max(0, (timestamp-self.session.started_ms)/1000), "o", self.session.output[offset:end].decode("utf8", "replace")])
        recording += self.resizes
        recording.sort(key=lambda row: row[0])
        recording.insert(0, header)
        (output / f"{label}.cast").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in recording)+"\n")
    def close(self): self.session.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--output", type=pathlib.Path, default=REPO / "docs/_reports/reliability/resume-session-validation-2026-10-21")
    output=parser.parse_args().output;output.mkdir(parents=True,exist_ok=True)
    results=[]
    def check(condition,label):
        results.append({"passed":bool(condition),"label":label});print(("PASS " if condition else "FAIL ")+label,flush=True)
        if not condition: raise AssertionError(label)
    sandbox=Sandbox(fakes={"codex":FAKE_CODEX})
    sandbox.env["RESUME_CALLS"]=str(sandbox.root/"continuations.jsonl")
    workspace=sandbox.root/"project"
    drivers=[]
    try:
        d=Driver(sandbox);drivers.append(d);d.session.wait_ready()
        d.command("/resume");check("No saved sessions" in d.text(),"first command on empty startup has an empty state")
        d.keys(b'\x1b');check(d.screen.normal_buffer is None and 'This folder' not in d.text(),"cancel restores normal buffer and composer")
        d.save(output,"empty-startup");d.close();drivers.remove(d)
        for i in range(30): seed(sandbox,workspace,f"chat_fixture-{i:03}",f"TITLE_{i:03}",[{"role":"user","content":f"PROMPT_{i:03}"},{"role":"assistant","content":f"ANSWER_{i:03}\n\n```ts\nconst restored = true;\n```"}],i)
        for cols,rows in [(60,20),(80,24),(100,22),(120,30),(160,40),(200,50)]:
            d=Driver(sandbox,cols,rows);drivers.append(d);d.session.wait_ready();d.command("/resume")
            check('Resume' in d.text(),f'{cols}x{rows}: selector visible');d.frame('selector')
            d.keys(b'\x1b[F');d.wait(lambda:'> TITLE_000' in d.text(),'End selection applied')
            check('> TITLE_000' in d.text(),f'{cols}x{rows}: End keeps selected row visible')
            d.keys(b'/TITLE_005');d.wait(lambda:'Search: TITLE_005' in d.text(),'search focus ready');d.keys(b'\r');d.keys(b'\r',0.4)
            d.wait(lambda:'ANSWER_005' in d.text(),'selected history restored')
            check('ANSWER_005' in d.text() and 'const restored' in d.text(),f'{cols}x{rows}: Enter restores answer and code')
            check('ANSWER_004' not in d.text(),f'{cols}x{rows}: unrelated history absent')
            d.frame('restored')
            for _ in range(3): d.command('/resume');d.keys(b'\x1b')
            check(d.screen.normal_buffer is None and 'This folder' not in d.text(),f'{cols}x{rows}: repeated cancellation leaves no selector')
            d.save(output,f'matrix-{cols}x{rows}');d.close();drivers.remove(d)
        calls=sandbox.root/'continuations.jsonl'
        check(not calls.exists(),'opening, navigating and restoring historical data executes no provider turns')
        native_dir=sandbox.root/'codex/sessions/2026/10/21';native_dir.mkdir(parents=True)
        native_path=native_dir/'rollout-native-history.jsonl'
        native_path.write_text('\n'.join(json.dumps(row) for row in [
            {'type':'session_meta','payload':{'id':'native-external-fixture','cwd':str(workspace)}},
            {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'NATIVE_HISTORY_PICKER'}]}},
            {'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'NATIVE_HISTORY_ANSWER'}]}}
        ])+'\n')
        native_original=native_path.read_bytes()
        d=Driver(sandbox,120,30);drivers.append(d);d.session.wait_ready();d.command('/resume');d.keys(b'/NATIVE_HISTORY_PICKER');d.keys(b'\r');d.keys(b'o',0.4)
        d.wait(lambda:'NATIVE_SESSION_OWNS_INPUT' in d.text(),'native CLI owns terminal')
        d.keys(b'done\n',0.4);d.wait(lambda:'NATIVE_SESSION_EXIT' in d.text(),'native CLI accepts input and exits')
        d.session.wait_ready();check(d.screen.normal_buffer is None,'native CLI handoff returns input to the source composer')
        check(native_path.read_bytes()==native_original,'native session browsing and handoff leave native storage unchanged')
        d.save(output,'native-cli-handoff');d.close();drivers.remove(d)
        long_messages=[]
        for i in range(240):long_messages.extend([{'role':'user','content':f'LONG_PROMPT_{i:03}'},{'role':'assistant','content':f'LONG_ANSWER_{i:03}'}])
        seed(sandbox,workspace,'chat_long','LONG_HISTORY',long_messages)
        d=Driver(sandbox);drivers.append(d);d.session.wait_ready();d.command('/resume chat_long',settle=0.7)
        d.wait(lambda:'LONG_ANSWER_239' in d.text(),'long restoration finished',20)
        text=d.text();check(all(f'LONG_ANSWER_{i:03}' in text for i in range(240)),'all 240 restored answers exist in screen and scrollback')
        check(text.count('LONG_ANSWER_000')==1,'oldest restored answer is not duplicated')
        d.session.wait_ready();d.command('/resume');d.wait(lambda:d.screen.normal_buffer is not None,'long-history selector opened');d.keys(b'\x1b[F');d.frame('before-resize')
        for cols,rows in [(60,20),(200,50),(80,24),(7,2),(100,22)]:
            d.resize(cols,rows)
            if cols>=8 and rows>=3:
                d.wait(lambda:'Resume' in d.text(),f'resize {cols}x{rows} settled')
                check('Resume' in d.text(),f'resize {cols}x{rows}: selector remains active')
            else:
                d.wait(lambda:'Resiz' in d.text(),'minimum-size hint settled')
                check('Resiz' in d.text(),'below-minimum viewport shows a resize hint')
            d.frame(f'resize-{cols}x{rows}')
        d.keys(b'\x1b');d.wait(lambda:'LONG_ANSWER_000' in d.text(),'history after resize')
        check(all(f'LONG_ANSWER_{i:03}' in d.text() for i in range(240)),'resizing repaints the complete restored transcript')
        d.save(output,'long-history-resize');d.close();drivers.remove(d)
        # Real continuation and native session reuse after a fresh process restart.
        d=Driver(sandbox,120,30);drivers.append(d);d.session.wait_ready();d.command('/resume chat_fixture-005')
        d.command('FIRST_CONTINUE',settle=0.6);d.wait(lambda:calls.exists(),'first provider invocation')
        d.wait(lambda:'CONTINUATION_COMPLETE' in d.text(),'first continuation rendered');d.session.pump(0.4)
        d.save(output,'context-continuation');d.close();drivers.remove(d)
        d=Driver(sandbox,120,30,argv=['node',str(REPO/'bin/ubume.js'),'--resume','chat_fixture-005']);drivers.append(d)
        d.wait(lambda:'CONTINUATION_COMPLETE' in d.text(),'startup resume hydrated');d.session.wait_ready()
        d.command('SECOND_CONTINUE',settle=0.6);d.wait(lambda:len(calls.read_text().splitlines())==2,'second continuation invoked')
        invocation=[json.loads(line) for line in calls.read_text().splitlines()]
        check(invocation[1]['args'][:2]==['exec','resume'],'restart continues the exact native Codex session')
        check('native-resume-fixture' in invocation[1]['args'],'native continuation uses the persisted session ID')
        check('Previous conversation:' not in invocation[1]['prompt'],'native continuation does not resend historical turns')
        d.save(output,'native-continuation');d.close();drivers.remove(d)
        # The current process itself started with --resume: relaunch must remove it.
        other=sandbox.root/'other project'/'project';other.mkdir(parents=True)
        seed(sandbox,other,'chat_other','OTHER_PROJECT',[{'role':'user','content':'OTHER_PROMPT'},{'role':'assistant','content':'OTHER_ANSWER'}])
        d=Driver(sandbox,120,30,argv=['node',str(REPO/'bin/ubume.js'),'--resume','chat_fixture-005']);drivers.append(d)
        d.session.wait_ready();d.command('/resume');d.keys(b'a');d.keys(b'/OTHER_PROJECT');d.keys(b'\r');d.keys(b'\r',0.8)
        d.wait(lambda:'OTHER_ANSWER' in d.text(),'workspace handoff restores target history')
        d.session.wait_ready();d.command('!pwd',settle=0.4);d.wait(lambda:str(other) in d.text(),'shell uses target directory')
        d.command('OTHER_CONTINUE',settle=0.6);d.wait(lambda:len(calls.read_text().splitlines())==3,'other workspace execution')
        invocation=[json.loads(line) for line in calls.read_text().splitlines()]
        check(invocation[-1]['cwd']==str(other),'provider execution uses the selected workspace, including spaces')
        check((other/'authorized-execution.txt').exists(),'fixture write lands in the authorized target project')
        check(not any('Choose only one' in line for line in d.screen.history()),'workspace relaunch carries only one startup resume target')
        d.save(output,'workspace-handoff')
        missing=sandbox.root/'missing original folder'
        missing_path=seed(sandbox,missing,'chat_missing','MISSING_PROJECT',[{'role':'user','content':'MISSING_PROMPT'},{'role':'assistant','content':'MISSING_ANSWER'}])
        original_bytes=missing_path.read_bytes()
        destination=sandbox.root/'relocated project';destination.mkdir()
        d.command('/resume');d.keys(b'a');d.keys(b'/MISSING_PROJECT');d.keys(b'\r');d.keys(b'\r',0.4)
        d.wait(lambda:'MISSING_ANSWER' in d.text(),'missing workspace history is viewable')
        d.keys(b'c');d.wait(lambda:'Locate Workspace' in d.text(),'relocation path entry')
        d.keys(str(destination).encode());d.keys(b'\r');d.wait(lambda:'Type RELOCATE to confirm' in d.text(),'relocation confirmation')
        target_key=hashlib.sha256(str(destination).encode()).hexdigest()[:16]
        target_store=sandbox.root/'data/chats'/target_key/'conversations'
        check(not target_store.exists(),'selecting a relocation destination alone writes no conversation')
        d.keys(b'RELOCATE');d.keys(b'\r',0.7);d.wait(lambda:'MISSING_ANSWER' in d.text() and 'Conversation resumed' in d.text(),'confirmed relocation opens copied history')
        check(missing_path.read_bytes()==original_bytes,'confirmed relocation preserves original snapshot byte-for-byte')
        snapshots=list(target_store.glob('*/snapshot.json'))
        check(len(snapshots)==1,'confirmed relocation creates one destination conversation')
        copied=json.loads(snapshots[0].read_text())
        check(copied['metadata']['relocatedFrom']['conversationId']=='chat_missing' and copied['metadata']['id']!='chat_missing','relocation records provenance with a new canonical ID')
        d.save(output,'confirmed-relocation')
        sandbox.assert_spawned_only(sandbox.fakes.values())
    except Exception as error:
        results.append({'passed':False,'label':str(error)});print('FAIL '+str(error),flush=True)
        for index,d in enumerate(drivers):d.save(output,f'failure-{index}')
    finally:
        for d in drivers:d.close()
        sandbox.dispose()
        (output/'results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False)+'\n')
    print(f'{sum(r["passed"] for r in results)} passed, {sum(not r["passed"] for r in results)} failed',flush=True)
    return 1 if any(not r['passed'] for r in results) else 0

if __name__=='__main__':sys.exit(main())
