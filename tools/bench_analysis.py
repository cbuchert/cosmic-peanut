"""Analysis cost per frame (budget: < 1 ms p99, stereo 48 kHz).

uv run python -m tools.bench_analysis [--frames N] [--fft 2048|4096]
"""

import argparse
import time

import numpy as np

from tidalviz.analysis import AnalysisSettings, Analyzer
from tidalviz.capture.ring import RingBuffer
from tidalviz.capture.synthetic import SyntheticSource


def measure(frames: int, fft_size: int = 2048, warmup: int = 300) -> np.ndarray:
    """Per-frame Analyzer.process time in µs, stereo 48 kHz demo input, after warm-up."""
    src = SyntheticSource("demo", sample_rate=48000.0, channels=2)
    settings = AnalysisSettings(fft_size=fft_size)
    ring = RingBuffer(capacity=16384, channels=2)
    an = Analyzer(48000.0, 2, settings)
    blocks = [src.render(settings.hop) for _ in range(warmup + frames)]
    out = np.zeros(frames)
    for i, block in enumerate(blocks):
        ring.write(block, 0.0)
        t0 = time.perf_counter_ns()
        an.process(ring, ring.written / 48000.0)
        dt = time.perf_counter_ns() - t0
        if i >= warmup:
            out[i - warmup] = dt / 1000.0
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--frames", type=int, default=3000)
    ap.add_argument("--fft", type=int, default=0, help="2048 or 4096 (default: both)")
    args = ap.parse_args()
    for fft in (args.fft,) if args.fft else (2048, 4096):
        us = measure(args.frames, fft)
        p50, p99, mx = np.percentile(us, 50), np.percentile(us, 99), us.max()
        print(
            f"fft {fft}: {args.frames} frames  p50 {p50:.0f} µs  p99 {p99:.0f} µs  "
            f"max {mx:.0f} µs  (budget 1000 µs)"
        )


if __name__ == "__main__":
    main()
