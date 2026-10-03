"""Real PipeWire capture of a real playing process (Linux). Needs a running PipeWire session.

uv run pytest -m live -s tests/test_live_pipewire.py

The players are PipeWire's own ``pw-play`` (a native client) and ``speaker-test`` (an ALSA-plugin
client): the two ways an app's pid reaches PipeWire other than the PulseAudio protocol.
"""

import subprocess
import sys
import threading
import time
import wave
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(sys.platform != "linux", reason="PipeWire capture is Linux-only"),
]

if sys.platform == "linux":
    from tidalviz.capture.pipewire_source import (
        PipeWireAppSource,
        PipeWireSystemSource,
        list_audio_apps,
    )


@pytest.fixture(params=["pw-play", "speaker-test"])
def player(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[subprocess.Popen[bytes]]:
    if request.param == "pw-play":
        t = np.arange(48000 * 20) / 48000
        tone = (0.5 * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2")
        path = tmp_path / "tone.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(48000)
            w.writeframes(tone.tobytes())
        cmd = ["pw-play", str(path)]
    else:
        cmd = ["speaker-test", "-t", "pink", "-c", "2"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    yield proc
    proc.terminate()
    proc.wait(timeout=5)


def record(src: PipeWireSystemSource | PipeWireAppSource, seconds: float) -> np.ndarray:
    blocks: list[np.ndarray] = []
    lock = threading.Lock()

    def on_samples(x: np.ndarray, t: float) -> None:
        with lock:
            blocks.append(x.copy())

    src.start(on_samples)
    time.sleep(seconds)
    src.stop()
    with lock:
        return np.concatenate(blocks)


def wait_for_app(pid: int) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if any(a.pid == pid for a in list_audio_apps()):
            return
        time.sleep(0.1)
    pytest.fail(f"pid {pid} never appeared in list_audio_apps(): {list_audio_apps()}")


def test_a_playing_app_is_listed_and_its_audio_is_captured(player: subprocess.Popen[bytes]):
    wait_for_app(player.pid)
    app = next(a for a in list_audio_apps() if a.pid == player.pid)
    assert app.id == f"app:{player.pid}"
    x = record(PipeWireAppSource(app), 2.0)
    n = x.shape[0] / 512
    rms = float(np.sqrt(np.mean(x**2)))
    print(f"\nlive app capture: {n:.0f} blocks in 2 s, rms {rms:.3f}")
    assert 170 <= n <= 200  # 93.75 blocks/s
    assert x.shape[1] == 2 and x.dtype == np.float32
    assert rms > 0.02


def test_system_capture_hears_a_playing_app(player: subprocess.Popen[bytes]):
    wait_for_app(player.pid)
    x = record(PipeWireSystemSource(), 2.0)
    rms = float(np.sqrt(np.mean(x**2)))
    print(f"\nlive system capture: rms {rms:.3f}")
    assert rms > 0.01


def test_an_app_that_stops_playing_fails_the_capture_instead_of_recording_an_input(
    player: subprocess.Popen[bytes],
):
    wait_for_app(player.pid)
    app = next(a for a in list_audio_apps() if a.pid == player.pid)
    src = PipeWireAppSource(app)
    src.start(lambda x, t: None)
    try:
        time.sleep(0.5)
        player.terminate()
        player.wait(timeout=5)
        assert src.failed.wait(5.0)
        links = subprocess.run(["pw-link", "-l"], capture_output=True, text=True).stdout
        # without node.dont-reconnect, WirePlumber re-links pw-record to the microphone
        assert "alsa_input" not in links and "bluez_input" not in links
    finally:
        src.stop()
