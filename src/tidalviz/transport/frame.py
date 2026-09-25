"""Binary frame v1 codec (docs/protocols.md §1)."""

import struct

import numpy as np

from tidalviz.frame import F32, AudioFrame

MAGIC: int = struct.unpack("<I", b"TVZ1")[0]
VERSION = 1
FLAG_ONSET, FLAG_SILENT, FLAG_STEREO = 1, 2, 4

_HEADER = struct.Struct("<IHHIfd4H")  # 32 bytes; every array after it is 4-byte aligned
assert _HEADER.size == 32


def encode(frame: AudioFrame) -> bytes:
    flags = (
        (FLAG_ONSET if frame.onset else 0)
        | (FLAG_SILENT if frame.silent else 0)
        | (FLAG_STEREO if frame.left is not None else 0)
    )
    header = _HEADER.pack(
        MAGIC, VERSION, flags, frame.index & 0xFFFFFFFF, frame.sample_rate, frame.host_time,
        frame.bands.size, frame.spectrum.size, frame.waveform.size, frame.scalars.size,
    )  # fmt: skip
    parts: list[bytes | F32] = [header, frame.scalars, frame.bands, frame.spectrum, frame.waveform]
    if frame.left is not None and frame.right is not None:
        parts += [frame.left, frame.right]
    # float32 arrays are little-endian on every supported Mac, so the buffers go in as-is.
    return b"".join(parts)


def decode(data: bytes) -> AudioFrame:
    magic, version, flags, index, rate, t, nb, ns, nw, nc = _HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise ValueError(f"bad magic {data[:4]!r}")
    if version != VERSION:
        raise ValueError(f"unsupported frame version {version}")
    off = _HEADER.size

    def take(n: int) -> F32:
        nonlocal off
        arr = np.frombuffer(data, dtype="<f4", count=n, offset=off).astype(np.float32)
        off += 4 * n
        return arr

    scalars, bands, spectrum, waveform = take(nc), take(nb), take(ns), take(nw)
    stereo = bool(flags & FLAG_STEREO)
    left = take(nw) if stereo else None
    right = take(nw) if stereo else None
    return AudioFrame(
        index=index, sample_rate=rate, host_time=t,
        onset=bool(flags & FLAG_ONSET), silent=bool(flags & FLAG_SILENT),
        scalars=scalars, bands=bands, spectrum=spectrum, waveform=waveform, left=left, right=right,
    )  # fmt: skip
