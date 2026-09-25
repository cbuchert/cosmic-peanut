import numpy as np

from tidalviz.capture.synthetic import SyntheticSource


def test_sine1k_render_is_a_1khz_sine_on_every_channel():
    src = SyntheticSource("sine1k", sample_rate=48000.0, channels=2)
    a = src.render(480)
    b = src.render(480)  # continues where the first call stopped
    x = np.concatenate([a, b])
    assert x.shape == (960, 2) and x.dtype == np.float32
    t = np.arange(960) / 48000.0
    expected = 0.5 * np.sin(2 * np.pi * 1000.0 * t)
    np.testing.assert_allclose(x[:, 0], expected, atol=1e-5)
    np.testing.assert_allclose(x[:, 1], expected, atol=1e-5)


def test_click120_places_clicks_exactly_every_half_second():
    src = SyntheticSource("click120", sample_rate=48000.0, channels=1)
    x = src.render(48000 * 3)[:, 0]
    clicks = src.click_positions(48000 * 3)
    assert len(clicks) == 6
    assert np.all(np.diff(clicks) == 24000)
    for c in clicks:
        assert np.abs(x[c]) > 0.3  # the click starts on its sample
        assert np.all(x[c - 200 : c] == 0.0)  # silence right before it
    assert np.max(np.abs(x)) <= 1.0


def test_thread_emits_512_frame_blocks_paced_by_the_monotonic_clock():
    import threading
    import time

    src = SyntheticSource("sine1k", sample_rate=48000.0, channels=2)
    blocks: list[tuple[tuple[int, ...], float]] = []
    enough = threading.Event()

    def on_samples(x: np.ndarray, t: float) -> None:
        blocks.append((x.shape, t))
        if len(blocks) == 20:
            enough.set()

    t0 = time.monotonic()
    src.start(on_samples)
    assert enough.wait(2.0)
    src.stop()
    elapsed = blocks[19][1] - t0
    assert all(shape == (512, 2) for shape, _ in blocks)
    # 20 blocks of 512 at 48 kHz = 213 ms of audio; paced, not a burst.
    assert 0.18 < elapsed < 0.35
    times = [t for _, t in blocks]
    assert times == sorted(times)
    n = len(blocks)
    time.sleep(0.05)
    assert len(blocks) == n  # stopped


def test_non_realtime_mode_emits_as_fast_as_possible():
    import threading

    src = SyntheticSource("silence", channels=1, realtime=False)
    count = [0]
    done = threading.Event()

    def on_samples(x: np.ndarray, t: float) -> None:
        count[0] += 1
        if count[0] == 500:  # 5.3 s of audio
            done.set()

    src.start(on_samples)
    assert done.wait(1.0)
    src.stop()


def test_demo_is_music_like_and_bounded():
    src = SyntheticSource("demo", channels=2)
    x = src.render(48000 * 4)
    assert np.max(np.abs(x)) < 1.0
    rms = float(np.sqrt(np.mean(x**2)))
    assert 0.05 < rms < 0.5
    # beats: energy right after each beat start is higher than just before it
    for b in range(1, 8):
        s = b * src.beat_period
        assert np.sum(x[s : s + 2400, 0] ** 2) > 2 * np.sum(x[s - 2400 : s, 0] ** 2)
