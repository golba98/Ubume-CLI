#!/usr/bin/env python3
"""Opt-in real-PTY terminal regression check for the interactive app.

Drives the real launcher in a pseudo-terminal (not Ink's in-memory test stream) with an
isolated home and no reachable provider, and checks behavior that component tests cannot
see: Unicode and bracketed-paste input, a width-changing resize, an alternate-screen
overlay round trip, Ctrl+C at idle, terminal-mode restoration on exit, and the compact
startup mark scaling through live resizes (checked on a reconstructed screen).

Usage: python3 scripts/testing/check-terminal-pty.py
Exit status 0 when every check passes; failures are listed on stderr.
"""
import fcntl, importlib.util, json, os, pathlib, re, select, shutil, signal, struct, subprocess, sys
import termios, time, unicodedata

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bench", REPO / "scripts/bench/interactive-startup.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


class Session:
    def __init__(self, style="normal", color_env=None):
        self.root = bench.prepare_root("updates-disabled")
        settings_path = self.root / ".ubume-settings.json"
        settings = json.loads(settings_path.read_text())
        settings["ui"] = {"startup_logo_style": style, "startup_animation": True, "theme": "dark"}
        settings_path.write_text(json.dumps(settings))
        env = bench.isolated_env(self.root, None)
        env.update(color_env or {})
        self.master, slave = os.openpty()
        self.output = b""
        self.resizes = []
        self.resize(30, 100)
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        self.child = subprocess.Popen(
            ["node", str(REPO / "bin/ubume.js")], cwd=self.root / "project", env=env,
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        self.started = time.monotonic()
        self.recording = []

    def resize(self, rows, columns):
        # Recorded against the output offset so the session can be replayed exactly.
        self.resizes.append((len(self.output), rows, columns))
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.master], [], [], 0.02)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                    self.output += chunk
                    self.recording.append([round(time.monotonic() - self.started, 6), "o", chunk.decode("utf8", "replace")])
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


TOKEN = re.compile(r"\x1b\[([0-9;?]*)([ -/]*)([@-~])|\x1b[\]P_^X].*?(?:\x07|\x1b\\)|\x1b[78]|\x1b.|.", re.S)


