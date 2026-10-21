#!/usr/bin/env python3
"""Opt-in real-Kitty check for the responsive startup header.

Drives the real launcher inside an isolated Kitty OS window through Kitty's remote
control socket: resizes the window (the user's small -> big -> small cycles, width-only,
height-only, a rapid drag), changes the theme on the home screen, and after every step
reads the screen *and scrollback* (`get-text --extent all`). It checks that the
startup header exists exactly once (no copies stacked in scrollback), the typed draft
survives, no graphics protocol leaks as text, and (for image rendering) that the logo
is actually painted.

Isolation: temporary HOME, a PATH holding only node/bun/system dirs (provider CLIs are
unresolvable), provider executables pointed at missing files and all HTTP(S) through
a black-hole proxy. No model requests are possible and no credentials are read.

Requires `kitty` on PATH and a display. Screenshots (X11 `import` + Pillow) are
optional; without them the paint check is skipped and reported as such.

Usage: python3 scripts/kitty-responsive-check.py [--style simple|minimal|normal]
       [--rendering auto|solid] --monitor OUTPUT [--out DIR]
Exit status 0 when every check passes; failures are listed on stderr.
"""
import ctypes, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

REPO = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bench", REPO / "scripts/bench/interactive-startup.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

# Compact styles print "Ubume CLI v…"; the Normal banner prints "Ubume v…".
HEADERS = {"normal": "Ubume v"}
DEFAULT_HEADER = "Ubume CLI v"
PLACEHOLDER = "\U0010eeee"
SETTLE_S = 1.2


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


class X11Capture:
    """Finds the isolated window by WM class and captures it; None when unavailable."""

    def __init__(self, cls):
        self.cls = cls.encode()
        self.x = None
        if not os.environ.get("DISPLAY"):
            return
        try:
            x = ctypes.CDLL("libX11.so.6")
        except OSError:
            return
        x.XOpenDisplay.restype = ctypes.c_void_p
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
                                 ctypes.POINTER(ctypes.c_uint)]
        x.XGetClassHint.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_ClassHint)]
        x.XFree.argtypes = [ctypes.c_void_p]
        x.XFlush.argtypes = [ctypes.c_void_p]
        self.display = x.XOpenDisplay(None)
        if self.display:
            self.x = x

    def _search(self, window):
        hint = _ClassHint()
        self.x.XGetClassHint(self.display, window, ctypes.byref(hint))
        matched = bool(hint.class_ and self.cls in ctypes.string_at(hint.class_))
        if hint.name:
            self.x.XFree(hint.name)
        if hint.class_:
            self.x.XFree(hint.class_)
        if matched:
            return window
        root, parent = ctypes.c_ulong(), ctypes.c_ulong()
        children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        if self.x.XQueryTree(self.display, window, ctypes.byref(root), ctypes.byref(parent),
                             ctypes.byref(children), ctypes.byref(count)):
            items = [children[i] for i in range(count.value)]
            self.x.XFree(children)
            for child in items:
                found = self._search(child)
                if found:
                    return found
        return None

    def show_on_monitor(self, monitor):
        """Place the still-hidden test window before mapping, without activation."""
        if not self.x:
            raise RuntimeError("X11 window placement unavailable; refusing to open a test window")
        window = self._search(self.x.XDefaultRootWindow(self.display))
        if not window:
            raise RuntimeError("Test window unavailable")
        x, y, width, height = monitor
        self.x.XMoveWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
        self.x.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.x.XSetWMHints.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(_WMHints)]
        hints = _WMHints()
        hints.flags = 1  # InputHint: automated tests use remote input, never desktop focus.
        hints.input = 0
        self.x.XSetWMHints(self.display, window, ctypes.byref(hints))
        self.x.XMoveWindow(self.display, window, x + 40, y + 60)
        self.x.XMapWindow(self.display, window)
        self.x.XFlush(self.display)
        time.sleep(0.25)
        # wmctrl changes geometry only; it does not activate the window.
        subprocess.run(["wmctrl", "-ir", hex(window), "-e", f"0,{x + 40},{y + 60},-1,-1"], check=True)
        self.window = window
        self.monitor = monitor

    def assert_monitor(self):
        listing = subprocess.run(["wmctrl", "-lG"], capture_output=True, text=True, check=True).stdout
        for line in listing.splitlines():
            fields = line.split(None, 7)
            if int(fields[0], 16) != getattr(self, "window", 0):
                continue
            x, y, width, height = map(int, fields[2:6])
            mx, my, mw, mh = self.monitor
            if mx <= x and my <= y and x + width <= mx + mw and y + height <= my + mh:
                return
            raise RuntimeError(f"Test window outside selected monitor: {x},{y} {width}x{height}")
        raise RuntimeError("Cannot verify test window placement")

    def close(self):
        if self.x:
            self.x.XCloseDisplay.argtypes = [ctypes.c_void_p]
            self.x.XCloseDisplay(self.display)
            self.x = None

    def capture(self, path):
        if not self.x or not shutil.which("import"):
            return False
        window = self._search(self.x.XDefaultRootWindow(self.display))
        if not window:
            return False
        self.x.XFlush(self.display)
        time.sleep(0.25)
        return subprocess.run(["import", "-window", hex(window), str(path)],
                              capture_output=True, timeout=20).returncode == 0


