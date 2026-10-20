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
       [--rendering auto|solid] [--out DIR]
Exit status 0 when every check passes; failures are listed on stderr.
"""
import ctypes, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, time

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
        if not os.environ.get("DISPLAY") or not shutil.which("import"):
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
        x.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x.XFlush.argtypes = [ctypes.c_void_p]
        self.display = x.XOpenDisplay(None)
        if self.display:
            self.x = x

    def _search(self, window):
        hint = _ClassHint()
        self.x.XGetClassHint(self.display, window, ctypes.byref(hint))
        if hint.class_ and self.cls in hint.class_:
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

    def capture(self, path):
        if not self.x:
            return False
        window = self._search(self.x.XDefaultRootWindow(self.display))
        if not window:
            return False
        self.x.XRaiseWindow(self.display, window)
        self.x.XFlush(self.display)
        time.sleep(0.25)
        return subprocess.run(["import", "-window", hex(window), str(path)],
                              capture_output=True, timeout=20).returncode == 0


class _ClassHint(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("class_", ctypes.c_char_p)]


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
            ["kitty", "--listen-on", self.socket, "-o", "allow_remote_control=socket-only",
             "--class", self.cls, "-o", "linux_display_server=x11", "-o", "remember_window_size=no",
             "-o", "initial_window_width=80c", "-o", "initial_window_height=24c",
             "--directory", str(self.root / "project"), *command],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.capturer = X11Capture(self.cls)

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
        self.rc("resize-os-window", "--unit", "cells", "--width", str(columns), "--height", str(rows))
        time.sleep(settle)

    def send(self, text, settle=0.25):
        self.rc("send-text", text)
        time.sleep(settle)

    def close(self):
        if self.kitty.poll() is None:
            self.rc("close-window")
            try:
                self.kitty.wait(3)
            except subprocess.TimeoutExpired:
                self.kitty.terminate()
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
        # New OS windows take keyboard focus: clear anything typed into it meanwhile.
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
