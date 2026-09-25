import struct
import wave
from pathlib import Path

import numpy as np

from tidalviz.capture.file import FileSource


def write_pcm16(path: Path, x: np.ndarray, rate: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(x.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def write_float32(path: Path, x: np.ndarray, rate: int) -> None:
    ch = x.shape[1]
    data = x.astype("<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, ch, rate, rate * ch * 4, ch * 4, 32)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"LIST" + struct.pack("<I", 4) + b"INFO"  # an extra chunk to skip
    body += b"data" + struct.pack("<I", len(data)) + data
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


def stereo_ramp(n: int) -> np.ndarray:
    a = np.linspace(-0.5, 0.5, n, dtype=np.float32)
    return np.stack([a, -a], axis=1)


def test_reads_16bit_pcm_stereo(tmp_path: Path):
    x = stereo_ramp(1000)
    write_pcm16(tmp_path / "a.wav", x, 44100)
    src = FileSource(tmp_path / "a.wav")
    assert src.format.sample_rate == 44100.0 and src.format.channels == 2
    np.testing.assert_allclose(src.render(1000), x, atol=2 / 32768)


def test_reads_float32_and_loops_at_the_end(tmp_path: Path):
    x = stereo_ramp(300)[:, :1]
    write_float32(tmp_path / "f.wav", x, 48000)
    src = FileSource(tmp_path / "f.wav")
    assert src.format.channels == 1
    y = src.render(700)
    np.testing.assert_array_equal(y, np.concatenate([x, x, x[:100]]))
