import numpy as np

from tools.beat_eval import beats_from_phase


def test_beats_from_phase_places_each_wrap_at_its_exact_crossing_and_skips_no_tempo():
    fps = 48000 / 512
    t = np.arange(600) / fps
    bpm = np.full(t.size, 120.0)
    bpm[:100] = 0.0  # not confident yet: no beats
    phase = np.where(bpm > 0, (t / 0.5 + 0.3) % 1.0, 0.0)
    beats = beats_from_phase(t, bpm, phase)
    # Phase 0 falls at t = 0.5·k − 0.15; the first wrap after frame 100 (t ≈ 1.07) is at 1.35.
    expected = np.arange(1.35, t[-1], 0.5)
    np.testing.assert_allclose(beats, expected, atol=1e-6)