class Screen:
    """Minimal VT model for Ink output: cursor motion, erase, wrap, scroll and scrollback.

    Resizes follow Kitty's default behavior: a height shrink pushes the rows above
    the cursor into scrollback, growth adds blank rows, and lines are truncated or
    padded (not reflowed) on width changes. ESC[2J clears the screen, ESC[3J the
    scrollback.
    """

    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.scrollback = []
        self.row = self.col = 0
        self.saved = (0, 0)
        self.normal_buffer = None

    def _line_feed(self):
        if self.row == self.rows - 1:
            removed = self.grid.pop(0)
            if self.normal_buffer is None:
                self.scrollback.append(removed)
            self.grid.append([" "] * self.cols)
        else:
            self.row += 1

    def resize(self, rows, cols):
        if self.normal_buffer is not None:
            self.normal_buffer.resize(rows, cols)
        overflow = max(0, self.row - (rows - 1))
        self.scrollback.extend(self.grid[:overflow])
        self.grid = self.grid[overflow:overflow + rows]
        self.grid += [[" "] * cols for _ in range(rows - len(self.grid))]
        self.grid = [(line + [" "] * cols)[:cols] for line in self.grid]
        self.rows, self.cols = rows, cols
        self.row = min(self.row - overflow, rows - 1)
        self.col = min(self.col, cols - 1)

    def _put(self, char):
        width = 0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in "WF" else 1
        if width == 0:
            return
        if self.col + width > self.cols:
            self.col = 0
            self._line_feed()
        self.grid[self.row][self.col] = char
        if width == 2 and self.col + 1 < self.cols:
            self.grid[self.row][self.col + 1] = ""
        self.col += width

    def feed(self, text):
        for match in TOKEN.finditer(text):
            token = match.group(0)
            if match.group(3):
                params, final = match.group(1), match.group(3)
                if params == "?1049" and final in "hl":
                    if final == "h" and self.normal_buffer is None:
                        normal = Screen(self.rows, self.cols)
                        for field in ("grid", "scrollback", "row", "col", "saved"):
                            setattr(normal, field, getattr(self, field))
                        self.normal_buffer = normal
                        self.grid = [[" "] * self.cols for _ in range(self.rows)]
                        self.scrollback = []
                        self.row = self.col = 0
                    elif final == "l" and self.normal_buffer is not None:
                        for field in ("grid", "scrollback", "row", "col", "saved"):
                            setattr(self, field, getattr(self.normal_buffer, field))
                        self.normal_buffer = None
                    continue
                if params.startswith("?"):
                    continue
                n = [int(v) if v else 0 for v in params.split(";")] if params else [0]
                count = max(1, n[0])
                if final == "A": self.row = max(0, self.row - count)
                elif final == "B": self.row = min(self.rows - 1, self.row + count)
                elif final == "C": self.col = min(self.cols - 1, self.col + count)
                elif final == "D": self.col = max(0, self.col - count)
                elif final == "G": self.col = min(self.cols - 1, count - 1)
                elif final in "Hf":
                    self.row = min(self.rows - 1, max(1, n[0]) - 1)
                    self.col = min(self.cols - 1, max(1, n[1] if len(n) > 1 else 1) - 1)
                elif final == "J" and n[0] == 2:
                    self.grid = [[" "] * self.cols for _ in range(self.rows)]
                elif final == "J" and n[0] == 3:
                    self.scrollback = []
                elif final == "J":
                    self.grid[self.row][self.col:] = [" "] * (self.cols - self.col)
                    for row in range(self.row + 1, self.rows):
                        self.grid[row] = [" "] * self.cols
                elif final == "K":
                    start, end = {0: (self.col, self.cols), 1: (0, self.col + 1), 2: (0, self.cols)}.get(n[0], (0, 0))
                    self.grid[self.row][start:end] = [" "] * (end - start)
            elif token == "\x1b7":
                self.saved = (self.row, self.col)
            elif token == "\x1b8":
                self.row, self.col = self.saved
            elif token.startswith("\x1b"):
                continue
            elif token == "\r":
                self.col = 0
            elif token == "\n":
                self._line_feed()
            elif token == "\b":
                self.col = max(0, self.col - 1)
            elif token >= " ":
                self._put(token)

    def lines(self):
        return ["".join(row).rstrip() for row in self.grid]

    def history(self):
        """Scrollback followed by the screen: everything a user can scroll through."""
        return ["".join(row).rstrip() for row in self.scrollback] + self.lines()


def full_replay(session):
    """The whole session replayed through the terminal model, resizes included."""
    _, rows, cols = session.resizes[0]
    screen = Screen(rows, cols)
    offset = 0
    for at, rows, cols in session.resizes[1:]:
        screen.feed(session.output[offset:at].decode("utf8", "replace"))
        screen.resize(rows, cols)
        offset = at
    screen.feed(session.output[offset:].decode("utf8", "replace"))
    return screen.history()


def settled_screen(output, rows, cols):
    """The visible screen reconstructed from the app's last full repaint."""
    start = output.rfind(b"\x1b[2J")
    if start < 0:
        return None
    screen = Screen(rows, cols)
    screen.feed(output[start:].decode("utf8", "replace"))
    return screen.lines()


