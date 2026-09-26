import numpy as np

from tidalviz.analysis import AnalysisSettings
from tidalviz.capture.synthetic import SyntheticSource
from tidalviz.frame import SCALAR_INDEX

from .test_analysis_helpers import frames

S = SCALAR_INDEX


def last(src: SyntheticSource, seconds: float, settings: AnalysisSettings | None = None):
    *_, f = frames(src, seconds, settings)
    return f


def test_1khz_sine_peaks_in_its_spectrum_bin_and_band():
    f = last(SyntheticSource("sine1k"), 1.0)
    # 2048-point FFT at 48 kHz: bin k is k * 23.4375 Hz, so 1 kHz is bin 42.67 → 43 (or 42).
    assert int(np.argmax(f.spectrum)) in (42, 43)
    edges = np.geomspace(30.0, 16000.0, 65)
    band = int(np.searchsorted(edges, 1000.0)) - 1
    assert int(np.argmax(f.bands)) == band
    assert f.bands[band] > 0.5
    far = np.r_[0 : band - 3, band + 4 : 64]
    assert np.all(f.bands[far] < 0.5 * f.bands[band])


def test_silence_is_flagged_and_reads_zero():
    f = last(SyntheticSource("silence"), 0.5)
    assert f.silent
    assert f.scalars[S["rms"]] == 0.0 and f.scalars[S["peak"]] == 0.0
    assert np.all(f.bands == 0.0) and np.all(f.spectrum == 0.0)


def test_level_reports_raw_rms_and_peak_of_the_newest_hop():
    f = last(SyntheticSource("sine1k"), 0.2)
    assert not f.silent
    assert abs(f.scalars[S["rms"]] - 0.5 / np.sqrt(2)) < 0.01
    assert abs(f.scalars[S["peak"]] - 0.5) < 0.01


def test_waveform_is_the_newest_2048_samples_with_stereo_planes():
    src = SyntheticSource("sine1k", channels=2)
    f = last(src, 0.1)
    n = src.position
    t = np.arange(n - 2048, n) / 48000.0
    expected = 0.5 * np.sin(2 * np.pi * 1000.0 * t)
    np.testing.assert_allclose(f.waveform, expected, atol=1e-5)
    assert f.left is not None and f.right is not None
    np.testing.assert_allclose(f.left, expected, atol=1e-5)
    np.testing.assert_allclose(f.right, expected, atol=1e-5)


def test_mono_source_has_no_stereo_planes():
    f = last(SyntheticSource("sine1k", channels=1), 0.1)
    assert f.left is None and f.right is None and not f.stereo


def test_fft_4096_still_yields_1024_bins_at_half_the_resolution():
    f = last(SyntheticSource("sine1k"), 1.0, AnalysisSettings(fft_size=4096))
    # 4096-point bins are 11.72 Hz; folded pairwise → 23.44 Hz per output bin again.
    assert f.spectrum.shape == (1024,)
    assert int(np.argmax(f.spectrum)) in (42, 43)


def test_auto_gain_lifts_a_quiet_signal_toward_a_normal_level():
    quiet = SyntheticSource("demo")
    loud_frames = list(np.array(f.bands) for f in frames(SyntheticSource("demo"), 6.0))
    orig = quiet.render
    quiet.render = lambda n: orig(n) * 0.05  # type: ignore[method-assign]  # −26 dB
    quiet_frames = list(np.array(f.bands) for f in frames(quiet, 6.0))
    loud = np.mean(loud_frames[-200:])
    q = np.mean(quiet_frames[-200:])
    assert abs(q - loud) < 0.05  # normalized away

    off = AnalysisSettings(auto_gain=False)
    quiet2 = SyntheticSource("demo")
    orig2 = quiet2.render
    quiet2.render = lambda n: orig2(n) * 0.05  # type: ignore[method-assign]
    raw = np.mean([np.array(f.bands) for f in frames(quiet2, 6.0, off)][-200:])
    assert raw < q - 0.2  # without auto gain the quiet track stays dim


