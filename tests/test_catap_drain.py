"""catap's drain thread polls its native ring every 1 ms; DrainPacer lets it sleep between chunks."""

import sys

import pytest

from tidalviz.capture.catap_drain import DrainPacer

P = 512 / 48000  # catap delivers one 512-frame chunk every ~10.7 ms


def test_no_pacing_until_two_chunk_intervals_agree():
    pacer = DrainPacer()
    assert pacer.idle_wait(0.0) == 0.0
    pacer.polled(True, 0.0)
    assert pacer.idle_wait(0.0005) == 0.0  # one chunk: no period yet
    pacer.polled(True, P)
    assert pacer.idle_wait(P + 0.0005) == 0.0  # one interval: not yet trusted


def test_sleeps_until_shortly_before_the_next_chunk_is_due():
    pacer = DrainPacer()
    for k in range(3):
        pacer.polled(True, k * P)
    now = 2 * P + 0.0003
    wait = pacer.idle_wait(now)
    assert abs((now + wait) - (3 * P - DrainPacer.EARLY_S)) < 1e-9
    assert pacer.idle_wait(3 * P - 0.001) == 0.0  # within EARLY of due: back to 1 ms polls


def test_jittery_detection_still_paces_but_irregular_arrival_stops_it():
    pacer = DrainPacer()
    for t in (0.0, P + 0.0009, 2 * P + 0.0001):  # ~1 ms detection jitter
        pacer.polled(True, t)
    assert pacer.idle_wait(2 * P + 0.0005) > 0.005
    pacer.polled(True, 4 * P)  # a chunk came late (two periods): distrust the period
    assert pacer.idle_wait(4 * P + 0.0005) == 0.0


def test_empty_polls_do_not_move_the_estimate():
    pacer = DrainPacer()
    for k in range(3):
        pacer.polled(True, k * P)
    pacer.polled(False, 2 * P + 0.004)
    now = 2 * P + 0.005
    assert abs((now + pacer.idle_wait(now)) - (3 * P - DrainPacer.EARLY_S)) < 1e-9


class FakeRecorder:
    """Stands in for catap's AudioRecorder: a scripted sequence of ring reads."""

    def __init__(self, reads: list[bool]) -> None:
        self.reads = reads
        self.calls = 0

    def _drain_native_recorder(self, native_recorder: object, abort_event: object) -> bool:
        self.calls += 1
        return self.reads.pop(0) if self.reads else False


class FakeEvent:
    def __init__(self) -> None:
        self.waits: list[float] = []

    def wait(self, timeout: float) -> bool:
        self.waits.append(timeout)
        return False


class SimulatedCatap:
    """catap's drain loop against a ring that receives a chunk every P (plus jitter)."""

    def __init__(self, monkeypatch, jitter: list[float]) -> None:
        import tidalviz.capture.catap_drain as cd

        self.now = 0.0
        self.jitter = jitter
        self.next_k = 0  # next chunk not yet read
        self.reads = 0
        self.latency: list[float] = []
        self.bunched = 0
        monkeypatch.setattr(cd.time, "monotonic", lambda: self.now)
        sim = self

        class Rec:
            def _drain_native_recorder(self, native_recorder: object, abort_event: object) -> bool:
                sim.reads += 1
                arrived = [
                    k for k in range(sim.next_k, sim.next_k + 3) if sim.arrival(k) <= sim.now
                ]
                if not arrived:
                    return False
                sim.bunched += len(arrived) > 1
                sim.latency += [sim.now - sim.arrival(k) for k in arrived]
                sim.next_k = arrived[-1] + 1
                return True

        class Ev:
            def wait(self, timeout: float) -> bool:
                sim.now += timeout
                return False

        cd.install(Rec, promote=lambda: None)
        self.rec, self.ev = Rec(), Ev()

    def arrival(self, k: int) -> float:
        return k * P + self.jitter[k % len(self.jitter)]

    def run(self, seconds: float) -> None:
        while self.now < seconds:
            if not self.rec._drain_native_recorder(None, self.ev):
                self.now += 0.001  # catap: stop_event.wait(0.001) after an empty read


def test_paced_drain_reads_about_twice_per_chunk_with_low_latency(monkeypatch):
    # Measured with a 0.2 ms real-time poll: intervals 10.43–10.91 ms (p0.1–p99.9).
    sim = SimulatedCatap(monkeypatch, jitter=[0.0, 0.00025, -0.0002, 0.0001, 0.00025, -0.00025])
    sim.run(1.0)
    warm = sim.reads
    chunks = sim.next_k
    sim.run(3.0)
    per_chunk = (sim.reads - warm) / (sim.next_k - chunks)
    assert per_chunk <= 2.2, per_chunk  # catap alone: ~10.7
    assert sim.bunched == 0
    assert max(sim.latency) < 0.002 and sum(sim.latency) / len(sim.latency) < 0.001


def test_irregular_chunks_fall_back_to_catap_polling_without_bunching(monkeypatch):
    sim = SimulatedCatap(monkeypatch, jitter=[0.0, 0.0025, -0.002, 0.0, 0.002, 0.0005, -0.0025])
    sim.run(3.0)
    assert sim.bunched == 0  # a pair would cost a frame
    assert max(sim.latency) < 0.008  # bounded by the (unrealistic, ±2.5 ms) jitter


def test_install_leaves_a_recorder_without_the_hook_alone():
    import tidalviz.capture.catap_drain as cd

    assert not cd.install(type("Other", (), {}))


@pytest.mark.skipif(sys.platform != "darwin", reason="catap is macOS-only")
def test_catap_source_paces_the_installed_catap():
    import catap.recorder

    import tidalviz.capture.catap_source  # noqa: F401  (installs on import)

    assert getattr(catap.recorder.AudioRecorder._drain_native_recorder, "_tidalviz_paced", False)


def test_install_promotes_the_drain_thread_once_so_its_sleeps_are_precise():
    # Default-QoS timed waits overshoot by 2–5 ms (timer coalescing), which would make the
    # paced drain read two chunks at once; real-time threads wake on time.
    import tidalviz.capture.catap_drain as cd

    promoted: list[int] = []
    cls = type("Rec2", (FakeRecorder,), {})
    cd.install(cls, promote=lambda: promoted.append(1))
    rec = cls([True, False, True])
    for _ in range(3):
        rec._drain_native_recorder(None, FakeEvent())
    assert promoted == [1]
