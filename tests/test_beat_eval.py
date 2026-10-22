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


def test_beats_from_phase_drops_a_wrap_that_lands_before_the_previous_beat():
    # A beat at 0.05, then a big phase correction back to 0.95 and a wrap to 0.3 at t = 0.3:
    # that crossing (0.3 − 0.3 s = 0.0) is before the beat already reported, so it is dropped.
    t = np.array([0.0, 0.1, 0.2, 0.3, 0.4])
    bpm = np.full(5, 60.0)
    phase = np.array([0.9, 0.05, 0.95, 0.3, 0.4])
    np.testing.assert_allclose(beats_from_phase(t, bpm, phase), [0.05])
