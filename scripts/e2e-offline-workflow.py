#!/usr/bin/env python3
"""Offline end-to-end workflow through the installed launcher in a real PTY.

Drives `node bin/ubume.js` (→ Bun → src/index.tsx) with fake `codex` and `claude` executables
and walks one user workflow: input-ready → provider picker → fake provider/model → prompt →
streamed Markdown + tool activity → save → restart and resume → provider switch → unavailable
model → recovery through the model picker → mid-stream cancellation → /exit.

Safety: scripts/bench/ptylib.py builds the sandbox (provider-free PATH that refuses to start if
a provider CLI resolves, temporary HOME/data/provider homes, refusing HTTP(S) proxies) and every
fake logs its own identity; the run fails if anything else was spawned. For full containment
also run it inside a network/mount namespace (see the local report docs/_reports/performance/phase-1-final-integration-report.md).

Each step is reported as PASS, FAIL, or GAP (could not be driven reliably; never counted as a
pass). Exit status is non-zero when any step fails.

Usage: python3 scripts/e2e-offline-workflow.py [--json out.json] [--verbose]
"""
import json, os, pathlib, re, signal, subprocess, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "bench"))
from ptylib import REPO, Sandbox, Session, arg  # noqa: E402

ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]")

# Fake Codex: app-server model/list, `exec --json` turns; the model is read from argv.
FAKE_CODEX = r"""
const args = process.argv.slice(2);
const fs = require("node:fs");
if (args.includes("--version")) { console.log("codex-cli 0.0.0-offline"); process.exit(0); }
if (args.includes("--help")) { console.log("Usage: codex exec\n  -c, --config <key=value>\n  -m, --model <MODEL>"); process.exit(0); }
if (args[0] === "login") { console.log(JSON.stringify({ loggedIn: true, authMode: "chatgpt" })); process.exit(0); }
if (args[0] === "app-server") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    const model = (id) => ({ id, model: id, displayName: id, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" });
    const result = message.method === "model/list"
      ? { data: [model("offline-alpha"), model("offline-gone")], nextCursor: null }
      : message.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: false } : {};
    console.log(JSON.stringify({ id: message.id, result }));
  });
  return;
}
const joined = args.join(" ");
(async () => {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const event = (type, item) => console.log(JSON.stringify(item ? { type, item } : { type }));
  if (/offline-gone/.test(joined)) {
    console.log(JSON.stringify({ type: "error", message: "model_not_found: The model offline-gone does not exist or you do not have access to it." }));
    process.exit(1);
  }
  if (prompt.includes("E2E_WAIT_FOR_CANCEL")) {
    if (process.env.E2E_PID_FILE) fs.writeFileSync(process.env.E2E_PID_FILE, String(process.pid));
    event("item.started", { id: "answer", type: "agent_message", text: "E2E partial before cancel" });
    setInterval(() => {}, 1000);
    return;
  }
  event("item.completed", { id: "tool", type: "command_execution", command: "echo e2e-tool", status: "completed", aggregated_output: "e2e tool output", exit_code: 0 });
  const text = "## E2E Heading\n\n| Col A | Col B |\n| --- | --- |\n| e2e-cell-1 | e2e-cell-2 |\n\n```ts\nconst e2eCode = 42;\n```\n\nE2E_ANSWER_DONE";
  event("item.started", { id: "answer", type: "agent_message", text: text.slice(0, 12) });
  event("item.completed", { id: "answer", type: "agent_message", text });
  event("turn.completed");
})();
"""

# Fake Claude Code: auth/model discovery and stream-json print mode.
FAKE_CLAUDE = r"""
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.0.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" || args[0] === "login") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
if (args[0] === "model" && args[1] === "list") {
  console.log(JSON.stringify({ models: [{ value: "sonnet", canonicalId: "claude-sonnet-5-5", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" }] }));
  process.exit(0);
}
if (args.includes("-p")) {
  const text = "E2E_CLAUDE_ANSWER";
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "e2e-claude-session" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: "e2e-claude-session" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", result: text, session_id: "e2e-claude-session" }));
  process.exit(0);
}
console.error("fake claude: unsupported " + JSON.stringify(args));
process.exit(97);
"""

