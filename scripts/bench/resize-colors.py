#!/usr/bin/env python3
"""Verify complete PTY history replay at every supported ANSI color depth."""
import json, pathlib, re, sys
import resize

original = resize.Sandbox
output = resize.REPO / 'docs/_reports/reliability/resize-validation-2026-10-22/colors'
for name, flags in [('plain', {'NO_COLOR':'1','FORCE_COLOR':'0'}), ('ansi16', {'TERM':'xterm','FORCE_COLOR':'1'}), ('ansi256', {'FORCE_COLOR':'2'}), ('truecolor', {'COLORTERM':'truecolor','FORCE_COLOR':'3'})]:
    if len(sys.argv)>1 and name!=sys.argv[1]:continue
    class ColorSandbox(original):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.env.update(flags)
    resize.Sandbox = ColorSandbox
    try:
        resize.run(resize.REPO, 'history', 1, 1, output / name, 30, True, 4)
        records = [json.loads(line) for line in (output / name / 'history-1.cast').read_text().splitlines()[1:]]
        text = ''.join(record[2] for record in records if record[1] == 'o')
        replay = text[text.rfind('\x1b[3J'):]
        assert all(replay.count(f'HISTORY_ANSWER_{i:04}') == 1 for i in range(30))
        if name == 'plain': assert not re.search(r'\x1b\[(?:3\d|4\d|9\d|10\d)(?:;|m)', replay)
        if name == 'ansi16': assert not re.search(r'\x1b\[(?:38|48);', replay) and re.search(r'\x1b\[(?:3\d|9\d)m', replay)
        if name == 'ansi256': assert '\x1b[38;5;' in replay and '\x1b[38;2;' not in replay
        if name == 'truecolor': assert '\x1b[38;2;' in replay
        print('PASS '+name+': complete historical replay and matching terminal color depth', flush=True)
    finally:
        resize.Sandbox = original
