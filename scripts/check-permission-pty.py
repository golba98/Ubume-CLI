#!/usr/bin/env python3
"""Native Claude/Vibe permission round trips through the real Ink App in a VT-emulated PTY."""
import codecs, importlib.util, json, pathlib, re, statistics, sys, time
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'bench'))
from ptylib import REPO, Sandbox, Session
spec=importlib.util.spec_from_file_location('terminal',REPO/'scripts/pty-terminal-check.py')
terminal=importlib.util.module_from_spec(spec);spec.loader.exec_module(terminal)

SIZES=[(60,16),(80,24),(100,22),(120,30),(160,40),(100,22)]

def run(provider,scenario='decide',no_color=False):
 body=(REPO/'scripts/bench/fixtures/permission-provider.cjs').read_text()
 sandbox=Sandbox(fakes={'claude':body,'vibe':body,'vibe-acp':body})
 sandbox.env.update({'PERMISSION_PROVIDER':provider,'PERMISSION_EXECUTABLE':sandbox.fakes['vibe' if provider=='vibe' else 'claude'],'PERMISSION_LOG':str(sandbox.root/'responses.jsonl'),'PERMISSION_MARKER':str(sandbox.root/'approved'),'PERMISSION_SCENARIO':scenario})
 if no_color:sandbox.env['NO_COLOR']='1'
 frames=[];resize_events=[]
 session=Session(sandbox,['bun',str(REPO/'scripts/bench/fixtures/permissionApp.tsx')],rows=22,columns=100)
 latencies=[]
 screen=terminal.Screen(22,100);decoder=codecs.getincrementaldecoder('utf8')('replace');offset=0
 def pump():
  nonlocal offset
  session.pump(.003);chunk=session.output[offset:];offset=len(session.output)
  if chunk:screen.feed(decoder.decode(chunk))
 def text():return '\n'.join(screen.lines())
 def wait(check,label,timeout=20):
  end=time.perf_counter()+timeout
  while time.perf_counter()<end:
   pump()
   if check():return
  raise AssertionError(label+'\n'+text())
 def responses():
  path=sandbox.root/'responses.jsonl'
  return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
 try:
  session.wait_ready();pump();session.command('permission test',settle=0)
  wait(lambda:any('--output-format' in row.get('argv',[]) or '--transport' in row.get('argv',[]) or row['provider']=='vibe-acp' for row in sandbox.spawned()),'provider starts')
  session.send(b'DRAFT_TO_KEEP',0)
  wait(lambda:'PERMISSION_EVIDENCE' in text() and 'Awaiting permission' in text() and 'Esc deny' in text(),'complete permission frame is visible')
  assert 'Awaiting permission' in text() and 'Enter queue' not in text() and 'is working' not in text(),text()
  assert 'DRAFT_TO_KEEP' in text(),text()
  if scenario=='disconnect':
   wait(lambda:'PERMISSION' not in text(),'disconnect withdraws dialog');assert not (sandbox.root/'approved').exists();assert not responses()
  elif scenario=='cancel':
   session.send(b'\x03',0);wait(lambda:'PERMISSION_EVIDENCE' not in text(),'Ctrl+C closes dialog');assert not (sandbox.root/'approved').exists();assert not any(r['allowed'] for r in responses())
  else:
   session.send(b'j',0);wait(lambda:'> 2.' in text(),'second action selected')
   for cols,rows in SIZES:
    screen.resize(rows,cols);start=time.perf_counter();resize_events.append([start-session.start,'r',f'{cols}x{rows}']);session.resize(rows,cols)
    content=cols-1-min(12,round(max(0,cols-100)*.08));edge_end=content+(int((cols-content+1)//2) if cols-1>content else 0)
    def border_ready():return any(re.search(r'[╰└].*[╯┘]',line) and len(line.rstrip())==edge_end for line in screen.lines())
    wait(lambda:border_ready() and '> 2.' in text() and '1. Allow once' in text() and 'Esc deny' in text(),'resize preserves choices '+str((cols,rows)))
    latencies.append((time.perf_counter()-start)*1000)
    frames.append({'size':f'{cols}x{rows}','lines':screen.lines()})
    assert not responses(),'resize submitted permission'
    assert 'DRAFT_TO_KEEP' in text(),'draft lost'
    if provider=='claude':assert '3. Deny' in text(),text()
    else:assert '3.' not in text() and 'Persistent (forbidden)' not in text(),text()
   session.send(b'\x1b[F',0);wait(lambda:'FINAL_ARGUMENT' in text(),'final command argument accessible')
   session.send(b'\x1b',0);wait(lambda:len(responses())==1,'denial dispatched')
   assert not responses()[0]['allowed'] and not (sandbox.root/'approved').exists()
   wait(lambda:'> 1. Allow once' in text(),'next request resets selection')
   session.send(b'\r\r',0);wait(lambda:'PERMISSION_TEST_COMPLETE' in text() and 'DRAFT_TO_KEEP' in text(),'approved request completes with retained draft')
   assert [r['allowed'] for r in responses()]==[False,True],responses()
   assert (sandbox.root/'approved').exists()
   assert sum((row['provider']=='claude' and '--input-format' in row['argv']) or row['provider']=='vibe-acp' for row in sandbox.spawned())==1,('approval keys submitted draft',sandbox.spawned(),text())
   assert 'DRAFT_TO_KEEP' in text(),'approval keys altered composer'
  assert b'\x1b[3J' not in session.output,'permission handling erased scrollback'
  sandbox.assert_spawned_only(sandbox.fakes.values())
  if latencies:print(f'{provider} resize median={statistics.median(latencies):.1f}ms max={max(latencies):.1f}ms',flush=True)
  print(f'PASS {provider} {scenario}: native protocol, input ownership and bounded PTY rendering',flush=True)
 finally:
  session.close()
  output=REPO/'docs/_reports/reliability'/('permission-dialog-'+time.strftime('%Y-%m-%d'));output.mkdir(parents=True,exist_ok=True)
  name=provider+'-'+scenario+('-no-color' if no_color else '')
  recording=[{'version':2,'width':100,'height':22,'timestamp':int(time.time()),'title':'Ubume permission '+name}]
  events=list(resize_events)
  for index,(at,begin) in enumerate(session.monotonic_chunks):
   end=session.monotonic_chunks[index+1][1] if index+1<len(session.monotonic_chunks) else len(session.output)
   events.append([at/1e9-session.start,'o',session.output[begin:end].decode('utf8','replace')])
  recording.extend(sorted(events,key=lambda event:event[0]))
  (output/(name+'.cast')).write_text('\n'.join(json.dumps(record,ensure_ascii=False) for record in recording)+'\n')
  (output/(name+'-frames.md')).write_text('\n\n'.join('### '+frame['size']+'\n\n```text\n'+'\n'.join(frame['lines'])+'\n```' for frame in frames))
  sandbox.dispose()

if __name__=='__main__':
 for provider in ('claude','vibe'):
  for scenario in ('decide','cancel','disconnect'):run(provider,scenario)

 run('claude','decide',True)
