"""Fail when a benchmark report regresses more than 10% from a stored baseline.

uv run python -m tools.check_bench baselines/orbit.json bench.json
"""

import json
import sys
from pathlib import Path

from tidalviz.bench import compare


def main(argv: list[str]) -> int:
    base, new = (json.loads(Path(p).read_text()) for p in argv[:2])
    worse = compare(base, new)
    for name in worse:
        print(f"REGRESSION {name}: {base[name]} -> {new[name]}")
    if not worse:
        print("bench OK: no metric regressed more than 10%")
    return 1 if worse else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
