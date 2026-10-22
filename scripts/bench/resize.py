#!/usr/bin/env python3
"""Offline real-PTY resize correctness/latency benchmark. No fixed post-resize sleeps."""
import argparse, codecs, hashlib, importlib.util, json, os, pathlib, re, select, statistics, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ptylib import REPO, Sandbox, Session, summarize
spec = importlib.util.spec_from_file_location('terminal', REPO/'scripts/pty-terminal-check.py')
terminal = importlib.util.module_from_spec(spec);spec.loader.exec_module(terminal)
SIZES=[(100,22),(120,30),(160,40),(200,50),(120,30),(80,24),(60,20),(100,22)]

def seed(sandbox, turns):
 root=sandbox.root/'data/chats'/hashlib.sha256(str(sandbox.root/'project').encode()).hexdigest()[:16]
 directory=root/'conversations/chat_resize';directory.mkdir(parents=True)
 (root/'workspace.json').write_text(json.dumps({'version':1,'workspaceRoot':str(sandbox.root/'project')}))
 messages=[]
 for i in range(turns):messages.extend([{'role':'user','content':f'HISTORY_PROMPT_{i:04}'},{'role':'assistant','content':f'HISTORY_ANSWER_{i:04}\n\n'+ ('Unchanged history **bold** `code` 雪.\n'*20)}])
 (directory/'snapshot.json').write_text(json.dumps({'version':2,'metadata':{'version':1,'id':'chat_resize','title':'RESIZE_HISTORY','workspaceRoot':str(sandbox.root/'project'),'createdAt':'2026-10-21T00:00:00Z','updatedAt':'2026-10-21T00:00:00Z','providerId':'openai','modelId':'gpt-5.4','backendKind':'codex-cli-auth','messageCount':len(messages)},'messages':messages}))

