"""catap's drain thread polls its native ring every 1 ms; DrainPacer lets it sleep between chunks."""

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
    for t in (0.0, P + 0.0009, 2 * P + 0.0001):  # ±1 ms detection jitter
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


def test_install_sleeps_after_an_empty_read_once_the_period_is_known(monkeypatch):
    import tidalviz.capture.catap_drain as cd

    cls = type("Rec", (FakeRecorder,), {})
    assert cd.install(cls, promote=lambda: None) and cd.install(cls)  # idempotent
    clock = iter([0.0, P, 2 * P, 2 * P + 0.0002, 3 * P])  # one read per call, two after a sleep
    monkeypatch.setattr(cd.time, "monotonic", lambda: next(clock))
    rec, ev = cls([True, True, True, False, True]), FakeEvent()
    for _ in range(3):
        assert rec._drain_native_recorder(None, ev)
    assert ev.waits == []
    assert rec._drain_native_recorder(None, ev)  # empty read → sleep → read again → chunk
    assert rec.calls == 5
    assert abs(ev.waits[0] - (P - DrainPacer.EARLY_S - 0.0002)) < 1e-9


def test_install_leaves_a_recorder_without_the_hook_alone():
    import tidalviz.capture.catap_drain as cd

    assert not cd.install(type("Other", (), {}))


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