VERBOSE = "--verbose" in sys.argv
results = []


def plain(data):
    return ANSI.sub(b"", data).decode("utf-8", "replace")


def record(step, status, detail=""):
    results.append({"step": step, "status": status, "detail": detail})
    print(f"{status:5} {step}{(' — ' + detail) if detail else ''}", flush=True)


def wait_text(session, text, since=0, timeout=15.0):
    """Waits until `text` appears in the ANSI-stripped output after byte offset `since`."""
    end = time.perf_counter() + timeout
    while time.perf_counter() < end:
        if text in plain(session.output[since:]):
            return True
        session.pump(0.02)
    return False


def screen_tail(session, since=0, chars=1200):
    return plain(session.output[since:])[-chars:]


def step(name, ok, session=None, since=0, detail=""):
    if not ok and VERBOSE and session is not None:
        detail = f"{detail}\n----- screen tail -----\n{screen_tail(session, since)}\n-----"
    record(name, "PASS" if ok else "FAIL", detail)
    return ok


def gap(name, reason):
    record(name, "GAP", reason)


def pids_alive(pids):
    alive = []
    for pid in pids:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except ProcessLookupError:
            pass
        except PermissionError:
            alive.append(pid)
    return alive


def headless(sandbox, *args):
    result = subprocess.run(["node", str(REPO / "bin/ubume.js"), *args], cwd=sandbox.root / "project",
                            env=sandbox.env, capture_output=True, text=True, timeout=60)
    return result


def exit_cleanly(session, label):
    session.send(b"\x15", 0.05)
    session.send(b"/exit", 0.3)
    started = time.monotonic()
    session.send(b"\r", 0.3)
    session.send(b"\r", 0.1)
    while session.child.poll() is None and time.monotonic() - started < 10:
        session.pump(0.05)
    out = session.output
    last = lambda needle: out.rfind(needle)
    restored = all(last(off) > last(on) for on, off in (
        (b"\x1b[?2004h", b"\x1b[?2004l"), (b"\x1b[?25l", b"\x1b[?25h"), (b"\x1b[?1049h", b"\x1b[?1049l")))
    step(f"{label}: /exit exits 0 and restores terminal modes", session.child.poll() == 0 and restored,
         session, 0, f"exit={session.child.poll()} restored={restored}")


