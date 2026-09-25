"""Preallocated single-producer / single-consumer PCM ring buffer (docs/protocols.md §2).

Index based (no ``np.roll``): a write is one copy into the preallocated array, ``latest`` is one
copy out into a caller-owned array. A condition variable lets the consumer sleep until enough
samples have arrived, so analysis is driven by sample arrival rather than a timer.
"""

import threading

import numpy as np

from tidalviz.frame import F32


class RingBuffer:
    def __init__(self, capacity: int, channels: int) -> None:
        self.capacity = capacity
        self.channels = channels
        self._buf: F32 = np.zeros((capacity, channels), dtype=np.float32)
        self._cond = threading.Condition()
        self.written = 0  # total frames ever written
        self.newest_time = 0.0  # host monotonic time of the newest frame

    def write(self, block: F32, t_last: float) -> None:
        """Copy ``block`` (n, channels) in; ``t_last`` is the host time of its last frame."""
        n = block.shape[0]
        with self._cond:
            if n > self.capacity:
                self.written += n - self.capacity
                block = block[n - self.capacity :]
                n = self.capacity
            start = self.written % self.capacity
            first = min(n, self.capacity - start)
            self._buf[start : start + first] = block[:first]
            if first < n:
                self._buf[: n - first] = block[first:]
            self.written += n
            self.newest_time = t_last
            self._cond.notify_all()

    def latest(self, n: int, out: F32) -> None:
        """Copy the newest ``n`` frames (oldest first) into ``out`` (n, channels)."""
        with self._cond:
            end = self.written % self.capacity
            start = end - n
            if start >= 0:
                out[:] = self._buf[start:end]
            else:
                out[:-start] = self._buf[start:]
                out[-start:] = self._buf[:end]

    def wait_for(self, total: int, timeout: float) -> bool:
        """Block until ``written >= total`` (True) or ``timeout`` / ``wake()`` (False)."""
        with self._cond:
            if self.written < total:
                self._cond.wait(timeout)
            return self.written >= total

    def wake(self) -> None:
        """Release any waiter early (used on stop / source switch)."""
        with self._cond:
            self._cond.notify_all()
