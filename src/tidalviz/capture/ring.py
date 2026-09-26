"""Preallocated single-producer / single-consumer PCM ring buffer (docs/protocols.md §2).

Planar and mirrored: every frame is stored twice, at ``slot`` and ``slot + capacity``, so the
newest ``n`` frames are always one contiguous slice per channel. ``view`` hands the analyzer
that slice with no copy and no lock (the writer only ever writes *after* the newest frame, so a
view stays intact until ``capacity − n`` more frames arrive, about a second). A write costs two
small copies instead of one; the analysis side, which runs cold every hop, saves a lock and a
window-sized copy. A condition variable lets the consumer sleep until enough samples have
arrived, so analysis is driven by sample arrival rather than a timer.
"""

import threading

import numpy as np

from tidalviz.frame import F32


class RingBuffer:
    def __init__(self, capacity: int, channels: int) -> None:
        self.capacity = capacity
        self.channels = channels
        self._buf: F32 = np.zeros((channels, 2 * capacity), dtype=np.float32)
        self._cond = threading.Condition()
        self.written = 0  # total frames ever written
        self.newest_time = 0.0  # host monotonic time of the newest frame

    def write(self, block: F32, t_last: float) -> None:
        """Copy ``block`` (n, channels) in; ``t_last`` is the host time of its last frame."""
        n = block.shape[0]
        cap = self.capacity
        if n > cap:
            with self._cond:
                self.written += n - cap
            block = block[n - cap :]
            n = cap
        src = block.T
        buf = self._buf
        start = self.written % cap
        buf[:, start : start + n] = src  # may run past `cap`: that is those frames' mirror slot
        first = min(n, cap - start)
        buf[:, start + cap : start + cap + first] = src[:, :first]
        if first < n:
            buf[:, : n - first] = src[:, first:]
        with self._cond:
            self.written += n
            self.newest_time = t_last
            self._cond.notify_all()

    def view(self, n: int) -> F32:
        """The newest ``n`` frames (oldest first) as a (channels, n) view; ``n <= capacity``.

        Rows are C-contiguous. Valid until ``capacity − n`` more frames are written.
        """
        end = self.written % self.capacity + self.capacity
        return self._buf[:, end - n : end]

    def latest(self, n: int, out: F32) -> None:
        """Copy the newest ``n`` frames (oldest first) into ``out`` (n, channels)."""
        out[:] = self.view(n).T

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