def responsive_checks(check):
    """Live resizes through real terminal sizes: the mark scales with the window."""
    # rows, columns, expected logo rows (0: metadata only), from startupLogoLayout.ts.
    steps = ((12, 43, 3), (24, 80, 3), (60, 200, 8), (20, 60, 3), (90, 300, 10),
             (70, 240, 10), (45, 160, 6), (30, 100, 4), (40, 120, 5), (12, 40, 0))
    for style in ("minimal", "simple"):
        session = Session(style, {"COLORTERM": "truecolor"})
        try:
            check(session.wait_for(bench.MARKER, 0, timeout=15), f"{style}/responsive: composer visible")
            session.pump(0.8)
            session.send(b"draft kept across resizes", 0.2)
            for rows, cols, expected in steps:
                label = f"{style}/responsive {cols}x{rows}"
                session.resize(rows, cols)
                mark = len(session.output)
                os.killpg(session.child.pid, signal.SIGWINCH)
                session.pump(0.6)
                lines = settled_screen(session.output, rows, cols)
                check(session.child.poll() is None, f"{label}: app survives")
                check(lines is not None and b"\x1b[2J" in session.output[mark:], f"{label}: width change repaints atomically")
                if not lines:
                    continue
                logo = 0
                while logo < len(lines) and re.search(r"[█▀▄]", lines[logo]):
                    logo += 1
                check(logo == expected, f"{label}: {expected} logo rows (saw {logo})")
                check(sum("Ubume CLI v" in line for line in lines) == 1, f"{label}: exactly one header")
                history = full_replay(session)
                check(sum("Ubume CLI v" in line for line in history) == 1,
                      f"{label}: one header across scrollback and screen")
                check(any("draft kept across resizes" in line for line in lines), f"{label}: typed draft preserved")
                check(any("Ask Ubume" in line or "❯" in line for line in lines[-8:]), f"{label}: composer stays at the bottom")
                text = "\n".join(lines)
                check(not re.search(r"\[\?\d|_G[a-z]=|1337;File|\x1b", text), f"{label}: no escaped protocol text")
            # The reported scenario (small <-> big cycles) and height-only changes: the
            # live header must never leave copies behind in scrollback.
            for rows, cols in ((20, 60), (50, 200)) * 3 + ((20, 200), (50, 200), (24, 200), (60, 200)):
                session.resize(rows, cols)
                os.killpg(session.child.pid, signal.SIGWINCH)
                session.pump(0.6)
                history = full_replay(session)
                check(sum("Ubume CLI v" in line for line in history) == 1,
                      f"{style}/responsive {cols}x{rows} cycle: one header across scrollback and screen")
            check(session.child.poll() is None, f"{style}/responsive: resize cycles survive")
            session.send(b"\x15", 0.05)
            session.send(b"/exit", 0.15)
            session.send(b"\r", 0.4)
            session.send(b"\r", 0.1)
            started = time.monotonic()
            while session.child.poll() is None and time.monotonic() - started < 10:
                session.pump(0.05)
            check(session.child.poll() == 0, f"{style}/responsive: exits cleanly after resizing")
        finally:
            session.close()


def compact_checks(check):
    """Real input during assembly, live themes through both pickers, and resize.

    Providers are unreachable under Session's isolated home and restricted PATH.
    Optional recordings are ignored artifacts beneath docs/_reports/recordings/.
    """
    output_dir = None
    if "--record" in sys.argv:
        output_dir = REPO / "docs/_reports/recordings/compact-startup"
        output_dir.mkdir(parents=True, exist_ok=True)
    for style, color_env in (("minimal", {"COLORTERM": "truecolor"}),
                             ("simple", {"TERM": "xterm", "FORCE_COLOR": "1"}),
                             ("minimal", {"NO_COLOR": "1"})):
        label = style + ("-plain" if "NO_COLOR" in color_env else "")
        session = Session(style, color_env)
        try:
            ready = session.wait_for(bench.MARKER, 0, timeout=15)
            check(ready, f"{label}: composer visible during startup")
            mark = session.send(b"zq7x", 0.12)
            check(session.wait_for(b"zq7x", mark, timeout=2), f"{label}: immediate startup input is preserved")
            session.send(b"\x15", 0.02)
            session.pump(0.6)
            plain = ANSI.sub(b"", session.output).decode("utf8", "replace")
            check("Ubume CLI v" in plain and "█" in plain and not re.search(r"[\u2800-\u28ff]", plain), f"{label}: large developer mark assembles")

            mark = session.send(b"/theme", 0.15)
            session.send(b"\r", 0.1)
            session.send(b"\r", 0.25)
            check(session.wait_for(b"Midnight Purple", mark), f"{label}: direct theme picker opens")
            session.send(b"\x1b[B", 0.1)
            session.send(b"\r", 0.35)
            settings = json.loads((session.root / ".ubume-settings.json").read_text())
            check(settings["ui"]["theme"] == "purple", f"{label}: direct theme change persists")
            direct_output = session.output[mark:]
            if "NO_COLOR" not in color_env:
                purple = b"38;2;187;154;247m" if "COLORTERM" in color_env else b"[97m"
                check(purple + "▄".encode() in direct_output,
                      f"{label}: completed logo recolors from the chosen theme")
            header_prefixes = [line.split("Ubume CLI v")[0] for line in ANSI.sub(b"", direct_output).decode("utf8", "replace").splitlines() if "Ubume CLI v" in line]
            # 100x30 selects the 16x4 mark: 1 pad + 16 logo cells + 2 gap columns.
            check(bool(header_prefixes) and len(set(header_prefixes)) == 1 and all(len(prefix) == 19 for prefix in header_prefixes),
                  f"{label}: theme change does not replay the logo")

            mark = session.send(b"/preferences", 0.15)
            session.send(b"\r", 0.25)
            check(session.wait_for(b"Appearance", mark), f"{label}: preferences opens")
            session.send(b"\x1b[B", 0.1)
            session.send(b"\x1b[B", 0.1)
            session.send(b"\r", 0.25)
            check(session.wait_for(b"Midnight Purple", mark), f"{label}: preferences theme picker opens")
            session.send(b"\x1b[B", 0.1)
            session.send(b"\r", 0.25)
            session.send(b"\x1b", 0.25)
            settings = json.loads((session.root / ".ubume-settings.json").read_text())
            check(settings["ui"]["theme"] == "mono", f"{label}: preferences theme change persists")
            if "NO_COLOR" not in color_env:
                neutral = b"38;2;250;250;250m" if "COLORTERM" in color_env else b"[97m"
                check(neutral + "▄".encode() in session.output[mark:], f"{label}: completed logo uses the monochrome theme")
            check(settings["ui"]["startup_logo_style"] == style, f"{label}: selected logo survives theme changes")

            # Resizes intentionally clear scrollback (copies pushed by the terminal);
            # startup and appearance changes must not.
            check(b"\x1b[3J" not in session.output, f"{label}: startup and theme changes preserve native scrollback")
            for columns in (40, 80, 120):
                session.resize(24, columns)
                os.killpg(session.child.pid, signal.SIGWINCH)
                session.pump(0.15)
            check(session.child.poll() is None, f"{label}: narrow/wide resize survives")
            mark = session.send(b"/clear", 0.12)
            session.send(b"\r", 0.3)
            check(session.wait_for(b"Ubume CLI v", mark), f"{label}: clear restores completed compact header")
            session.send(b"/exit", 0.15)
            session.send(b"\r", 0.4)
            session.send(b"\r", 0.1)
            check(session.child.poll() == 0, f"{label}: exits cleanly")
        finally:
            if output_dir:
                header = {"version": 2, "width": 100, "height": 30, "timestamp": int(time.time()), "env": {"TERM": color_env.get("TERM", "xterm-256color")}}
                (output_dir / f"{label}.cast").write_text("\n".join(json.dumps(row) for row in [header, *session.recording]) + "\n")
            session.close()


