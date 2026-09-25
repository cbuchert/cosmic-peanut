import struct

import numpy as np
import pytest

from tidalviz.frame import SCALAR_NAMES, AudioFrame, new_frame
from tidalviz.transport.frame import MAGIC, decode, encode


def sample_frame(stereo: bool) -> AudioFrame:
    f = new_frame(stereo=stereo)
    f.index = 7
    f.sample_rate = 48000.0
    f.host_time = 1234.5
    f.onset = True
    f.silent = False
    f.scalars[:] = np.arange(16, dtype=np.float32) / 10
    f.bands[:] = np.linspace(0, 1, 64, dtype=np.float32)
    f.spectrum[:] = np.linspace(1, 0, 1024, dtype=np.float32)
    f.waveform[:] = np.sin(np.arange(512, dtype=np.float32) / 10)
    if stereo:
        assert f.left is not None and f.right is not None
        f.left[:] = 0.25
        f.right[:] = -0.25
    return f


def test_scalar_names_follow_contract_order():
    assert SCALAR_NAMES[:13] == (
        "rms",
        "peak",
        "bass",
        "mid",
        "treb",
        "bassAtt",
        "midAtt",
        "trebAtt",
        "onsetStrength",
        "bpm",
        "beatPhase",
        "centroid",
        "flux",
    )
    assert len(SCALAR_NAMES) == 16


def test_header_layout():
    data = encode(sample_frame(stereo=False))
    magic, version, flags, index, rate, t = struct.unpack_from("<IHHIfd", data, 0)
    assert data[:4] == b"TVZ1" and magic == MAGIC
    assert version == 1
    assert flags == 0b001  # onset, not silent, mono
    assert (index, rate, t) == (7, 48000.0, 1234.5)
    assert struct.unpack_from("<4H", data, 24) == (64, 1024, 512, 16)


@pytest.mark.parametrize(("stereo", "size"), [(False, 6496), (True, 10592)])
def test_size_matches_contract(stereo: bool, size: int):
    assert len(encode(sample_frame(stereo))) == size


def test_arrays_are_aligned_and_in_order():
    data = encode(sample_frame(stereo=True))
    off = 32
    for name, n in (
        ("scalars", 16),
        ("bands", 64),
        ("spectrum", 1024),
        ("waveform", 512),
        ("left", 512),
        ("right", 512),
    ):
        assert off % 4 == 0, name
        arr = np.frombuffer(data, dtype="<f4", count=n, offset=off)
        expected = getattr(sample_frame(stereo=True), name)
        np.testing.assert_array_equal(arr, expected, err_msg=name)
        off += 4 * n
    assert off == len(data)


def test_flags_silent_and_stereo():
    f = sample_frame(stereo=True)
    f.onset, f.silent = False, True
    (flags,) = struct.unpack_from("<H", encode(f), 6)
    assert flags == 0b110


@pytest.mark.parametrize("stereo", [False, True])
def test_round_trip(stereo: bool):
    f = sample_frame(stereo)
    g = decode(encode(f))
    assert (g.index, g.sample_rate, g.host_time, g.onset, g.silent) == (
        7,
        48000.0,
        1234.5,
        True,
        False,
    )
    for name in ("scalars", "bands", "spectrum", "waveform"):
        np.testing.assert_array_equal(getattr(g, name), getattr(f, name))
    assert (g.left is None) == (not stereo)


def test_decode_rejects_bad_magic():
    data = bytearray(encode(sample_frame(False)))
    data[0:4] = b"XXXX"
    with pytest.raises(ValueError, match="magic"):
        decode(bytes(data))
