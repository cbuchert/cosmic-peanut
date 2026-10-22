"""Beat-tracking accuracy on the Ballroom dataset (698 × 30 s clips, Krebs beat annotations).

uv run python -m tools.beat_eval --fetch     # once: ~1.5 GB into ~/.cache/tidalviz/ballroom
uv run python -m tools.beat_eval [--limit N] [--every K]

Each clip streams hop by hop through the real Analyzer, as live capture would. A beat is each
wrap of `beatPhase` while `bpm > 0`, placed at the exact phase-0 crossing. Scores are mir_eval's
(first 5 s of every clip ignored, as is standard): F-measure (±70 ms), CMLt (correct tempo and
phase, continuous) and AMLt (also allowing double/half tempo and off-beat), plus tempo accuracy
from the median reported bpm: Acc1 within 4 %, Acc2 also allowing ×2, ×½, ×3, ×⅓.
"""

import argparse
import os
import shutil
import subprocess
import warnings
import wave
from multiprocessing import Pool
from pathlib import Path
from typing import NamedTuple

import numpy as np
from numpy.typing import NDArray

from tidalviz.analysis import AnalysisSettings, Analyzer
from tidalviz.capture.ring import RingBuffer
from tidalviz.frame import SCALAR_INDEX

F64 = NDArray[np.float64]

DATA = Path(os.environ.get("TIDALVIZ_BALLROOM", Path.home() / ".cache/tidalviz/ballroom"))
AUDIO_URL = "https://mtg.upf.edu/ismir2004/contest/tempoContest/data1.tar.gz"
ANNOTATIONS_URL = "https://codeload.github.com/CPJKU/BallroomAnnotations/zip/refs/heads/master"


def beats_from_phase(t: F64, bpm: F64, phase: F64) -> F64:
    """Beat times: each wrap of `phase` between two frames with a tempo, at its 0 crossing."""
    tempo = (bpm[1:] > 0) & (bpm[:-1] > 0)
    i = np.flatnonzero(tempo & (phase[1:] < phase[:-1] - 0.5)) + 1
    return t[i] - phase[i] * 60.0 / bpm[i]


def track(samples: NDArray[np.float32], sample_rate: float) -> tuple[F64, F64, F64]:
    """Per-frame (host_time, bpm, beatPhase) from streaming mono `samples` through the Analyzer."""
    settings = AnalysisSettings()
    hop = settings.hop
    ring = RingBuffer(capacity=16384, channels=1)
    an = Analyzer(sample_rate, 1, settings)
    n = len(samples) // hop
    t, bpm, phase = np.zeros(n), np.zeros(n), np.zeros(n)
    i_bpm, i_phase = SCALAR_INDEX["bpm"], SCALAR_INDEX["beatPhase"]
    for k in range(n):
        host_time = (k + 1) * hop / sample_rate
        ring.write(samples[k * hop : (k + 1) * hop, None], host_time)
        frame = an.process(ring, host_time)
        t[k], bpm[k], phase[k] = host_time, frame.scalars[i_bpm], frame.scalars[i_phase]
    return t, bpm, phase


def read_wav(path: Path) -> tuple[NDArray[np.float32], float]:
    with wave.open(str(path)) as w:
        assert w.getsampwidth() == 2, f"{path}: expected 16-bit PCM"
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        x = pcm.astype(np.float32).reshape(-1, w.getnchannels()).mean(axis=1, dtype=np.float32)
        return x / np.float32(32768.0), float(w.getframerate())


class Score(NamedTuple):
    name: str
    genre: str
    f: float
    cmlt: float
    amlt: float
    acc1: bool
    acc2: bool


def score(wav: Path) -> Score:
    import mir_eval  # dev-only

    warnings.filterwarnings("ignore", module="mir_eval")  # no beats yet scores 0, as it should
    ref = np.loadtxt(DATA / "BallroomAnnotations-master" / f"{wav.stem}.beats", ndmin=2)[:, 0]
    t, bpm, phase = track(*read_wav(wav))
    est = mir_eval.beat.trim_beats(beats_from_phase(t, bpm, phase))
    ref = mir_eval.beat.trim_beats(ref)
    f = mir_eval.beat.f_measure(ref, est)
    _, cmlt, _, amlt = mir_eval.beat.continuity(ref, est)
    true_bpm = 60.0 / float(np.median(np.diff(ref)))
    locked = bpm[bpm > 0]
    ratio = (float(np.median(locked)) if locked.size else 0.0) / true_bpm
    acc2 = any(abs(ratio / m - 1) <= 0.04 for m in (1, 2, 0.5, 3, 1 / 3))
    return Score(wav.stem, wav.parent.name, f, cmlt, amlt, abs(ratio - 1) <= 0.04, acc2)


def clips(every: int = 1, limit: int = 0) -> list[Path]:
    wavs = sorted((DATA / "BallroomData").glob("*/*.wav"))[::every]
    return wavs[:limit] if limit else wavs


def evaluate(wavs: list[Path]) -> list[Score]:
    # ponytail: a process per core; 698 clips × 30 s run in a few minutes.
    with Pool() as pool:
        return pool.map(score, wavs, chunksize=4)


def summary(scores: list[Score]) -> dict[str, float]:
    a = np.array([s[2:] for s in scores], dtype=np.float64)
    return dict(zip(("f", "cmlt", "amlt", "acc1", "acc2"), a.mean(axis=0).tolist(), strict=True))


def fetch() -> None:
    """Download the clips and annotations into DATA (resumable)."""
    DATA.mkdir(parents=True, exist_ok=True)
    curl = ["curl", "-fL", "--retry", "3", "-C", "-", "-o"]
    if not (DATA / "BallroomAnnotations-master").is_dir():
        subprocess.run([*curl, str(DATA / "ann.zip"), ANNOTATIONS_URL], check=True)
        shutil.unpack_archive(DATA / "ann.zip", DATA)
        (DATA / "ann.zip").unlink()
    if not (DATA / "BallroomData").is_dir():
        subprocess.run([*curl, str(DATA / "data1.tar.gz"), AUDIO_URL], check=True)
        shutil.unpack_archive(DATA / "data1.tar.gz", DATA)
        (DATA / "data1.tar.gz").unlink()


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--fetch", action="store_true", help="download the dataset, then exit")
    ap.add_argument("--every", type=int, default=1, help="every Kth clip (a quick spread)")
    ap.add_argument("--limit", type=int, default=0, help="at most N clips")
    args = ap.parse_args()
    if args.fetch:
        fetch()
        return
    wavs = clips(args.every, args.limit)
    if not wavs:
        raise SystemExit(f"no Ballroom audio under {DATA}: run with --fetch first")
    scores = evaluate(wavs)
    genres = {g: [s for s in scores if s.genre == g] for g in sorted({s.genre for s in scores})}
    print(f"{'':20} {'n':>4} {'F':>6} {'CMLt':>6} {'AMLt':>6} {'Acc1':>6} {'Acc2':>6}")
    for g, ss in [*genres.items(), ("all", scores)]:
        print(f"{g:20} {len(ss):4} " + " ".join(f"{v:6.3f}" for v in summary(ss).values()))


if __name__ == "__main__":
    main()
