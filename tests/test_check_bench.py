import json
from pathlib import Path

from tools.check_bench import main


def write(path: Path, data: dict[str, object]) -> Path:
    path.write_text(json.dumps(data))
    return path


def test_passes_within_tolerance_and_fails_on_regression(tmp_path: Path, capsys):
    base = write(tmp_path / "base.json", {"fpsMin": 60, "frameMsP99Max": 18.0})
    good = write(tmp_path / "good.json", {"fpsMin": 59, "frameMsP99Max": 18.5})
    bad = write(tmp_path / "bad.json", {"fpsMin": 40, "frameMsP99Max": 18.5})
    assert main([str(base), str(good)]) == 0
    assert main([str(base), str(bad)]) == 1
    assert "fpsMin" in capsys.readouterr().out
