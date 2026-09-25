import numpy as np
import pytest

from tools.bench_analysis import measure

pytestmark = pytest.mark.perf  # wall-clock sensitive; non-blocking in CI


def test_analysis_p99_is_under_1ms_per_frame_for_stereo_48k():
    us = measure(frames=400)
    assert np.percentile(us, 99) < 1000.0, f"p50 {np.median(us):.0f} µs"
