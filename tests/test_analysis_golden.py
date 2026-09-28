"""Characterization: Analyzer output on fixed synthetic input matches recorded golden values.

Guards speed refactors of the analysis hot path (numeric drift within tolerance only). The
golden file was recorded from the pre-optimization analyzer; regenerate only for an intended
behavior change:

    TVZ_REGEN_GOLDEN=1 uv run pytest tests/test_analysis_golden.py
"""

import os
from pathlib import Path

import numpy as np
import pytest

from tidalviz.analysis import AnalysisSettings, Analyzer
from tidalviz.capture.ring import RingBuffer
from tidalviz.capture.synthetic import SyntheticSource

GOLDEN = Path(__file__).parent / "fixtures" / "analysis_golden.npz"
CASES = {
    # name: (channels, fft_size, seconds, silent seconds [start, end))
    "stereo2048": (2, 2048, 8.0, (4.0, 5.0)),
    "mono4096": (1, 4096, 3.0, (1.0, 1.2)),
}
EVERY = 75  # full arrays (spectrum, waveform) on every 75th frame; scalars/bands on all


def render(name: str) -> dict[str, np.ndarray]:
    channels, fft, seconds, (s0, s1) = CASES[name]
    sr, settings = 48000.0, AnalysisSettings(fft_size=fft)
    src = SyntheticSource("demo", sample_rate=sr, channels=channels)
    ring = RingBuffer(16384, channels)
    an = Analyzer(sr, channels, settings)
    rows: dict[str, list[np.ndarray]] = {k: [] for k in ("scalars", "bands", "flags", "full")}
    for i in range(int(seconds * sr / settings.hop)):
        block = src.render(settings.hop)
        t = ring.written / sr
        if s0 <= t < s1:
            block = np.zeros_like(block)
        ring.write(block, 0.0)
        f = an.process(ring, ring.written / sr)
        rows["scalars"].append(f.scalars.copy())
        rows["bands"].append(f.bands.copy())
        rows["flags"].append(np.array([f.onset, f.silent]))
        if i % EVERY == 0:
            planes = [f.spectrum, f.waveform]
            if f.left is not None and f.right is not None:
                planes += [f.left, f.right]
            rows["full"].append(np.concatenate(planes))
    return {k: np.array(v) for k, v in rows.items()}


@pytest.mark.parametrize("name", list(CASES))
def test_analyzer_output_matches_the_recorded_golden_values(name: str) -> None:
    got = render(name)
    if os.environ.get("TVZ_REGEN_GOLDEN"):
        old = dict(np.load(GOLDEN)) if GOLDEN.exists() else {}
        old.update({f"{name}.{k}": v for k, v in got.items()})
        np.savez_compressed(GOLDEN, **old)
    want = np.load(GOLDEN)
    np.testing.assert_array_equal(got["flags"], want[f"{name}.flags"])  # onsets and silence
    for key in ("scalars", "bands", "full"):
        np.testing.assert_allclose(
            got[key], want[f"{name}.{key}"], rtol=1e-3, atol=2e-4, err_msg=f"{name}.{key}"
        )
