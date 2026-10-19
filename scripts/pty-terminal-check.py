#!/usr/bin/env python3
"""Opt-in real-PTY terminal regression check for the interactive app.

Drives the real launcher in a pseudo-terminal (not Ink's in-memory test stream) with an
isolated home and no reachable provider, and checks behavior that component tests cannot
see: Unicode and bracketed-paste input, a width-changing resize, an alternate-screen
overlay round trip, Ctrl+C at idle, and terminal-mode restoration on exit.

Usage: python3 scripts/pty-terminal-check.py
Exit status 0 when every check passes; failures are listed on stderr.
"""
import fcntl, importlib.util, os, pathlib, re, select, shutil, signal, struct, subprocess, sys
import termios, time

REPO = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bench", REPO / "scripts/bench/interactive-startup.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


class Session:
    def __init__(self):
        self.root = bench.prepare_root("updates-disabled")
        env = bench.isolated_env(self.root, None)
        self.master, slave = os.openpty()
        self.resize(30, 100)
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        self.child = subprocess.Popen(
            ["node", str(REPO / "bin/ubume.js")], cwd=self.root / "project", env=env,
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        self.output = b""

    def resize(self, rows, columns):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.master], [], [], 0.02)[0]:
                try:
                    self.output += os.read(self.master, 65536)
                except OSError:
                    return

    def wait_for(self, needle, since, timeout=8.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if needle in self.output[since:]:
                return True
            self.pump(0.05)
        return False

    def send(self, keys, settle=0.25):
        mark = len(self.output)
        os.write(self.master, keys)
        self.pump(settle)
        return mark

    def close(self):
        if self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait()
        os.close(self.master)
        shutil.rmtree(self.root, ignore_errors=True)


def last_index(data, sequence):
    return data.rfind(sequence)


def main():
    failures = []
    check = lambda ok, name: print(f"{'PASS' if ok else 'FAIL'} {name}") or (None if ok else failures.append(name))
    session = Session()
    try:
        check(session.wait_for(bench.MARKER, 0, timeout=15), "composer becomes visible")
        session.pump(0.5)

        mark = session.send("héllo 漢字 👩🏽‍💻".encode())
        check(session.wait_for("héllo 漢字 👩🏽‍💻".encode(), mark), "Unicode input is echoed intact")
        session.send(b"\x15")

        mark = session.send(b"\x1b[200~pasted words\x1b[201~")
        check(session.wait_for(b"pasted words", mark), "bracketed paste reaches the composer")
        session.send(b"\x15")

        session.resize(30, 60)
        mark = len(session.output)
        os.killpg(session.child.pid, signal.SIGWINCH)
        session.pump(1.0)
        frame = ANSI.sub(b"", session.output[mark:]).decode("utf8", "replace")
        widths = [len(line) for line in frame.splitlines() if line.startswith("╭")]
        check(bool(widths) and max(widths) <= 60, f"resize redraws at the new width (box widths {widths[-3:]})")
        check(session.child.poll() is None, "app survives the resize")

        # The full command name: a partial one is first completed by Enter.
        mark = session.send(b"/themes", 0.3)
        session.send(b"\r", 1.0)
        entered = b"\x1b[?1049h" in session.output[mark:]
        mark = session.send(b"\x1b", 1.0)
        left = b"\x1b[?1049l" in session.output[mark:]
        check(entered and left, "overlay enters and leaves the alternate screen")
        check(session.wait_for(b"Full Access", mark), "main screen footer is back after the overlay")

        mark = session.send(b"!printf 'one\\ntwo\\n'", 0.3)
        session.send(b"\r", 0.1)
        check(session.wait_for(b"Executed shell", mark, 8), "!shell completes and reaches scrollback")
        session.pump(0.3)

        session.send(b"\x03", 0.6)
        check(session.child.poll() is None, "Ctrl+C at idle does not kill the app")
        session.send(b"\x15")

        session.send(b"/exit", 0.4)
        started = time.monotonic()
        session.send(b"\r", 0.4)
        session.send(b"\r", 0.1)
        while session.child.poll() is None and time.monotonic() - started < 10:
            session.pump(0.05)
        exit_ms = (time.monotonic() - started) * 1000
        check(session.child.poll() == 0, f"/exit exits with status 0 (took {exit_ms:.0f}ms)")
        out = session.output
        for enable, disable, name in (
            (b"\x1b[?2004h", b"\x1b[?2004l", "bracketed paste disabled on exit"),
            (b"\x1b[?25l", b"\x1b[?25h", "cursor shown on exit"),
            (b"\x1b[?1049h", b"\x1b[?1049l", "alternate screen left on exit"),
        ):
            check(last_index(out, disable) > last_index(out, enable), name)
    finally:
        session.close()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
