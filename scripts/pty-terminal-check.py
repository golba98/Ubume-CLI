#!/usr/bin/env python3
"""Compatibility module: `bench/resize.py` and `check-permission-pty.py` load this path for
`Screen`, and running it still runs the check.

The check now lives in `testing/check-terminal-pty.py`. Remove this file once those scripts load
the new path.
"""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    "check_terminal_pty", pathlib.Path(__file__).resolve().parent / "testing" / "check-terminal-pty.py"
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
Screen = _module.Screen

if __name__ == "__main__":
    raise SystemExit(_module.main())
