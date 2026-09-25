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


def test_waveform_is_the_newest_512_samples_with_stereo_planes():
    src = SyntheticSource("sine1k", channels=2)
    f = last(src, 0.1)
    n = src.position
    t = np.arange(n - 512, n) / 48000.0
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
