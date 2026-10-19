"""Offline Phase 1.1 runner. No scripts/, launcher, package, or lockfile mutation.
Usage: python3 perf/phase1_1/run.py --label before --case safety
All application children and loopback mocks share an egress-free network namespace.
"""
import argparse, re, codecs, hashlib, json, os, pathlib, pty, select, shutil, subprocess, sys, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--inside', action='store_true')
p.add_argument('--label', default='after')
p.add_argument('--legacy-sanitizer', action='store_true', help='Controlled comparison: disable the plain-text sanitizer fast path in the source snapshot')
p.add_argument('--gated-update', action='store_true', help='Controlled comparison: restore the former update-screen gate in the private source snapshot')
p.add_argument('--case', choices=['safety', 'imports', 'startup', 'stream', 'memory', 'switch', 'app-switch', 'throughput', 'headless', 'shell', 'storage', 'all'], default='all')
p.add_argument('--runs', type=int, default=3)
a = p.parse_args()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', a.label):
    p.error('--label must be a simple name without path separators')
if a.runs < 1:
    p.error('--runs must be positive')
if not a.inside:
    if not shutil.which('bwrap'):
        sys.exit('SKIP: bwrap unavailable; isolation cannot be verified')
    bun = pathlib.Path(shutil.which('bun')).resolve()
    scratch = ROOT / 'docs' / '_reports' / 'performance' / 'phase1_1' / 'tmp'
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.phase11-', dir=scratch) as tmp:
        base = pathlib.Path(tmp)
        snapshot = base / 'snapshot'
        shutil.copytree(ROOT / 'src', snapshot / 'src')
        shutil.copytree(ROOT / 'perf' / 'phase1_1', snapshot / 'perf' / 'phase1_1', ignore=shutil.ignore_patterns('results', '__pycache__', '.phase11-*'))
        shutil.copyfile(ROOT / 'package.json', snapshot / 'package.json')
        if a.legacy_sanitizer:
            sanitizer = snapshot / 'src/core/terminal/terminalSanitize.ts'
            text = sanitizer.read_text()
            start = text.index('  // Ordinary streamed text')
            end = text.index('  return sanitizeTerminalOutput(raw);', start)
            sanitizer.write_text(text[:start] + text[end:])
        if a.gated_update:
            state = snapshot / 'src/app/state/useAppState.ts'
            state.write_text(state.read_text().replace('useState<Screen>("main")', 'useState<Screen>(startupUpdateEnabled.current ? "update-prompt" : "main")'))
            hook = snapshot / 'src/app/lifecycle/useUpdateCheck.ts'
            text = hook.read_text().replace('  // Test seam', '  returnFromUpdateOverlay: () => void;\n  screenRef: React.RefObject<import("../../session/types.js").Screen>;\n  // Test seam')
            text = text.replace('        benchTrace.startupMarkOnce("update-check-result", { status: result.status });', '        benchTrace.startupMarkOnce("update-check-result", { status: result.status });\n        if (result.status !== "update-available" && context.screenRef.current === "update-prompt") context.returnFromUpdateOverlay();')
            hook.write_text(text)
            app = snapshot / 'src/app/App.tsx'
            app.write_text(app.read_text().replace('const { requestUpdateCheck } = useUpdateCheck({', 'const { requestUpdateCheck } = useUpdateCheck({ returnFromUpdateOverlay,'))
        for name in ['work', 'home', 'data', 'bin', 'fakes']:
            (base / name).mkdir()
        for name in ['node', 'git', 'sh', 'python3']:
            target = shutil.which(name, path='/usr/bin:/bin')
            if target:
                (base / 'bin' / name).symlink_to(target)
        (base / 'bin' / 'bun').symlink_to('/runtime/bun')
        (base / 'spawns.jsonl').write_text('')
        cmd = ['bwrap', '--unshare-user', '--unshare-net', '--unshare-pid', '--die-with-parent', '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache', '--dir', '/tmp', '--dir', '/home', '--ro-bind', str(ROOT), '/workspace', '--ro-bind', str(snapshot / 'src'), '/workspace/src', '--ro-bind', str(snapshot / 'perf' / 'phase1_1'), '/workspace/perf/phase1_1', '--ro-bind', str(snapshot / 'package.json'), '/workspace/package.json', '--ro-bind', str(bun), '/runtime/bun', '--bind', tmp, '/bench', '--proc', '/proc', '--dev', '/dev', '--chdir', '/bench/work', '--', '/usr/bin/env', '-i', 'PATH=/bench/bin', 'HOME=/bench/home', 'USERPROFILE=/bench/home', 'XDG_CONFIG_HOME=/bench/home/config', 'XDG_CACHE_HOME=/bench/home/cache', 'XDG_DATA_HOME=/bench/home/share', 'XDG_STATE_HOME=/bench/home/state', 'UBUME_DATA_DIR=/bench/data', 'CODEX_HOME=/bench/home/codex', 'CLAUDE_CONFIG_DIR=/bench/home/claude', 'VIBE_HOME=/bench/home/vibe', 'GEMINI_CLI_HOME=/bench/home/gemini', 'TERM=xterm-256color', 'UBUME_SKIP_UPDATE_CHECK=1', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0', '/usr/bin/python3', '/workspace/perf/phase1_1/run.py', '--inside', '--label', a.label, '--case', a.case, '--runs', str(a.runs)]
        if a.gated_update:
            cmd.append('--gated-update')
        if a.legacy_sanitizer:
            cmd.append('--legacy-sanitizer')
        result = subprocess.run(cmd)
        if (base / 'result.json').exists():
            out = ROOT / 'docs' / '_reports' / 'performance' / 'phase1_1' / a.label
            out.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(base / 'result.json', out / (a.case + '.json'))
            if (base / 'terminal.cast').exists():
                shutil.copyfile(base / 'terminal.cast', out / 'startup.cast')
        sys.exit(result.returncode)
import socket
with socket.socket() as egress_probe:
    egress_probe.settimeout(0.1)
    assert egress_probe.connect_ex(('198.51.100.1', 443)) != 0, 'Unsafe network namespace'
fake = pathlib.Path('/bench/fakes/provider')
fake.write_text('#!/bench/bin/node\n' + (ROOT / 'perf/phase1_1/fake-provider.cjs').read_text())
fake.chmod(448)
allow = ['/runtime/bun', '/usr/bin/node', '/usr/bin/git', '/bin/sh', str(fake)]
os.environ['UBUME_OFFLINE_ALLOWLIST'] = json.dumps(allow)
for provider in ['CODEX', 'CLAUDE', 'AGY', 'VIBE', 'GEMINI']:
    os.environ[provider + '_EXECUTABLE'] = str(fake)
GUARD = '/workspace/perf/phase1_1/guard.cjs'
BASE = ['/runtime/bun', '--preload', GUARD]
FIX = '/workspace/perf/phase1_1/fixture.tsx'

def run_fixture(case, **env):
    work = tempfile.mkdtemp(prefix='case-', dir='/bench/work')
    result = subprocess.run(BASE + [FIX, case], cwd=work, env={**os.environ, **env}, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr[-6000:])
    return json.loads(result.stdout.strip().splitlines()[-1])

def pty_case(scenario):
    master, slave = pty.openpty()
    import fcntl, struct, termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
    trace = '/bench/trace.jsonl'
    pathlib.Path(trace).write_text('')
    env = {**os.environ, 'UBUME_STARTUP_TRACE': trace, 'UBUME_BENCH_TRACE': trace, 'UBUME_BENCH_SCENARIO': scenario, 'UBUME_BENCH_RUN_ID': scenario}
    work = tempfile.mkdtemp(prefix='pty-', dir='/bench/work')
    request_read, request_write = os.pipe()
    reply_read, reply_write = os.pipe()
    env.update(UBUME_BENCH_CLOCK_READ=str(request_read), UBUME_BENCH_CLOCK_WRITE=str(reply_write))
    started = time.monotonic_ns()
    proc = subprocess.Popen(BASE + [FIX, 'pty'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=work, pass_fds=(request_read, reply_write))
    os.close(slave)
    os.close(request_read)
    os.close(reply_write)
    calibrations = []
    try:
        for _ in range(10):
            t0 = time.monotonic_ns()
            os.write(request_write, b'x')
            if not select.select([reply_read], [], [], 5)[0]:
                raise RuntimeError('Clock handshake failed')
            reply = b''
            while not reply.endswith(b'\n'):
                reply += os.read(reply_read, 1)
            t1 = time.monotonic_ns()
            child_ns = int(reply)
            calibrations.append({'roundTripNs': t1 - t0, 'offsetNs': (t0 + t1) // 2 - child_ns})
    finally:
        os.close(request_write)
        os.close(reply_read)
    calibration = min(calibrations, key=lambda sample: sample['roundTripNs'])
    decoder = codecs.getincrementaldecoder('utf8')()
    tail = ''
    recording = []
    observed = {}
    ready = None
    submitted = False
    help_at = None
    update_at = None
    enter_at = None
    retry_at = None
    complete_at = None
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if complete_at is not None and time.monotonic() - complete_at > 0.5:
                break
            if retry_at is not None and time.monotonic() >= retry_at and (enter_at is None):
                os.write(master, b'\x01\x0b')
                time.sleep(0.02)
                os.write(master, b'/help')
                enter_at = time.monotonic() + 0.08
                retry_at = time.monotonic() + 0.4
            if enter_at is not None and time.monotonic() >= enter_at:
                os.write(master, b'\r')
                enter_at = None
            if select.select([master], [], [], 0.02)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                decoded = decoder.decode(data)
                if scenario == 'update-slow':
                    recording.append([(time.monotonic_ns() - started) / 1000000000.0, 'o', decoded])
                tail = (tail + decoded)[-100000:]
                now = time.monotonic_ns()
                import re
                for seq in re.findall('⟦(\\d+)⟧', tail):
                    observed.setdefault(int(seq), now)
                if ready is None and 'Ask Ubume' in tail and (scenario != 'history' or 'history-499' in tail):
                    ready = (now - started) / 1000000.0
                    os.write(master, b'/help' if scenario.startswith('update') or scenario == 'startup' else b'benchmark')
                    submitted = True
                    enter_at = time.monotonic() + 0.08
                    if scenario in ['startup', 'update-slow']:
                        retry_at = time.monotonic() + 0.4
                if submitted and 'Commands:' in tail:
                    help_at = (now - started) / 1000000.0
                    break
                if scenario not in ['startup', 'update-slow', 'update-available'] and 'BENCH_COMPLETE' in tail and (complete_at is None):
                    complete_at = time.monotonic()
                if complete_at is not None and time.monotonic() - complete_at > 0.5:
                    break
                if scenario == 'update-available' and '99.0.0' in tail:
                    update_at = (now - started) / 1000000.0
                    break
                if scenario == 'slow-reader':
                    time.sleep(0.04)
            if proc.poll() is not None:
                break
        records = [json.loads(line) for line in pathlib.Path(trace).read_text().splitlines() if line]
        proc.terminate()
        proc.wait(timeout=5)
        records = [json.loads(line) for line in pathlib.Path(trace).read_text().splitlines() if line]
        if scenario in ['startup', 'update-slow'] and help_at is None:
            raise RuntimeError('Command submission never completed: ' + tail[-3000:])
        if ready is None and update_at is None:
            raise RuntimeError('Composer never became visible: ' + tail[-3000:])
        if recording:
            pathlib.Path('/bench/terminal.cast').write_text(json.dumps({'version': 2, 'width': 120, 'height': 36}) + '\n' + ''.join((json.dumps(event) + '\n' for event in recording)))
        return {'clockCalibration': calibration, 'scenario': scenario, 'composerVisibleMs': ready, 'helpVisibleMs': help_at, 'updateVisibleMs': update_at, 'observedNs': observed, 'records': records, 'tail': tail[-1000:]}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
cases = ['safety', 'imports', 'startup', 'stream', 'memory', 'switch', 'app-switch', 'throughput', 'headless', 'shell', 'storage'] if a.case == 'all' else [a.case]
results = {}
preflight = run_fixture('safety')
for case in cases:
    print('Measuring ' + case, flush=True)
    if case == 'startup':
        results[case] = [pty_case(s) for s in ['startup', 'update-slow', 'update-available'] for _ in range(a.runs)]
    elif case == 'stream':
        results[case] = [pty_case(s) for s in ['normal', 'rapid', 'table', 'code', 'tools', 'history', 'slow-reader'] for _ in range(a.runs)]
    elif case == 'imports':
        results[case] = [run_fixture(case, IMPORT_GRAPH=graph) for graph in ['empty', 'ink', 'app', 'harness-module'] for _ in range(a.runs)]
    elif case == 'storage':
        results[case] = [run_fixture(case, STORAGE_MODE=mode, SHELL_BYTES=str(size)) for mode in ['memory', 'spool'] for size in [1024, 1048576, 10485760] for _ in range(a.runs)]
    else:
        results[case] = [run_fixture(case) for _ in range(a.runs)]
source_hash = hashlib.sha256()
for file in sorted((ROOT / 'src').rglob('*')):
    if file.is_file():
        source_hash.update(str(file.relative_to(ROOT)).encode())
        source_hash.update(file.read_bytes())
report = {'label': a.label, 'legacySanitizer': a.legacy_sanitizer, 'gatedUpdatePolicy': a.gated_update, 'case': a.case, 'sourceHash': source_hash.hexdigest(), 'kernel': os.uname().release, 'bun': subprocess.check_output(['/runtime/bun', '--version'], text=True).strip(), 'networkNamespace': os.readlink('/proc/self/ns/net'), 'preflight': preflight, 'results': results, 'spawns': [json.loads(s) for s in pathlib.Path('/bench/spawns.jsonl').read_text().splitlines()]}
pathlib.Path('/bench/result.json').write_text(json.dumps(report, indent=2))
print('Completed ' + a.case, flush=True)
