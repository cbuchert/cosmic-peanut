import pytest

from tidalviz.bench import BenchRecorder, compare


def perf(
    key: str, fps: float, p50: float, p99: float, plugin: float, dropped: int
) -> dict[str, object]:
    return {
        "type": "perf",
        "key": key,
        "fps": fps,
        "frameMsP50": p50,
        "frameMsP99": p99,
        "pluginMsP50": plugin,
        "shellMs": 0.01,
        "renderScale": 1.0,
        "dropped": dropped,
    }


def stats(cpu: float, rss: float, lat: float | None = None) -> dict[str, object]:
    s: dict[str, object] = {
        "type": "stats",
        "hostCpu": cpu,
        "rssMb": rss,
        "analysisMsP50": 0.5,
        "captureToSendMsP95": 0.9,
        "droppedFrames": 0,
    }
    if lat is not None:
        s["latencyMsP95"] = lat
    return s


def test_report_aggregates_only_the_benchmarked_visualizer_after_warmup():
    r = BenchRecorder("builtin/bars", warmup_reports=1)
    r.add(perf("builtin/bars", 30, 30, 40, 1, 20))  # warm-up: ignored
    r.add(perf("builtin/orbit", 10, 90, 99, 9, 50))  # other key: ignored
    for fps in (60, 59, 60):
        r.add(perf("builtin/bars", fps, 16.6, 18.0, 0.4, 1))
    r.add(stats(5.0, 120.0, lat=30.0))
    r.add(stats(7.0, 130.0, lat=34.0))
    rep = r.report()
    assert rep["key"] == "builtin/bars" and rep["reports"] == 3
    assert rep["fpsMin"] == 59 and round(rep["fpsMean"], 2) == 59.67
    assert rep["frameMsP99Max"] == 18.0 and rep["pluginMsP50Mean"] == pytest.approx(0.4)
    assert round(rep["droppedPct"], 2) == round(3 / (60 + 59 + 60) * 100, 2)
    assert rep["hostCpuMean"] == 6.0 and rep["rssMbMax"] == 130.0
    assert rep["latencyMsP95Max"] == 34.0


def test_compare_flags_regressions_over_10_percent_in_the_bad_direction():
    base = {"fpsMin": 60, "frameMsP99Max": 18.0, "hostCpuMean": 5.0}
    ok = {"fpsMin": 58, "frameMsP99Max": 19.5, "hostCpuMean": 3.0}
    bad = {"fpsMin": 50, "frameMsP99Max": 21.0, "hostCpuMean": 5.4}
    assert compare(base, ok) == []
    assert sorted(compare(base, bad)) == ["fpsMin", "frameMsP99Max"]