class Driver:
 def __init__(self,sandbox,repo):
  self.session=Session(sandbox,['bun',str(repo/'scripts/bench/fixtures/resizeApp.tsx')],rows=22,columns=100)
  self.dimensions=(100,22);self.screen=terminal.Screen(22,100);self.offset=0;self.decoder=codecs.getincrementaldecoder('utf8')('replace');self.frames=[];self.parse_ms=0
 def pump(self,seconds=.002):
  self.session.pump(seconds)
  chunk=self.session.output[self.offset:];self.offset=len(self.session.output)
  if chunk:
   start=time.perf_counter_ns();self.screen.feed(self.decoder.decode(chunk));self.parse_ms+=(time.perf_counter_ns()-start)/1e6
  return chunk
 def text(self):return '\n'.join(self.screen.lines())
 def wait(self,check,label,timeout=20):
  end=time.perf_counter()+timeout
  while time.perf_counter()<end:
   self.pump()
   if check():return
  raise AssertionError(label+'\n'+self.text())
 def command(self,value):
  self.session.command(value,settle=0);self.wait(lambda: bool(self.session.output), 'command')
 def resize(self,cols,rows,overlay=False):
  self.pump();unchanged=self.dimensions==(cols,rows);self.dimensions=(cols,rows);self.screen.resize(rows,cols)
  start=time.perf_counter_ns();self.session.resize(rows,cols)
  first=None; observed=len(self.session.output)
  def ready():
   nonlocal first, observed
   if len(self.session.output)==observed and not unchanged:return False
   observed=len(self.session.output)
   if first is None:first=(self.session.monotonic_chunks[-1][0]-start)/1e6
   if cols<8 or rows<3:return 'Resiz' in self.text()
   # A complete newly drawn composer/overlay edge; cropped old edges lack a corner.
   edges=[line for line in self.screen.lines() if re.search(r'[╭╰┌└].*[╮╯┐┘]',line)]
   if overlay:
    shell=cols-1;content=shell-min(12,round(max(0,shell-99)*.08))
    edge_end=content+(int((cols-content+1)//2) if shell>content else 0)
    return any(len(line.rstrip())==edge_end for line in edges)
   expected=cols
   return any(len(line.rstrip())==expected for line in edges)
  self.wait(ready,f'resize {cols}x{rows} committed',30)
  elapsed=(time.perf_counter_ns()-start)/1e6
  self.frames.append({'at':start/1e9-self.session.start,'cols':cols,'rows':rows,'latencyMs':elapsed,'firstOutputMs':first,'lines':self.screen.lines()})
  return elapsed

def run(repo,scenario,iterations,cycles,output,history_turns,functional=False):
 values=[];input_ms=[];during_input_ms=[];runs=[]
 for iteration in range(iterations):
  sandbox=Sandbox(fakes={'resize-fixture':(REPO/'scripts/bench/resize-producer.cjs').read_text()})
  trace=sandbox.root/'resize.jsonl';manifest=sandbox.root/'manifest.jsonl'
  sandbox.env.update({'RESIZE_EXECUTABLE':sandbox.fakes['resize-fixture'],'RESIZE_SCENARIO':scenario,'RESIZE_MANIFEST':str(manifest),'RESIZE_DECISIONS':str(sandbox.root/'decisions'),'RESIZE_EVENTS':str(max(160,cycles*80)),'UBUME_RESIZE_TRACE':str(trace)})
  d=Driver(sandbox,repo)
  try:
   d.session.wait_ready();d.pump()
   if scenario in ('history','history-stream','resume'):
    seed(sandbox,history_turns)
    d.command('/resume chat_resize');d.wait(lambda:f'HISTORY_ANSWER_{history_turns-1:04}'.encode() in d.session.output,'history restored',60)
    d.session.wait_ready();d.pump()
   if scenario in ('stream','tools','large','approval','history-stream','preferences-stream','resume-stream'):
    d.command('go');d.wait(lambda:manifest.exists(),'provider started')
    if scenario=='approval':d.wait(lambda:'RESIZE_APPROVAL' in d.text() or 'fixture safe operation' in d.text(),'approval visible')
   overlay=scenario in ('resume','preferences','preferences-stream','resume-stream')
   if overlay:
    d.command('/resume' if scenario in ('resume','resume-stream') else '/preferences');d.wait(lambda:d.screen.normal_buffer is not None,'overlay opened')
   if scenario=='suggestions':d.session.send(b'/pre',0);d.wait(lambda:'preferences' in d.text().lower(),'suggestions visible')
   if not overlay and scenario not in ('approval','suggestions'):d.session.send(b'RESIZE_DRAFT',0)
   resize_start_ns=time.monotonic_ns()
   for cycle in range(cycles):
    for cols,rows in SIZES[1:]:
     latency=d.resize(cols,rows,overlay or scenario=='approval');values.append(latency)
     if functional and cycle==0 and cols==200 and not overlay and scenario not in ('approval','suggestions'):
      mark=len(d.session.output);start=time.perf_counter_ns();d.session.send(b'LIVE_INPUT',0)
      d.wait(lambda:b'LIVE_INPUT' in d.session.output[mark:],'input echo during resize and execution')
      during_input_ms.append((time.perf_counter_ns()-start)/1e6)
   replay_mark=len(d.session.output)
   # True burst: obsolete dimensions must not reappear after the final size.
   for cols,rows in SIZES:d.session.resize(rows,cols)
   d.resize(100,22,overlay or scenario=='approval')
   if overlay:d.session.send(b'\x1b',0);d.wait(lambda:d.screen.normal_buffer is None,'overlay canceled')
   if scenario=='approval':d.session.send(b'\r',0)
   if scenario in ('stream','tools','large','approval','history-stream','preferences-stream','resume-stream'):
    d.wait(lambda:'RESIZE_FINAL_COMPLETE' in d.text(),'provider completes',60)
    expected=[json.loads(line) for line in manifest.read_text().splitlines()]
    snapshots=list((sandbox.root/'data').rglob('snapshot.json'))
    def saved():
     for path in (sandbox.root/'data').rglob('snapshot.json'):
      try:
       snapshot=json.loads(path.read_text())
       if any('RESIZE_FINAL_COMPLETE' in message['content'] for message in snapshot.get('messages',[])):return snapshot
      except (ValueError,KeyError):pass
     return None
    d.wait(lambda:saved() is not None,'final output persisted')
    snapshot=saved();answer=[message['content'] for message in snapshot['messages'] if message['role']=='assistant'][-1]
    emitted=''.join(event['text'] for event in expected if event['kind']=='text')
    assert answer==emitted,'canonical text differs from complete executable output'
    if scenario=='history-stream':assert sum(1 for message in snapshot['messages'] if message['role']=='assistant' and message['content'].startswith('HISTORY_ANSWER_'))==history_turns,'streaming resize corrupted historical messages'
    received=[]
    d.wait(lambda:trace.exists(),'trace available');d.pump(.15)
    records=[json.loads(line) for line in trace.read_text().splitlines()]
    received=[record['seq'] for record in records if record['stage']=='providerEvent']
    if received:assert received==[event['seq'] for event in expected],'provider event loss/duplication'
    run_events=snapshot.get('session',{}).get('events',[])
    completed=[e for e in run_events if e.get('type')=='run'][-1]
    assert completed['status']=='completed','run interrupted'
    assert len(list((sandbox.root/'project').glob('fixture-file-*.txt')))==len([event for event in expected if event['kind']=='tool' and event['tool']['status']=='completed']), 'file events did not complete'
    expected_tools=[e['tool']['id'] for e in expected if e['kind']=='tool' and e['tool']['status']=='completed']
    assert [e['id'] for e in completed.get('toolActivities',[]) if e['status']=='completed']==expected_tools,'tool events differ'
    if scenario=='approval':assert (sandbox.root/'decisions').read_text().splitlines()==['allow-once'],'approval was lost/duplicated'
   if not overlay:
    mark=len(d.session.output);start=time.perf_counter_ns();d.session.send(b'INPUT_PROBE',0)
    d.wait(lambda:b'INPUT_PROBE' in d.session.output[mark:],'input remains responsive');input_ms.append((time.perf_counter_ns()-start)/1e6)
   if not overlay and scenario not in ('approval','suggestions'):assert 'RESIZE_DRAFT' in d.text(),'resize lost the editable draft'
   # Below minimum returns to a usable 100x22 composer without losing the run.
   if repo == REPO and scenario in ('idle','history'):
    d.resize(7,2);replay_mark=len(d.session.output);d.resize(100,22)
   if scenario=='history':
    if repo != REPO:
     d.resize(80,24);replay_mark=len(d.session.output);d.resize(100,22)
    def historical_replay():
     data=d.session.output[replay_mark:];clear=data.rfind(b'\x1b[3J')
     return data[clear:] if clear>=0 else b''
    d.wait(lambda: b'HISTORY_ANSWER_0000' in historical_replay() and f'HISTORY_ANSWER_{history_turns-1:04}'.encode() in historical_replay(), 'complete historical reflow published',60)
    replay=historical_replay()
    assert all(replay.count(f'HISTORY_ANSWER_{i:04}'.encode())==1 for i in range(history_turns)), 'historical reflow lost/duplicated a turn'
   recording=[{"version":2,"width":100,"height":22,"timestamp":int(time.time()),"title":f"Ubume resize {scenario}"}]
   for index,(at,offset) in enumerate(d.session.monotonic_chunks):
    end=d.session.monotonic_chunks[index+1][1] if index+1<len(d.session.monotonic_chunks) else len(d.session.output)
    recording.append([(at/1e9-d.session.start),"o",d.session.output[offset:end].decode("utf8","replace")])
   for frame in d.frames:recording.append([frame['at'],"r",f"{frame['cols']}x{frame['rows']}"])
   recording=[recording[0]]+sorted(recording[1:],key=lambda record:record[0])
   output.mkdir(parents=True,exist_ok=True)
   (output/f'{scenario}-{iteration+1}.cast').write_text("\n".join(json.dumps(record,ensure_ascii=False) for record in recording)+"\n")
   d.session.close();d.session=None
   records=[json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
   runs.append({'iteration':iteration,'resizeStartNs':str(resize_start_ns),'frames':d.frames,'trace':records,'vtParsingMs':d.parse_ms})
   sandbox.assert_spawned_only(sandbox.fakes.values())
   print(f'PASS {scenario} run {iteration+1}: {len(d.frames)} resize frames',flush=True)
  finally:
   if d.session:d.session.close()
   sandbox.dispose()
 delays=[record['delayMs'] for run in runs for record in run['trace'] if record['stage']=='sample' and record['generation']>0]
 rss=[record['rss'] for run in runs for record in run['trace'] if record['stage']=='sample' and record['generation']>0]
 from collections import defaultdict,deque
 app=[];flush=[];layout=[];cpu=[]
 for run in runs:
  notifications={record['generation']:record for record in run['trace'] if record['stage']=='notification'}
  written=set();writes=defaultdict(deque)
  for record in run['trace']:
   generation=record['generation'];n=notifications.get(generation)
   if record['stage']=='yogaLayout' and generation>0:layout.append(record['durationMs'])
   if record['stage']=='write' and record.get('visible') and n and generation not in written:
    app.append((int(record['monoNs'])-int(n['monoNs']))/1e6);written.add(generation)
   if record['stage']=='write':writes[generation].append(int(record['monoNs']))
   if record['stage']=='writeComplete' and writes[generation]:flush.append(max(0,(int(record['monoNs'])-writes[generation].popleft())/1e6))
  samples=[record for record in run['trace'] if record['stage']=='sample' and record['generation']>0]
  if samples:cpu.append(sum(samples[-1]['cpu'].values())/1000-sum(samples[0]['cpu'].values())/1000)
 result={'appResizeMs':summarize(app) if app else None,'writeFlushMs':summarize(flush) if flush else None,'layoutMs':summarize(layout) if layout else None,'cpuMs':summarize(cpu) if cpu else None,'scenario':scenario,'repo':str(repo),'resizeMs':summarize(values),'inputMs':summarize(input_ms) if input_ms else None,'duringResizeInputMs':summarize(during_input_ms) if during_input_ms else None,'eventLoopDelayMs':summarize(delays) if delays else None,'peakRssBytes':max(rss) if rss else None,'inkRenderMs':summarize([record['durationMs'] for run in runs for record in run['trace'] if record['stage']=='inkOutput' and record.get('durationMs') is not None and record['generation']>0]) if any(record['stage']=='inkOutput' and record.get('durationMs') is not None and record['generation']>0 for run in runs for record in run['trace']) else None,'runs':runs}
 output.mkdir(parents=True,exist_ok=True);(output/f'{scenario}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({key:value for key,value in result.items() if key!='runs'}),flush=True)
 return result

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--repo',type=pathlib.Path,default=REPO);parser.add_argument('--output',type=pathlib.Path,default=REPO/'docs/_reports/performance/resize-2026-10-22/after');parser.add_argument('--scenario',default='idle');parser.add_argument('--iterations',type=int,default=5);parser.add_argument('--cycles',type=int,default=3);parser.add_argument('--history-turns',type=int,default=200);parser.add_argument('--functional',action='store_true');parser.add_argument('--check-performance',action='store_true');args=parser.parse_args()
 result=run(args.repo,args.scenario,args.iterations,args.cycles,args.output,args.history_turns,args.functional)
 if args.check_performance:assert result['resizeMs']['p95']<=100,'P95 resize exceeds 100ms'
