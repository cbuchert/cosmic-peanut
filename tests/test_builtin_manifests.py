"""The built-in visualizers and the template repo ship valid, complete manifests."""

import json
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "src/tidalviz/plugins/manifest.schema.json").read_text())
REPOS = {
    "builtin": ROOT / "plugins/builtin",
    "template": ROOT / "plugins/template",
    "cosmic-peanut": ROOT / "plugins/cosmic-peanut",
}
BUILTIN_REPOS = ("builtin", "cosmic-peanut")
THUMB_MAX = 60 * 1024


def _manifest(repo: str) -> dict:
    return json.loads((REPOS[repo] / "tidalviz.json").read_text())


def _entries() -> list[tuple[str, dict]]:
    return [(repo, v) for repo in REPOS for v in _manifest(repo)["visualizers"]]


@pytest.mark.parametrize("repo", REPOS)
def test_manifest_validates_against_schema(repo: str):
    jsonschema.validate(_manifest(repo), SCHEMA)


def test_builtin_renderers():
    got = {v["id"]: (v["renderer"], v.get("libs", [])) for v in _manifest("builtin")["visualizers"]}
    assert got == {
        "bars": ("2d", []),
        "undertow": ("webgl2", []),
        "orbit": ("three", ["three"]),
        "pulsar": ("2d", []),
    }


def test_template_is_one_webgl2_visualizer():
    (viz,) = _manifest("template")["visualizers"]
    assert viz["renderer"] == "webgl2"


@pytest.mark.parametrize(
    ("repo", "viz"), _entries(), ids=lambda x: x if isinstance(x, str) else x["id"]
)
def test_entry_and_thumbnail_exist(repo: str, viz: dict):
    assert (REPOS[repo] / viz["entry"]).is_file()
    if "thumbnail" in viz:
        thumb = REPOS[repo] / viz["thumbnail"]
        assert thumb.is_file()
        assert thumb.stat().st_size <= THUMB_MAX


@pytest.mark.parametrize(
    ("repo", "viz"), _entries(), ids=lambda x: x if isinstance(x, str) else x["id"]
)
def test_param_defaults_are_legal(repo: str, viz: dict):
    for p in viz.get("params", []):
        if p["type"] == "number":
            assert p["min"] <= p["default"] <= p["max"], p["id"]
        elif p["type"] == "select":
            assert p["default"] in p["options"], p["id"]


@pytest.mark.parametrize("repo", BUILTIN_REPOS)
def test_builtins_have_thumbnails_and_descriptions(repo: str):
    for v in _manifest(repo)["visualizers"]:
        assert v.get("thumbnail") and v.get("description"), v["id"]


def test_bars_params_cover_every_type():
    (bars,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "bars"]
    types = {p["type"] for p in bars["params"]}
    assert types == {"number", "color", "boolean", "select"}


def test_undertow_params_match_prd_example():
    (u,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "undertow"]
    params = {p["id"]: p for p in u["params"]}
    assert params["speed"]["type"] == "number"
    assert params["tint"]["type"] == "color"
    assert params["mirror"]["type"] == "boolean"
    assert params["mode"]["options"] == ["rings", "bars"]


@pytest.mark.parametrize("repo", REPOS)
def test_repo_ships_current_sdk_types(repo: str):
    sdk = (ROOT / "web/sdk/tidalviz.d.ts").read_text()
    assert (REPOS[repo] / "tidalviz.d.ts").read_text() == sdk


def test_template_readme_covers_the_workflow():
    readme = (REPOS["template"] / "README.md").read_text()
    for needle in ("tidalviz --dev", "Add folder", "reduceFlashing", "bassAtt", "sandbox", "git"):
        assert needle in readme, needle


def test_pulsar_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "pulsar"]
    assert (v["name"], v["entry"], v["thumbnail"]) == ("Pulsar", "src/pulsar.js", "thumbs/pulsar.jpg")
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == ["lines", "speed", "height", "color", "lineWidth"]
    assert params["lines"]["default"] == "80"
    assert all(40 <= int(o) <= 120 for o in params["lines"]["options"])
    assert params["speed"]["default"] == 10
    assert params["color"]["default"] == "#ffffff"


def test_cosmic_peanut_manifest_matches_prd():
    (v,) = _manifest("cosmic-peanut")["visualizers"]
    assert (v["id"], v["name"], v["renderer"], v["entry"]) == (
        "cosmic-peanut",
        "Cosmic Peanut",
        "webgl2",
        "src/cosmic-peanut.js",
    )
    assert "libs" not in v
    got = {
        p["id"]: tuple(p.get(k) for k in ("type", "label", "default", "min", "max", "options"))
        for p in v["params"]
    }
    assert got == {
        "travel": ("number", "Travel time", 7, 2, 20, None),
        "amp": ("number", "Amplitude", 0.22, 0, 0.6, None),
        "detail": ("number", "Detail", 0.7, 0, 1, None),
        "pulse": ("number", "Bass pulse", 0.35, 0, 1, None),
        "orbit": ("number", "Orbit speed", 0.12, -0.6, 0.6, None),
        "bright": ("number", "Brightness", 1, 0.2, 2, None),
        "density": ("select", "Rings", "medium", None, None, ["sparse", "medium", "dense"]),
        "palette": ("select", "Palette", "nebula", None, None, ["nebula", "ember", "phosphor"]),
        "lines": ("select", "Lines", "soft", None, None, ["soft", "fine"]),
    }
    assert [p["id"] for p in v["params"]] == list(got)
    assert {p["id"]: p.get("step") for p in v["params"]}["travel"] == 0.5
