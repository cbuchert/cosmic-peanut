import numpy as np

from tidalviz.capture.ring import RingBuffer


def ramp(start: int, n: int, channels: int = 2) -> np.ndarray:
    col = np.arange(start, start + n, dtype=np.float32)
    return np.stack([col * (c + 1) for c in range(channels)], axis=1)


def test_latest_returns_newest_frames_after_single_write():
    ring = RingBuffer(capacity=16, channels=2)
    ring.write(ramp(0, 10), t_last=1.0)
    out = np.zeros((4, 2), dtype=np.float32)
    ring.latest(4, out)
    np.testing.assert_array_equal(out, ramp(6, 4))


def test_latest_is_correct_across_wraparound():
    ring = RingBuffer(capacity=16, channels=2)
    for start in range(0, 100, 7):
        ring.write(ramp(start, 7), t_last=0.0)
    out = np.zeros((12, 2), dtype=np.float32)
    ring.latest(12, out)
    np.testing.assert_array_equal(out, ramp(105 - 12, 12))
    assert ring.written == 105


def test_block_larger_than_capacity_keeps_its_newest_frames():
    ring = RingBuffer(capacity=8, channels=2)
    ring.write(ramp(0, 3), t_last=0.0)
    ring.write(ramp(3, 20), t_last=0.0)
    out = np.zeros((8, 2), dtype=np.float32)
    ring.latest(8, out)
    np.testing.assert_array_equal(out, ramp(15, 8))


def test_latest_zero_fills_before_enough_samples_arrive():
    ring = RingBuffer(capacity=16, channels=1)
    ring.write(ramp(1, 3, channels=1), t_last=0.0)
    out = np.full((5, 1), 9.0, dtype=np.float32)
    ring.latest(5, out)
    np.testing.assert_array_equal(out[:, 0], [0, 0, 1, 2, 3])


def test_tracks_time_of_newest_sample():
    ring = RingBuffer(capacity=16, channels=1)
    assert ring.newest_time == 0.0
    ring.write(ramp(0, 4, channels=1), t_last=12.5)
    assert ring.newest_time == 12.5


def test_wait_for_wakes_when_a_writer_reaches_the_target():
    import threading

    ring = RingBuffer(capacity=64, channels=1)
    t = threading.Timer(0.01, lambda: ring.write(ramp(0, 8, channels=1), t_last=0.0))
    t.start()
    assert ring.wait_for(8, timeout=2.0)
    t.join()
    assert not ring.wait_for(100, timeout=0.001)
