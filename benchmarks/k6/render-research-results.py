"""Print the measured report produced by analyze-results.py."""
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('Usage: python render-research-results.py RESULTS_DIR')
report = Path(sys.argv[1]) / 'report.md'
if not report.is_file():
    raise SystemExit('Run analyze-results.py first')
print(report.read_text(encoding='utf-8'))
