"""Analyzer contract tests with synthetic measurements; no benchmark processes run."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


class AnalyzerTest(unittest.TestCase):
    def test_all_case_report_preserves_each_supported_case_and_small_sample_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runner = root / "perf" / "phase1_1" / "analyze.py"
            runner.parent.mkdir(parents=True)
            shutil.copyfile(pathlib.Path(__file__).with_name("analyze.py"), runner)
            reports = root / "docs" / "_reports" / "performance" / "phase1_1"
            destination = reports / "final" / "all.json"
            destination.parent.mkdir(parents=True)
            destination.write_text(json.dumps({"results": {
                "startup": [{"scenario": "startup", "composerVisibleMs": 12, "helpVisibleMs": 20}],
                "throughput": [[{"kind": "ascii", "wallMs": 3}, {"kind": "utf8", "wallMs": 5}]],
            }}))
            subprocess.run([sys.executable, str(runner)], check=True, capture_output=True)
            summary = json.loads((reports / "summary.json").read_text())
            startup = summary["final/startup"]["startup"]["composerVisibleMs"]
            self.assertEqual(startup["n"], 1)
            self.assertEqual(startup["p50"], 12)
            self.assertNotIn("p95", startup)
            self.assertEqual(summary["final/throughput"]["utf8"]["p50"], 5)


if __name__ == "__main__":
    unittest.main()
