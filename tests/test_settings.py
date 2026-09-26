import json
from pathlib import Path

from tidalviz.settings import DEFAULTS, Settings


def test_defaults_when_file_missing(tmp_path: Path):
    s = Settings(tmp_path / "settings.json")
    assert s.data == DEFAULTS
    assert s.data["reduceFlashing"] is True and s.data["quality"] == "auto"


def test_update_persists_and_reports_changes(tmp_path: Path):
    path = tmp_path / "settings.json"
    s = Settings(path)
    changed = s.update({"quality": "battery", "autoCycleSeconds": 30, "reduceFlashing": True})
    assert changed == {"quality": "battery", "autoCycleSeconds": 30}
    assert Settings(path).data["quality"] == "battery"


def test_update_drops_unknown_keys_and_bad_values(tmp_path: Path):
    s = Settings(tmp_path / "settings.json")
    changed = s.update(
        {"quality": "ultra", "autoCycleSeconds": -5, "hudVisible": "yes", "evil": 1, "active": 3}
    )
    assert changed == {}
    assert "evil" not in s.data


def test_params_per_visualizer(tmp_path: Path):
    path = tmp_path / "settings.json"
    s = Settings(path)
    s.set_params("builtin/bars", {"color": "#ff0000", "mirror": True})
    assert Settings(path).params_for("builtin/bars") == {"color": "#ff0000", "mirror": True}
    assert s.params_for("builtin/orbit") == {}


def test_corrupt_file_falls_back_to_defaults_and_keeps_a_backup(tmp_path: Path):
    path = tmp_path / "settings.json"
    path.write_text("{not json")
    s = Settings(path)
    assert s.data == DEFAULTS
    assert any(p.name.startswith("settings.json.corrupt") for p in tmp_path.iterdir())


def test_loaded_values_are_validated_too(tmp_path: Path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"quality": "nope", "reduceFlashing": False}))
    s = Settings(path)
    assert s.data["quality"] == "auto" and s.data["reduceFlashing"] is False


def test_transparent_and_borderless_default_on(tmp_path: Path):
    s = Settings(tmp_path / "settings.json")
    assert s.data["transparent"] is True and s.data["borderless"] is True
    assert s.update({"transparent": False, "borderless": "no"}) == {"transparent": False}