def main():
    out_json = arg("--json")
    sandbox = Sandbox(
        settings={"updateCheck": {"enabled": False}},
        fakes={"codex": FAKE_CODEX, "claude": FAKE_CLAUDE},
        extra_env={"E2E_PID_FILE": "", "UBUME_SKIP_UPDATE_CHECK": "1"},
    )
    pid_file = sandbox.root / "codex-wait.pid"
    sandbox.env["E2E_PID_FILE"] = str(pid_file)
    (sandbox.root / "project" / "README.md").write_text("e2e fixture project\n")
    subprocess.run(["git", "init", "-q"], cwd=sandbox.root / "project", env=sandbox.env, check=False)
    session = None
    try:
        # 1-3. Launch through the real launcher and reach an input-ready composer.
        session = Session(sandbox, rows=40, columns=120)
        try:
            ready_ms = session.wait_ready(timeout=20)
            step("1-3 launcher → TUI → input-ready", True, detail=f"{ready_ms:.0f} ms")
        except RuntimeError as error:
            step("1-3 launcher → TUI → input-ready", False, session, 0, str(error))
            return

        # 4-5. Provider picker → OpenAI (fake Codex).
        mark = session.command("/provider", settle=0.6)
        opened = wait_text(session, "Anthropic", mark, 8) and wait_text(session, "OpenAI", mark, 2)
        step("4 provider picker opens", opened, session, mark)
        if opened:
            session.send(b"\x1b[H", 0.2)  # Home: first row is OpenAI
            mark = session.send(b"\r", 1.0)
            selected = wait_text(session, "OpenAI", mark, 8)
            step("5 select fake provider (OpenAI → fake codex)", selected, session, mark)
            session.send(b"\x1b", 0.4)

        # 6. Model picker lists the fake catalog; choose offline-alpha.
        mark = session.command("/model", settle=0.8)
        listed = wait_text(session, "offline-alpha", mark, 12)
        step("6a model picker lists fake Codex catalog", listed, session, mark)
        if listed:
            session.send(b"\x1b[H", 0.2)
            mark2 = session.send(b"\r", 1.0)
            chosen = wait_text(session, "offline-alpha", mark2, 6)
            step("6b select available fake model", chosen, session, mark2)
            session.send(b"\x1b", 0.3)

        # 7-9. Prompt, streamed Markdown, tool activity.
        mark = session.command("explain the fixture", settle=0.2)
        answered = wait_text(session, "E2E_ANSWER_DONE", mark, 20)
        step("7-8 prompt streams fake response", answered, session, mark)
        text = plain(session.output[mark:])
        step("9a Markdown table/code rendered", "e2e-cell-1" in text and "e2eCode" in text and "E2E Heading" in text,
             session, mark)
        step("9b tool activity shown", "echo e2e-tool" in text or "e2e tool output" in text, session, mark)

        # 10. Conversation saved (headless inspection of the same data root).
        session.pump(1.5)  # autosave cadence is about one second while busy
        listing = headless(sandbox, "sessions", "list", "--json")
        conversation_id = None
        try:
            data = json.loads(listing.stdout).get("data") or []
            items = data if isinstance(data, list) else data.get("sessions") or data.get("items") or []
            if items:
                conversation_id = items[0].get("id")
        except (json.JSONDecodeError, AttributeError):
            pass
        step("10 conversation saved", bool(conversation_id), detail=(conversation_id or listing.stdout[:300] + listing.stderr[:300]))
        exit_cleanly(session, "first session")
        session.close()
        session = None

        # 11. Reopen with --resume and see the saved transcript.
        if conversation_id:
            session = Session(sandbox, argv=["node", str(REPO / "bin/ubume.js"), "--resume", conversation_id], rows=40, columns=120)
            resumed = wait_text(session, "E2E_ANSWER_DONE", 0, 20)
            step("11 restart and resume shows saved transcript", resumed, session, 0)
            try:
                session.wait_ready(timeout=15)
            except RuntimeError as error:
                step("11b resumed session input-ready", False, session, 0, str(error))
        else:
            gap("11 restart and resume", "no saved conversation id")
            session = Session(sandbox, rows=40, columns=120)
            session.wait_ready(timeout=20)

        # 12. Switch provider to Anthropic (fake claude) and run a prompt.
        mark = session.command("/provider", settle=0.6)
        if wait_text(session, "Anthropic", mark, 8):
            session.send(b"\x1b[H", 0.1)
            session.send(b"\x1b[B", 0.2)
            mark2 = session.send(b"\r", 1.2)
            session.send(b"\x1b", 0.3)
            mark3 = session.command("hello claude", settle=0.2)
            switched = wait_text(session, "E2E_CLAUDE_ANSWER", mark3, 20)
            step("12 switch provider (Anthropic → fake claude) and run", switched, session, mark2)
        else:
            step("12 switch provider", False, session, mark, "picker did not open")

        # Back to OpenAI for the unavailable-model scenario.
        mark = session.command("/provider", settle=0.6)
        if wait_text(session, "OpenAI", mark, 8):
            session.send(b"\x1b[H", 0.2)
            session.send(b"\r", 1.0)
            session.send(b"\x1b", 0.3)

        # 13-14. Unavailable model → recovery picker → working model → success.
        mark = session.command("/model", settle=0.8)
        if wait_text(session, "offline-gone", mark, 12):
            session.send(b"\x1b[H", 0.1)
            session.send(b"\x1b[B", 0.2)
            session.send(b"\r", 1.0)
            session.send(b"\x1b", 0.3)
            mark2 = session.command("use the gone model", settle=0.2)
            failed = wait_text(session, "unavailable or unsupported", mark2, 20)
            step("13 unavailable model reported", failed, session, mark2)
            # Recovery is user-driven: the error points at /model (see modelRecoveryApp.tsx).
            mark_picker = session.command("/model", settle=0.8)
            recovery = wait_text(session, "Select model", mark_picker, 10) and \
                wait_text(session, "offline-alpha", mark_picker, 5)
            if failed and recovery:
                session.send(b"\x1b[H", 0.2)
                session.send(b"\r", 1.0)
                session.send(b"\x1b", 0.3)
                mark3 = session.command("retry after recovery", settle=0.2)
                recovered = wait_text(session, "E2E_ANSWER_DONE", mark3, 20)
                step("14 recover through model selection", recovered, session, mark3)
            else:
                step("14 recover through model selection", False, session, mark2, "recovery picker not shown")
        else:
            step("13 unavailable model reported", False, session, mark, "offline-gone not listed")

        # 15. Cancel a synthetic run mid-stream; the fake provider must be gone afterwards.
        mark = session.command("please E2E_WAIT_FOR_CANCEL", settle=0.2)
        started = wait_text(session, "E2E partial before cancel", mark, 20)
        deadline = time.monotonic() + 5
        while not pid_file.exists() and time.monotonic() < deadline:
            session.pump(0.05)
        provider_pid = int(pid_file.read_text()) if pid_file.exists() else None
        session.send(b"\x1b", 0.3)
        session.send(b"\x03", 1.5)
        deadline = time.monotonic() + 8
        while provider_pid and pids_alive([provider_pid]) and time.monotonic() < deadline:
            session.pump(0.1)
        stopped = bool(provider_pid) and not pids_alive([provider_pid])
        step("15 cancel synthetic run (provider process stopped, app alive)",
             started and stopped and session.child.poll() is None, session, mark,
             f"started={started} provider_pid={provider_pid} stopped={stopped}")

        # 16. Exit cleanly; no surviving descendants; artifacts only inside the sandbox.
        tree_before = [pid for pid, _ in session.tree_pids()]
        exit_cleanly(session, "16 final session")
        time.sleep(0.5)
        step("16b no surviving process-tree members", not pids_alive(tree_before), detail=str(pids_alive(tree_before)))
        session.close()
        session = None

        spawned = sandbox.spawned()
        # Selections are proven by what actually ran, not by what the picker displayed.
        runs = [(entry["provider"], " ".join(entry["argv"])) for entry in spawned
                if (entry["provider"] == "codex" and entry["argv"][:1] == ["exec"]) or
                (entry["provider"] == "claude" and "-p" in entry["argv"])]
        models = [("claude" if provider == "claude" else
                   "offline-gone" if "offline-gone" in argv else
                   "offline-alpha" if "offline-alpha" in argv else "?") for provider, argv in runs]
        step("5/6/12/14 run sequence matches selections (spawn log)",
             models[:1] == ["offline-alpha"] and "claude" in models and
             "offline-gone" in models and models[models.index("offline-gone") + 1:][:1] == ["offline-alpha"],
             detail=" → ".join(models))
        allowed ={os.path.realpath(sandbox.fakes["codex"]), os.path.realpath(sandbox.fakes["claude"])}
        unexpected = [entry["executable"] for entry in spawned if entry["executable"] not in allowed]
        step("safety: only fake providers were spawned", not unexpected and bool(spawned),
             detail=f"{len(spawned)} fake spawns; unexpected={unexpected}")
        stray = [p for p in (sandbox.root / "project").iterdir() if p.name not in {".git", "README.md"}]
        step("artifacts stay in sandbox data roots (project untouched)", not stray, detail=str(stray))
    finally:
        if session is not None:
            session.close()
        sandbox.dispose()
        failed = [r for r in results if r["status"] == "FAIL"]
        gaps = [r for r in results if r["status"] == "GAP"]
        summary = {"passed": sum(r["status"] == "PASS" for r in results), "failed": len(failed), "gaps": len(gaps), "steps": results}
        print(f"\n{summary['passed']} passed, {summary['failed']} failed, {summary['gaps']} gaps")
        if out_json:
            pathlib.Path(out_json).write_text(json.dumps(summary, indent=2) + "\n")
    sys.exit(1 if any(r["status"] in ("FAIL", "GAP") for r in results) else 0)


if __name__ == "__main__":
    main()
