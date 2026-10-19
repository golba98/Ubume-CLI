"""Summarize calibrated measurements without confusing clock origins or sample counts."""
import json
import math
import pathlib
import statistics
ROOT = pathlib.Path(__file__).resolve().parent

def stats(values):
    ordered = sorted(values)
    if not ordered:
        return {'n': 0}
    result = {'n': len(ordered), 'p50': statistics.median(ordered), 'min': ordered[0], 'max': ordered[-1]}
    if len(ordered) >= 20:
        result['p95'] = ordered[math.ceil(len(ordered) * 0.95) - 1]
    if len(ordered) >= 100:
        result['p99'] = ordered[math.ceil(len(ordered) * 0.99) - 1]
    return {key: round(value, 4) if isinstance(value, float) else value for key, value in result.items()}
summary = {}
for path in sorted((ROOT.parents[1] / 'docs' / '_reports' / 'performance' / 'phase1_1').glob('*/*.json')):
    document = json.loads(path.read_text())
    if 'results' not in document:
        continue
    for case, rows in document['results'].items():
        key = f'{path.parent.name}/{case}'
        result = {}
        if case == 'stream':
            if not rows or 'clockCalibration' not in rows[0]:
                continue
            for scenario in sorted({row['scenario'] for row in rows}):
                selected = [row for row in rows if row['scenario'] == scenario]
                stages = {}
                missing = 0
                emitted_count = 0
                for row in selected:
                    first = {}
                    for record in row['records']:
                        if 'monoNs' not in record:
                            continue
                        stamp = int(record['monoNs'])
                        if 'seq' in record:
                            first.setdefault((record['seq'], record['stage']), stamp)
                        for seq in record.get('fresh', []):
                            first.setdefault((seq, 'write'), stamp)
                    observed = {int(seq): time for seq, time in row['observedNs'].items()}
                    offset = row['clockCalibration']['offsetNs']
                    for seq in {seq for seq, stage in first if stage == 'emit'}:
                        emitted_count += 1
                        if seq not in observed:
                            missing += 1
                            continue
                        first[seq, 'observed'] = observed[seq] - offset
                        for start, end in [('emit', 'handler'), ('handler', 'normalize'), ('normalize', 'schedule'), ('schedule', 'flush'), ('flush', 'reduce'), ('reduce', 'commit'), ('reduce', 'ink'), ('ink', 'write'), ('write', 'observed'), ('emit', 'observed')]:
                            if (seq, start) in first and (seq, end) in first:
                                stages.setdefault(f'{start}_to_{end}_ms', []).append((first[seq, end] - first[seq, start]) / 1000000.0)
                result[scenario] = {'runs': len(selected), 'emitted': emitted_count, 'missing': missing, 'clockUncertaintyUs': max((row['clockCalibration']['roundTripNs'] / 2000 for row in selected)), 'stages': {name: stats(values) for name, values in stages.items()}}
        elif case == 'startup':
            for scenario in sorted({row['scenario'] for row in rows}):
                selected = [row for row in rows if row['scenario'] == scenario]
                result[scenario] = {metric: stats([row[metric] for row in selected if row.get(metric) is not None]) for metric in ['composerVisibleMs', 'helpVisibleMs', 'updateVisibleMs']}
        elif case == 'throughput':
            for kind in ['ascii', 'utf8']:
                result[kind] = stats([case['wallMs'] for row in rows for case in row if case['kind'] == kind])
        elif case == 'shell':
            result = {'wallMs': stats([row['states'][1]['wallMs'] for row in rows]), 'completionRssMiB': stats([row['states'][1]['usage']['rss'] / 1048576 for row in rows])}
        if result:
            summary[key] = result
(ROOT.parents[1] / 'docs' / '_reports' / 'performance' / 'phase1_1').mkdir(parents=True, exist_ok=True)
(ROOT.parents[1] / 'docs' / '_reports' / 'performance' / 'phase1_1' / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
