#!/usr/bin/env python3
"""Three real adapter processes, independent PTYs/workspaces, fake native executables."""
import concurrent.futures, hashlib, json, pathlib, sys, time
from resize import REPO, Sandbox, Driver, SIZES

output=REPO/'docs/_reports/performance/resize-2026-10-22/multi';output.mkdir(parents=True,exist_ok=True)
owned=[]
try:
 for provider in ('anthropic','mistral','google'):
  sandbox=Sandbox(fakes={'resize-fixture':(REPO/'scripts/bench/resize-producer.cjs').read_text()})
  if owned:sandbox.env['UBUME_DATA_DIR']=owned[0][1].env['UBUME_DATA_DIR']
  sandbox.env.update({'RESIZE_NATIVE_PROVIDER':provider,'RESIZE_SCENARIO':'tools','RESIZE_EXECUTABLE':sandbox.fakes['resize-fixture'],'RESIZE_MANIFEST':str(sandbox.root/'manifest.jsonl'),'RESIZE_EVENTS':'320','RESIZE_EVENT_MS':'15','UBUME_RESIZE_TRACE':str(sandbox.root/'trace.jsonl')})
  d=Driver(sandbox,REPO);owned.append((provider,sandbox,d));d.session.wait_ready();d.pump()
 for provider,sandbox,d in owned:d.command('independent agentic fixture')
 # Pump every terminal throughout: one blocked PTY reader must not create apparent cross-process lag.
 def exercise(entry):
  provider,sandbox,d=entry
  d.wait(lambda:(sandbox.root/'manifest.jsonl').exists(),provider+' native executable starts',25)
  for _ in range(3):
   for cols,rows in SIZES[1:]:d.resize(cols,rows)
  d.wait(lambda:'RESIZE_FINAL_COMPLETE' in d.text(),provider+' completes',60)
  def snapshot():
   for p in pathlib.Path(sandbox.env['UBUME_DATA_DIR']).rglob('snapshot.json'):
    value=json.loads(p.read_text())
    if value.get('metadata',{}).get('workspaceRoot')==str(sandbox.root/'project') and any('RESIZE_FINAL_COMPLETE' in m['content'] for m in value.get('messages',[])):return value
   return None
  d.wait(lambda:snapshot() is not None,provider+' persists completion')
  value=snapshot();answer=value['messages'][-1]['content']
  assert value['metadata']['workspaceRoot']==str(sandbox.root/'project')
  assert value['metadata']['providerId']==provider
  ids=[f'LINE_{i:04}' for i in range(320)]
  assert all(answer.count(token)==1 for token in ids),'lost or duplicated native provider text'
  assert [answer.index(token) for token in ids]==sorted(answer.index(token) for token in ids),'reordered native provider output'
  runs=[e for e in value['session']['events'] if e.get('type')=='run'];assert runs[-1]['status']=='completed'
  assert len([t for t in runs[-1]['toolActivities'] if t['status']=='completed'])==40
  assert len(list((sandbox.root/'project').glob('fixture-file-*.txt')))==40
  sandbox.assert_spawned_only(sandbox.fakes.values())
  d.session.close();d.session=None
  trace=[json.loads(line) for line in (sandbox.root/'trace.jsonl').read_text().splitlines()]
  (output/f'{provider}.json').write_text(json.dumps({'provider':provider,'frames':d.frames,'trace':trace,'workspace':str(sandbox.root/'project'),'passed':True},ensure_ascii=False,indent=2))
  print('PASS '+provider+': independent native adapter, 320 text events, 40 tools, 21 resizes',flush=True)
 def lock_check():
  provider,sandbox,first=owned[0]
  until=time.perf_counter()+20
  while not (sandbox.root/'manifest.jsonl').exists() and time.perf_counter()<until:time.sleep(.005)
  count=len(sandbox.spawned())
  competitor=Driver(sandbox,REPO)
  try:
   competitor.session.wait_ready();competitor.command('must not run in the occupied workspace')
   competitor.wait(lambda:'Workspace busy' in competitor.text() or 'is busy' in competitor.text(),'same-workspace execution lease blocks competitor')
   assert len(sandbox.spawned())==count,'competing execution spawned a native provider'
   print('PASS same-workspace competitor is blocked without canceling the owner',flush=True)
  finally:competitor.session.close()
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
  futures=[executor.submit(exercise,entry) for entry in owned]
  futures.append(executor.submit(lock_check))
  for future in futures:future.result()
 # Workspaces share one application data root; each actual execution also retains its workspace lease.
 print('PASS three independent terminals sharing application storage; isolated output, workspaces and dimensions',flush=True)
finally:
 for provider,sandbox,d in owned:
  if d.session:d.session.close()
  sandbox.dispose()
