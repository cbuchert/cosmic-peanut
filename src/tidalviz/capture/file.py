"""WAV file source (16-bit PCM or 32-bit float), looped, for tests and demos.

Python 3.12's ``wave`` module rejects IEEE-float WAVs, so this reads the RIFF chunks directly.
"""

import struct
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from tidalviz.capture.paced import PacedSource
from tidalviz.frame import F32

_PCM, _FLOAT, _EXTENSIBLE = 1, 3, 0xFFFE


def read_wav(path: str | Path) -> tuple[F32, float]:
    """Return (samples (n, channels) float32 in −1..1, sample rate)."""
    raw = Path(path).read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError(f"{path}: not a RIFF/WAVE file")
    fmt: tuple[int, int, int, int] | None = None  # tag, channels, rate, bits
    data: bytes | None = None
    off = 12
    while off + 8 <= len(raw):
        cid, size = raw[off : off + 4], struct.unpack_from("<I", raw, off + 4)[0]
        body = raw[off + 8 : off + 8 + size]
        if cid == b"fmt ":
            tag, ch, rate, _, _, bits = struct.unpack_from("<HHIIHH", body)
            if tag == _EXTENSIBLE and len(body) >= 26:
                tag = struct.unpack_from("<H", body, 24)[0]  # first 2 bytes of SubFormat GUID
            fmt = (tag, ch, rate, bits)
        elif cid == b"data":
            data = body
        off += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise ValueError(f"{path}: missing fmt or data chunk")
    tag, ch, rate, bits = fmt
    if tag == _PCM and bits == 16:
        pcm = np.frombuffer(data, dtype="<i2", count=len(data) // 2).astype(np.float32)
        pcm /= 32768.0
    elif tag == _FLOAT and bits == 32:
        pcm = np.frombuffer(data, dtype="<f4", count=len(data) // 4).astype(np.float32)
    else:
        raise ValueError(f"{path}: unsupported WAV format (tag {tag}, {bits} bits)")
    frames = pcm.size // ch
    return pcm[: frames * ch].reshape(frames, ch), float(rate)


class FileSource(PacedSource):
    def __init__(self, path: str | Path, *, realtime: bool = True) -> None:
        data, rate = read_wav(path)
        if data.shape[0] == 0:
            raise ValueError(f"{path}: no audio frames")
        super().__init__(rate, data.shape[1], realtime=realtime)
        self.name = Path(path).name
        self._data = data

    def _generate(self, i: NDArray[np.int64]) -> F32:
        return self._data[i % self._data.shape[0]]