class _WMHints(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_long), ("input", ctypes.c_int), ("initial_state", ctypes.c_int),
                ("icon_pixmap", ctypes.c_ulong), ("icon_window", ctypes.c_ulong),
                ("icon_x", ctypes.c_int), ("icon_y", ctypes.c_int),
                ("icon_mask", ctypes.c_ulong), ("window_group", ctypes.c_ulong)]


class _ClassHint(ctypes.Structure):
    _fields_ = [("name", ctypes.c_void_p), ("class_", ctypes.c_void_p)]


def logo_pixels(path):
    """Saturated pixels in the top-left header region (the mark's colored strokes)."""
    try:
        from PIL import Image
    except ImportError:
        return None
    image = Image.open(path).convert("RGB")
    width, height = image.size
    region = image.crop((0, 0, int(width * 0.2), int(height * 0.2)))
    return sum(1 for r, g, b in region.get_flattened_data() if max(r, g, b) - min(r, g, b) > 60)


class KittySession:
    def __init__(self, style, rendering, out):
        self.style, self.rendering, self.out = style, rendering, out
        name = arg("--monitor", None)
        if not name or not shutil.which("wmctrl"):
            raise RuntimeError("Pass --monitor OUTPUT and install wmctrl; test windows must have an explicit destination")
        monitors = subprocess.run(["xrandr", "--listmonitors"], capture_output=True, text=True, check=True).stdout
        monitor = None
        for line in monitors.splitlines()[1:]:
            if line.split()[-1] == name:
                match = re.search(r"(\d+)/\d+x(\d+)/\d+([+-]\d+)([+-]\d+)", line)
                if match:
                    width, height, x, y = map(int, match.groups())
                    monitor = (x, y, width, height)
        if monitor is None:
            raise RuntimeError(f"Monitor {name!r} unavailable; refusing to open a test window")
        self.proxy, _ = bench.black_hole_proxy()
        self.root = bench.prepare_root("updates-disabled")
        (self.root / ".ubume-settings.json").write_text(json.dumps({
            "updateCheck": {"enabled": False},
            "ui": {"startup_logo_style": style, "startup_logo_rendering": rendering,
                   "theme": "purple", "startup_animation": True,
                   "startup_header_middle_line": "provider"}}))
        env = bench.isolated_env(self.root, self.proxy.getsockname()[1])
        env.update({"TERM": "xterm-kitty", "COLORTERM": "truecolor"})
        self.control_dir = pathlib.Path(tempfile.mkdtemp(prefix="ubume-kitty-check-"))
        self.socket = f"unix:{self.control_dir / 'kitty.sock'}"
        self.cls = f"ubume-kitty-check-{os.getpid()}"
        command = ["/usr/bin/env", "-i", *(f"{k}={v}" for k, v in env.items()),
                   "node", str(REPO / "bin/ubume.js")]
        self.kitty = subprocess.Popen(
            ["kitty", "--start-as=hidden", "--position", f"{monitor[0] + 40}x{monitor[1] + 60}", "--listen-on", self.socket, "-o", "allow_remote_control=socket-only",
             "--class", self.cls, "-o", "linux_display_server=x11", "-o", "remember_window_size=no",
             "-o", "initial_window_width=80c", "-o", "initial_window_height=24c",
             "--directory", str(self.root / "project"), *command],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.capturer = X11Capture(self.cls)
        try:
            for _ in range(100):
                if self.rc("ls").returncode == 0:
                    break
                time.sleep(0.05)
            self.capturer.show_on_monitor(monitor)
            self.capturer.assert_monitor()
        except BaseException:
            self.close()
            raise

    def rc(self, *command):
        return subprocess.run(["kitty", "@", "--to", self.socket, *command],
                              capture_output=True, text=True, timeout=10)

    def text(self, extent):
        return self.rc("get-text", "--extent", extent).stdout

    def size(self):
        try:
            window = json.loads(self.rc("ls").stdout)[0]["tabs"][0]["windows"][0]
            return window["columns"], window["lines"]
        except (ValueError, LookupError):
            return None, None

    def wait_ready(self, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            # The composer prompt, not its placeholder: the placeholder hides as soon
            # as any input arrives.
            if "│ ❯" in self.text("screen"):
                return True
            time.sleep(0.2)
        return False

    def resize(self, columns, rows, settle=SETTLE_S):
        # Keep the current font. Constrain requests to the physical monitor's
        # available cells; PTY checks cover dimensions larger than this display.
        listing = subprocess.run(["wmctrl", "-lG"], capture_output=True, text=True, check=True).stdout
        current_columns, current_rows = self.size()
        for line in listing.splitlines():
            fields = line.split(None,7)
            if int(fields[0],16) == self.capturer.window and current_columns and current_rows:
                x,y,width,height = map(int,fields[2:6])
                mx,my,mw,mh = self.capturer.monitor
                columns = min(columns, int((mx+mw-x-20)/(width/current_columns)))
                rows = min(rows, int((my+mh-y-20)/(height/current_rows)))
                break
        self.rc("resize-os-window", "--unit", "cells", "--width", str(columns), "--height", str(rows))
        time.sleep(settle)
        # Some WMs keep the old top-left after a height growth. Re-anchor before
        # capture so a large window remains wholly inside the selected monitor.
        mx, my, _, _ = self.capturer.monitor
        subprocess.run(["wmctrl", "-ir", hex(self.capturer.window), "-e", f"0,{mx},{my},-1,-1"], check=True)
        time.sleep(0.08)
        self.capturer.assert_monitor()

    def send(self, text, settle=0.25):
        self.rc("send-text", text)
        time.sleep(settle)

    def close(self):
        try:
            if self.kitty.poll() is None:
                try:
                    self.rc("close-window")
                    self.kitty.wait(3)
                except (OSError, subprocess.TimeoutExpired) as error:
                    print(f"Kitty cleanup required termination: {error}", file=sys.stderr)
                    self.kitty.terminate()
                    try:
                        self.kitty.wait(3)
                    except subprocess.TimeoutExpired:
                        self.kitty.kill()
                        self.kitty.wait()
        finally:
            self.capturer.close()
            self.proxy.close()
            shutil.rmtree(self.root, ignore_errors=True)
            shutil.rmtree(self.control_dir, ignore_errors=True)


def run(style, rendering, out, check):
    session = KittySession(style, rendering, out)
    label = f"{style}/{rendering}"
    compact = style != "normal"
    graphical = compact and rendering != "solid"
    header = HEADERS.get(style, DEFAULT_HEADER)

    def inspect(step, draft=True):
        everything = session.text("all")
        screen = session.text("screen")
        columns, rows = session.size()
        name = f"{label} {step} ({columns}x{rows})"
        check(everything.count(header) == 1,
              f"{name}: one header in screen + scrollback (saw {everything.count(header)})")
        if draft:
            check("draft kept" in screen, f"{name}: typed draft preserved")
        check(not any(s in everything for s in ("_Ga=", "1337;File", "\x1b")),
              f"{name}: no protocol text")
        if graphical and screen.count(PLACEHOLDER):
            shot = out / f"{style}-{rendering}-{step.replace(' ', '-')}.png"
            if session.capturer.capture(shot):
                pixels = logo_pixels(shot)
                if pixels is None:
                    print(f"SKIP {name}: logo paint (Pillow unavailable)")
                else:
                    check(pixels > 300, f"{name}: logo image painted ({pixels} px)")
            else:
                print(f"SKIP {name}: logo paint (no X11 capture)")

    try:
        check(session.wait_ready(), f"{label}: composer visible")
        time.sleep(1.0)
        # Reset the isolated draft before testing; this window never requests desktop focus.
        session.send("\x15draft kept across resizes")
        inspect("startup")
        # The reported scenario: repeated small <-> big cycles.
        for cycle in range(4):
            session.resize(60, 20)
            inspect(f"cycle {cycle} small")
            session.resize(200, 50)
            inspect(f"cycle {cycle} big")
        session.resize(120, 50)
        inspect("width-only shrink")
        session.resize(200, 50)
        inspect("width-only grow")
        session.resize(200, 20)
        inspect("height-only shrink")
        session.resize(200, 50)
        inspect("height-only grow")
        for step in range(25):
            session.resize(60 + (step * 37) % 150, 16 + (step * 13) % 34, settle=0.03)
        session.resize(200, 50, settle=1.5)
        inspect("after rapid drag")
        # A committed theme change repaints the home screen (Up: a colored theme,
        # so the paint check stays meaningful).
        session.send("\x15", 0.1)
        session.send("/theme", 0.3)
        session.send("\r", 0.3)
        session.send("\r", 0.5)
        session.send("\x1b[A", 0.2)
        session.send("\r", 1.0)
        inspect("after theme change", draft=False)
        session.send("/exit", 0.3)
        session.send("\r", 0.5)
        session.send("\r", 0.1)
        end = time.monotonic() + 10
        while session.kitty.poll() is None and time.monotonic() < end:
            time.sleep(0.1)
        check(session.kitty.poll() is not None, f"{label}: /exit closes the app")
    finally:
        session.close()


def main():
    if not shutil.which("kitty"):
        print("SKIP kitty is not installed", file=sys.stderr)
        return 0
    out = pathlib.Path(arg("--out", str(REPO / "docs/_reports/branding/responsive")))
    out.mkdir(parents=True, exist_ok=True)
    failures = []

    def check(ok, name):
        print(f"{'PASS' if ok else 'FAIL'} {name}")
        if not ok:
            failures.append(name)

    if "--style" in sys.argv or "--rendering" in sys.argv:
        matrix = [(arg("--style", "simple"), arg("--rendering", "auto"))]
    else:
        matrix = [("simple", "auto"), ("minimal", "auto"), ("simple", "solid"), ("normal", "auto")]
    for style, rendering in matrix:
        run(style, rendering, out, check)
    if failures:
        print(f"{len(failures)} check(s) failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
