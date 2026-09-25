"""Real system capture through the real pipeline. Needs music playing and capture permission.

uv run pytest -m live -s   (prints the measured numbers)
"""

import threading
import time

import numpy as np
import pytest

from tidalviz.capture import CatapSystemSource
from tidalviz.frame import SCALAR_INDEX
from tidalviz.pipeline import AudioPipeline
from tidalviz.transport.frame import decode

pytestmark = pytest.mark.live

S = SCALAR_INDEX


def test_live_system_capture_through_the_pipeline():
    frames: list[bytes] = []
    lock = threading.Lock()

    def publish(data: bytes) -> None:
        with lock:
            frames.append(data)

    statuses: list[tuple[str, str]] = []
    pipe = AudioPipeline(CatapSystemSource(), publish, on_status=lambda *a: statuses.append(a))
    pipe.start()
    try:
        # catap's first start can take ~2 s, and its first buffers may be zeros.
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            with lock:
                if any(not decode(d).silent for d in frames[-5:]):
                    break
            time.sleep(0.05)
        with lock:
            assert frames, f"no frames from system capture; statuses: {statuses}"
            frames.clear()
        time.sleep(3.0)
        stats = pipe.stats()
    finally:
        pipe.stop()

    decoded = [decode(d) for d in frames]
    n = len(decoded)
    silent = sum(f.silent for f in decoded)
    sc = np.array([f.scalars for f in decoded])
    bands = np.array([f.bands for f in decoded])
    print(
        f"\nlive: {n} frames in 3 s, {silent} silent, rate {decoded[0].sample_rate:.0f} Hz, "
        f"stereo {decoded[0].stereo}\n"
        f"  analysis p50 {stats.analysis_ms_p50:.3f} ms, p99 {stats.analysis_ms_p99:.3f} ms; "
        f"capture→publish p95 {stats.capture_to_send_ms_p95:.2f} ms; dropped {stats.dropped_frames}\n"
        f"  rms mean {sc[:, S['rms']].mean():.4f}, bands mean {bands.mean():.2f}, "
        f"bass/mid/treb mean {sc[:, S['bass']].mean():.2f}/{sc[:, S['mid']].mean():.2f}/"
        f"{sc[:, S['treb']].mean():.2f}, onsets {sum(f.onset for f in decoded)}, "
        f"bpm {sc[-1, S['bpm']]:.1f}, centroid {sc[:, S['centroid']].mean():.3f}"
    )
    assert 250 <= n <= 300  # 93.75 frames/s at 48 kHz
    assert silent < 0.2 * n, "capture is silent: is music playing and permission granted?"
    assert np.all((bands >= 0) & (bands <= 1)) and 0.05 < bands.mean() < 0.95
    assert np.all(np.isfinite(sc))
    assert np.all((sc[:, S["rms"]] >= 0) & (sc[:, S["peak"]] <= 1.5))
    for name in ("bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt"):
        assert np.all((sc[:, S[name]] >= 0) & (sc[:, S[name]] <= 10)), name
    for name in ("centroid", "flux", "onsetStrength", "beatPhase"):
        assert np.all((sc[:, S[name]] >= 0) & (sc[:, S[name]] <= 1)), name
    assert stats.analysis_ms_p99 < 1.0
    assert stats.capture_to_send_ms_p95 < 15.0
