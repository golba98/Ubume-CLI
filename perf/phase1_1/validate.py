"""Run focused source regressions with hidden host homes and an egress-free namespace."""
import hashlib
import json
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
TESTS = [
    'src/config/runtimeConfig.test.ts',
    'src/config/layeredConfig.test.ts',
    'src/config/settings.test.ts',
    'src/core/providerRuntime/anthropic.test.ts',
    'src/core/providerLauncher/workspaceConfig.test.ts',
    'src/core/workspace/workspaceFiles.test.ts',
    'src/core/workspace/legacyDataMigration.test.ts',
    'src/headless/commands.test.ts',
    'src/core/executables/executableResolver.test.ts',
    'src/core/executables/codexExecutable.test.ts',
    'src/core/codex/codexLaunch.test.ts',
    'src/core/codex/codexAuth.test.ts',
    'src/core/codex/codexAuthExecution.test.ts',
    'src/core/codex/codexAppServerClient.test.ts',
    'src/core/models/codexModelCapabilities.test.ts',
    'src/core/models/modelCatalog.test.ts',
    'src/core/models/selectionCoordinator.test.ts',
    'src/core/providerRuntime/selectionReliability.test.ts',
    'src/core/providers/codexSubprocess.test.ts',
    'src/core/process/CommandRunner.test.ts',
    'src/core/process/outputCapture.test.ts',
    'src/core/terminal/terminalSanitize.test.ts',
    'src/core/terminal/terminalTitle.test.ts',
    'src/core/terminal/frameLock.test.ts',
    'src/core/workspace/checkpoints.test.ts',
    'src/core/workspace/workspaceActivity.test.ts',
    'src/core/workspace/conversationStore.test.ts',
    'src/session/appSession.test.ts',
    'src/session/liveRenderScheduler.test.ts',
    'src/app/run/providerRunSession.test.ts',
    'src/app/models/modelRecovery.test.tsx',
    'src/app/models/modelRecoveryApp.test.ts',
    'src/app/run/shellLineBatcher.test.ts',
    'src/app/lifecycle/useUpdateCheck.test.tsx',
    'src/core/version/updateScheduler.test.ts',
    'src/core/version/updateCheck.test.ts',
    'src/headless/executableSelection.test.ts',
    'src/index.test.tsx',
    'src/appRenderStability.test.ts',
    'src/ui/render/markdownParser.test.ts',
]
BUN = pathlib.Path(shutil.which('bun')).resolve()
cmd = [
    'bwrap', '--unshare-user', '--unshare-net', '--unshare-pid', '--die-with-parent',
    '--tmpfs', '/', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64', '--dir', '/tmp',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind', str(ROOT), '/workspace', '--ro-bind', str(BUN), '/runtime/bun',
    '--proc', '/proc', '--dev', '/dev', '--chdir', '/workspace',
    '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    'HOME=/tmp/validation-home', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
    '/runtime/bun', 'test', *TESTS,
]
result = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
out = ROOT / 'docs/_reports/performance/phase1_1'
out.mkdir(parents=True, exist_ok=True)
(out / 'focused-tests.log').write_text(result.stdout + result.stderr)
sha = hashlib.sha256()
for path in sorted((ROOT / 'src').rglob('*')):
    if path.is_file():
        sha.update(str(path.relative_to(ROOT)).encode())
        sha.update(path.read_bytes())
(out / 'validation.json').write_text(json.dumps({
    'sourceHash': sha.hexdigest(), 'tests': TESTS, 'exitCode': result.returncode,
    'method': 'Read-only repository; hidden host homes; empty inherited environment; network namespace; repository offline test preload.',
}, indent=2) + '\n')
print((result.stdout + result.stderr)[-4500:])
raise SystemExit(result.returncode)