DIMENSION_MATRIX = ((100,22),(100,30),(140,22),(80,22),(100,15),(60,15),(40,10),
                    (160,40),(200,22),(80,60),(240,60),(300,80),(120,30),(140,35),
                    (200,50),(90,20),(80,24),(80,18),(70,16),(50,12),(30,8))


def dimension_matrix_checks(check):
    for style in ("normal", "minimal", "simple"):
        session = Session(style, {"COLORTERM": "truecolor"})
        try:
            check(session.wait_for(bench.MARKER, 0, timeout=15), f"{style}/matrix: input ready")
            session.send(b"draft kept", 0.15)
            for cols, rows in DIMENSION_MATRIX + ((100,22),):
                session.resize(rows, cols)
                os.killpg(session.child.pid, signal.SIGWINCH)
                session.pump(0.2)
                # Replay the actual resize events, rather than concatenating Ink diffs.
                history = full_replay(session)
                visible = history[-rows:]
                text = "\n".join(visible)
                label = f"{style}/matrix {cols}x{rows}"
                check(session.child.poll() is None, f"{label}: survives")
                check("draft kept" in text, f"{label}: draft visible")
                check("❯" in text, f"{label}: input accessible")
                check("Ubume" in text, f"{label}: identity visible")
                check(not re.search(r"_Ga=|1337;File|\x1b", text), f"{label}: no protocol corruption")
            # Repeated simultaneous changes should settle without accumulating headers.
            for step in range(40):
                session.resize(8 + step % 35, 30 + (step * 17) % 240)
                os.killpg(session.child.pid, signal.SIGWINCH)
                session.pump(0.005)
            session.resize(22,100)
            os.killpg(session.child.pid,signal.SIGWINCH)
            session.pump(0.4)
            text="\n".join(full_replay(session)[-22:])
            check("draft kept" in text and "❯" in text, f"{style}/matrix: rapid resize settles with draft")
        finally:
            session.close()


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
    compact_checks(check)
    responsive_checks(check)
    dimension_matrix_checks(check)
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
