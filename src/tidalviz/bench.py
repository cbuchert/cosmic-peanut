"""Benchmark mode: aggregate the shell's perf reports and host stats into one JSON report.

uv run tidalviz --bench builtin/orbit --seconds 60 --source synthetic:demo --out bench.json
uv run python -m tools.check_bench baseline.json bench.json   # fails on a >10% regression
"""

from statistics import fmean
from typing import Any

HIGHER_IS_BETTER = frozenset({"fpsMin", "fpsMean"})
TOLERANCE = 0.10


class BenchRecorder:
    """Collects `perf` (per visualizer, 1/s) and `stats` (host, 1/s) control messages."""

    def __init__(self, key: str, warmup_reports: int = 2) -> None:
        self.key = key
        self._warmup = warmup_reports
        self._perf: list[dict[str, Any]] = []
        self._stats: list[dict[str, Any]] = []

    def add(self, msg: dict[str, Any]) -> None:
        if msg["type"] == "perf" and msg["key"] == self.key:
            if self._warmup > 0:
                self._warmup -= 1
            else:
                self._perf.append(msg)
        elif msg["type"] == "stats":
            self._stats.append(msg)

    def report(self) -> dict[str, Any]:
        p, s = self._perf, self._stats
        frames = sum(m["fps"] for m in p)
        latency = [m["latencyMsP95"] for m in s if "latencyMsP95" in m]
        return {
            "key": self.key,
            "reports": len(p),
            "fpsMin": min((m["fps"] for m in p), default=0),
            "fpsMean": fmean(m["fps"] for m in p) if p else 0,
            "frameMsP50Mean": fmean(m["frameMsP50"] for m in p) if p else 0,
            "frameMsP99Max": max((m["frameMsP99"] for m in p), default=0),
            "pluginMsP50Mean": fmean(m["pluginMsP50"] for m in p) if p else 0,
            "shellMsMean": fmean(m["shellMs"] for m in p) if p else 0,
            "droppedPct": 100 * sum(m["dropped"] for m in p) / frames if frames else 0,
            "hostCpuMean": fmean(m["hostCpu"] for m in s) if s else 0,
            "rssMbMax": max((m["rssMb"] for m in s), default=0),
            "analysisMsP50Mean": fmean(m["analysisMsP50"] for m in s) if s else 0,
            "captureToSendMsP95Max": max((m["captureToSendMsP95"] for m in s), default=0),
            "latencyMsP95Max": max(latency, default=None),
        }


def compare(base: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """Metric names that got more than 10% worse than the baseline."""
    worse: list[str] = []
    for name, b in base.items():
        n = new.get(name)
        if not isinstance(b, int | float) or not isinstance(n, int | float) or b == 0:
            continue
        change = (n - b) / abs(b)
        if (change < -TOLERANCE) if name in HIGHER_IS_BETTER else (change > TOLERANCE):
            worse.append(name)
    return worse
