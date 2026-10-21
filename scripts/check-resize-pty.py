#!/usr/bin/env python3
"""Deterministic functional resize regression; optional benchmarks enforce hardware timing."""
import pathlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parent.parent
for scenario in ('idle','stream','tools','large','approval','history','history-stream','resume','preferences','resume-stream','preferences-stream','suggestions'):
 subprocess.run([sys.executable,str(root/'scripts/bench/resize.py'),'--scenario',scenario,'--functional','--iterations','1','--cycles','1','--output',str(root/'docs/_reports/reliability/resize-validation-2026-10-22')],check=True)
subprocess.run([sys.executable,str(root/'scripts/bench/resize-multi.py')],check=True)