def test_bass_mid_treb_average_about_one_on_steady_music_like_input():
    names = ("bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt")
    rows = [[f.scalars[S[n]] for n in names] for f in frames(SyntheticSource("demo"), 12.0)]
    tail = np.array(rows[-int(6 * 93.75) :])  # last 6 s, after the averages settle
    means = tail.mean(axis=0)
    assert np.all(np.abs(means - 1.0) < 0.15), dict(zip(names, means, strict=True))
    assert tail[:, 0].max() > 1.3  # the kick pushes bass well above average
    assert tail[:, 0].min() < 0.8
    # *Att is smoother than the immediate value
    assert np.std(np.diff(tail[:, 3])) < 0.5 * np.std(np.diff(tail[:, 0]))


def test_bass_mid_treb_are_zero_in_silence():
    f = last(SyntheticSource("silence"), 1.0)
    for n in ("bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt"):
        assert f.scalars[S[n]] == 0.0


def onset_times(src: SyntheticSource, seconds: float) -> list[float]:
    """Estimated onset times: host_time (end of the newest sample) minus onsetAge."""
    return [f.host_time - float(f.scalars[S["onsetAge"]]) for f in frames(src, seconds) if f.onset]


def test_onsets_fire_once_per_click_with_under_10ms_error():
    # Error = |estimated onset time − true click time|, where the true time of click sample c
    # is c / sr on the same clock as host_time (sample i ends at (i + 1) / sr; see helper).
    # Every click must be detected exactly once, with no extra onsets.
    src = SyntheticSource("click120")
    detected = onset_times(src, 8.0)
    clicks = [c / 48000.0 for c in src.click_positions(src.position - 2048)]
    assert len(detected) == len(clicks), (detected, clicks)
    errors = [abs(d - c) for d, c in zip(detected, clicks, strict=True)]
    assert max(errors) < 0.010, errors


def test_onsets_catch_every_kick_in_music_like_input():
    src = SyntheticSource("demo")
    detected = np.array(onset_times(src, 8.0))
    kicks = np.arange(0, src.position - 2048, src.beat_period)[1:] / 48000.0
    for k in kicks:
        assert np.min(np.abs(detected - k)) < 0.010, k
    assert len(detected) < 4 * len(kicks)  # kick, snare, hats — not a stream of false hits


def tempo_track(kind: str, seconds: float) -> tuple[SyntheticSource, np.ndarray]:
    src = SyntheticSource(kind)
    rows = [
        (f.host_time, f.scalars[S["bpm"]], f.scalars[S["beatPhase"]]) for f in frames(src, seconds)
    ]
    return src, np.array(rows, dtype=np.float64)


def test_120bpm_click_track_reads_120_plus_minus_1_within_8_seconds():
    _, rows = tempo_track("click120", 8.0)
    assert rows[0, 1] == 0.0  # 0 until confident
    assert abs(rows[-1, 1] - 120.0) <= 1.0
    confident = rows[rows[:, 1] > 0]
    assert len(confident) > 0
    # once confident it stays on tempo (no octave jumps)
    assert np.all(np.abs(confident[:, 1] - 120.0) <= 1.0)


def test_music_like_input_reads_120_bpm_within_8_seconds():
    _, rows = tempo_track("demo", 8.0)
    assert abs(rows[-1, 1] - 120.0) <= 1.0


def test_beat_phase_is_zero_until_confident_then_advances_steadily_and_lands_on_clicks():
    src, rows = tempo_track("click120", 10.0)
    assert np.all(rows[rows[:, 1] == 0, 2] == 0.0)
    locked = rows[rows[:, 1] > 0]
    tail = locked[len(locked) // 3 :]  # give the phase lock a moment
    step = np.mod(np.diff(tail[:, 2]), 1.0)
    expected = (512 / 48000.0) / 0.5  # one hop is 2.13% of a beat at 120 BPM
    assert np.mean(np.abs(step - expected) < 0.005) > 0.95
    # on the frame just after each click, the phase says "the beat was (host_time − click) ago"
    for c in src.click_positions(src.position):
        t = c / 48000.0
        after = tail[tail[:, 0] >= t]
        if t < tail[0, 0] or len(after) == 0:
            continue
        host, _, phase = after[0]
        want = (host - t) / 0.5
        d = abs((phase - want + 0.5) % 1.0 - 0.5)
        assert d < 0.04, (t, phase, want)  # 0.04 of a beat = 20 ms


def test_centroid_of_a_1khz_sine_is_1khz_over_nyquist():
    f = last(SyntheticSource("sine1k"), 0.5)
    assert abs(f.scalars[S["centroid"]] - 1000.0 / 24000.0) < 0.005


def test_centroid_is_zero_in_silence_and_brighter_for_noise():
    assert last(SyntheticSource("silence"), 0.3).scalars[S["centroid"]] == 0.0
    f = last(SyntheticSource("click120"), 0.27)  # right after the first (broadband) click
    assert f.scalars[S["centroid"]] > 0.2


def test_flux_is_near_zero_for_a_steady_tone_and_jumps_on_a_click():
    f = last(SyntheticSource("sine1k"), 0.5)
    assert f.scalars[S["flux"]] < 0.05
    fl = [float(f.scalars[S["flux"]]) for f in frames(SyntheticSource("demo"), 4.0)]
    assert max(fl) <= 1.0 and min(fl) >= 0.0
    assert max(fl) > 0.3


def test_default_extractors_cover_every_named_scalar_and_frame_array():
    from tidalviz.analysis import Analyzer
    from tidalviz.frame import SCALAR_NAMES

    an = Analyzer(48000.0, 2)
    declared = {name for ex in an.extractors for name in ex.fields}
    named = {n for n in SCALAR_NAMES if not n.startswith("reserved")}
    assert named <= declared
    assert {"bands", "spectrum", "waveform", "left", "right", "onset", "silent"} <= declared


def test_analyzer_reuses_one_frame_and_runs_custom_extractors_in_order():
    from tidalviz.analysis import AnalysisContext, Analyzer
    from tidalviz.capture.ring import RingBuffer
    from tidalviz.frame import AudioFrame

    calls: list[str] = []

    class Mark:
        def __init__(self, name: str) -> None:
            self.name = name
            self.fields: tuple[str, ...] = ()

        def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
            calls.append(self.name)

    an = Analyzer(48000.0, 1, extractors=[Mark("a"), Mark("b")])
    ring = RingBuffer(4096, 1)
    f1 = an.process(ring, 1.0)
    f2 = an.process(ring, 2.0)
    assert f1 is f2 and f2.index == 1 and f2.host_time == 2.0
    assert calls == ["a", "b", "a", "b"]


def test_hot_path_allocates_nothing_per_frame_beyond_small_scalars():
    import tracemalloc

    from tidalviz.analysis import Analyzer
    from tidalviz.capture.ring import RingBuffer

    src = SyntheticSource("demo")
    an = Analyzer(48000.0, 2)
    ring = RingBuffer(16384, 2)
    blocks = [src.render(512) for _ in range(400)]
    for b in blocks[:300]:  # warm up past tempo lock (its one-time comb allocates)
        ring.write(b, 0.0)
        an.process(ring, ring.written / 48000.0)
    tracemalloc.start()
    base, _ = tracemalloc.get_traced_memory()
    for b in blocks[300:]:
        ring.write(b, 0.0)
        an.process(ring, ring.written / 48000.0)
    cur, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert cur - base < 4096  # nothing retained
    assert peak - base < 16384  # no per-frame arrays (a 2048-sample float32 array is 8 KB)


def test_bass_mid_treb_are_near_one_from_the_first_seconds():
    # The long-term average starts as a running mean, so the first seconds after a (re)start
    # aren't biased by whatever the very first frame happened to contain.
    names = ("bass", "mid", "treb")
    rows = np.array(
        [[f.scalars[S[n]] for n in names] for f in frames(SyntheticSource("demo"), 2.0)]
    )
    means = rows.mean(axis=0)
    assert np.all(np.abs(means - 1.0) < 0.2), means
