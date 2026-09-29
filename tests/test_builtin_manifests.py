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
        "stargate": ("webgl2", []),
        "blaze": ("webgl2", []),
        "cascade": ("webgl2", []),
        "radar": ("webgl2", []),
        "tentacube": ("three", ["three"]),
        "tiedye": ("webgl2", []),
        "skull": ("webgl2", []),
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
    assert (v["name"], v["entry"], v["thumbnail"]) == (
        "Pulsar",
        "src/pulsar.js",
        "thumbs/pulsar.jpg",
    )
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
        # Added after the PRD at the user's request: 2× MSAA for soft lines costs ~7.5 MB of GPU
        # memory at 1440p, so it can be switched off.
        "antialias": ("boolean", "Antialias soft lines", True, None, None, None),
    }
    assert [p["id"] for p in v["params"]] == list(got)
    assert {p["id"]: p.get("step") for p in v["params"]}["travel"] == 0.5


def test_stargate_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "stargate"]
    assert (v["name"], v["entry"], v["thumbnail"]) == (
        "Stargate",
        "src/stargate.js",
        "thumbs/stargate.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == ["speed", "roll", "detail", "streak", "spread", "brightness", "palette"]
    assert params["roll"]["default"] == 0.25
    assert params["roll"]["min"] < 0 < params["roll"]["max"]
    assert params["palette"]["options"] == ["film", "ember", "ice", "mono"]
    assert params["palette"]["default"] == "film"
    assert (REPOS["builtin"] / "shaders/stargate/stargate.frag").is_file()


def test_blaze_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "blaze"]
    assert (v["name"], v["entry"], v["renderer"]) == ("Blaze", "src/blaze.js", "webgl2")
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "intensity",
        "reactivity",
        "height",
        "turbulence",
        "speed",
        "glow",
        "palette",
        "feed",
        "layout",
        "detail",
    ]
    r = params["reactivity"]
    assert (r["type"], r["min"], r["max"], r["default"]) == ("number", 0, 2, 1)
    # The 64-band "spectrum" feed is retired: a saved "spectrum" isn't an option any more, so the
    # host (and the plugin's resolveFeed) fall back to the default, the spectrogram.
    assert params["feed"]["options"] == ["spectrogram", "waveform"]
    assert params["feed"]["default"] == "spectrogram"
    assert params["layout"]["type"] == "select"
    assert params["layout"]["options"] == ["mirrored", "linear"]
    assert params["layout"]["default"] == "mirrored"
    assert params["palette"]["options"] == ["natural", "blue gas", "green chemical", "ember mono"]
    assert params["palette"]["default"] == "natural"
    assert (params["detail"]["min"], params["detail"]["max"]) == (0.15, 0.5)


def test_cascade_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "cascade"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Cascade",
        "src/cascade.js",
        "webgl2",
        "thumbs/cascade.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "flow",
        "density",
        "width",
        "height",
        "gravity",
        "spray",
        "mist",
        "turbulence",
        "palette",
    ]
    assert params["density"]["options"] == ["16k", "32k", "64k"]
    assert params["palette"]["options"] == ["glacier", "tropical", "moonlit", "mono"]
    assert params["palette"]["default"] == "glacier"
    # Fills the window by default; width and height narrow the lip and shorten the drop.
    for pid in ("width", "height"):
        assert params[pid]["default"] == params[pid]["max"] == 1
        assert 0 < params[pid]["min"] < 1
    assert params["density"]["default"] == "64k"


def test_radar_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "radar"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Radar",
        "src/radar.js",
        "webgl2",
        "thumbs/radar.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "sync",
        "speed",
        "persistence",
        "gain",
        "palette",
        "graticule",
        "floor",
        "maxFreq",
    ]
    assert params["sync"]["options"] == ["off", "beat", "bar"]
    assert params["sync"]["default"] == "bar"
    # lib/radar.js DEFAULT_SPEED: Reduce motion slows the sweep only while it's at this default.
    assert params["speed"]["default"] == 0.25
    assert params["palette"]["options"] == ["green", "amber", "blue", "white"]
    assert params["palette"]["default"] == "green"
    # The spectrogram's dB floor (below the auto-gain reference) and top frequency (radar.js maxHzOf).
    floor = params["floor"]
    assert (floor["type"], floor["min"], floor["max"], floor["default"]) == (
        "number",
        -80,
        -30,
        -60,
    )
    assert params["maxFreq"]["options"] == ["4k", "8k", "16k"]
    assert "contacts" not in params
    for f in ("fullscreen.vert", "paint.frag", "composite.frag"):
        assert (REPOS["builtin"] / "shaders/radar" / f).is_file(), f


def test_tentacube_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "tentacube"]
    assert (v["name"], v["entry"], v["renderer"], v["libs"], v["thumbnail"]) == (
        "Tentacube",
        "src/tentacube.js",
        "three",
        ["three"],
        "thumbs/tentacube.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "length",
        "segments",
        "drag",
        "twitch",
        "pulse",
        "morph",
        "material",
        "background",
        "tiling",
        "bloom",
        "distance",
    ]
    assert params["morph"]["options"] == ["off", "slow", "fast"]
    assert params["material"]["options"] == ["auto", "chrome", "iridescent", "emissive", "obsidian"]
    assert params["material"]["default"] == "auto"
    assert params["background"]["options"] == ["hyperbolic", "none"]
    assert params["tiling"]["options"] == ["{7,3}", "{5,4}", "{4,5}"]
    seg = params["segments"]
    assert (seg["min"], seg["max"], seg["step"], seg["default"]) == (12, 48, 1, 24)
    # The creature code keys "reduce motion" off the twitch default.
    assert params["twitch"]["default"] == 1


def test_tiedye_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "tiedye"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Tie-Dye",
        "src/tiedye.js",
        "webgl2",
        "thumbs/tiedye.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "pattern",
        "palette",
        "fabric",
        "twist",
        "speed",
        "bleed",
        "reactivity",
        "bloom",
    ]
    # Option order is the shader index order in lib/tiedye.js (PATTERNS, PALETTES, FABRICS).
    assert params["pattern"]["options"] == ["spiral", "bullseye", "crumple", "shibori"]
    assert params["pattern"]["default"] == "spiral"
    assert params["palette"]["options"] == ["rainbow", "sunset", "ocean", "neon"]
    assert params["palette"]["default"] == "rainbow"
    assert params["fabric"]["options"] == ["white", "none"]
    assert params["fabric"]["default"] == "white"
    # lib/tiedye.js DEFAULT_SPEED: Reduce motion slows the spin only while Speed is at this default.
    assert params["speed"]["default"] == 1
    assert params["bloom"]["type"] == "boolean"
    assert params["bloom"]["default"] is True
    for f in ("fullscreen.vert", "tiedye.frag"):
        assert (REPOS["builtin"] / "shaders/tiedye" / f).is_file(), f


def test_skull_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "skull"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Skull Trip",
        "src/skull.js",
        "webgl2",
        "thumbs/skull.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "reactivity",
        "density",
        "warp",
        "speed",
        "jaw",
        "mode",
        "stripes",
        "size",
    ]
    # lib/skull-motion.js DEFAULTS: Reduce motion calms flow, warp, nods and ripples only while
    # these are at their defaults.
    for pid in ("reactivity", "density", "warp", "speed", "jaw", "size"):
        assert params[pid]["type"] == "number"
        assert params[pid]["default"] == 1, pid
    # lib/opart.js MODES / STRIPES.
    assert params["mode"]["options"] == ["monochrome", "acid"]
    assert params["mode"]["default"] == "monochrome"
    assert params["stripes"]["options"] == ["black & white", "black only"]
    assert params["stripes"]["default"] == "black & white"
    for f in ("fullscreen.vert", "opart.glsl", "skull.frag", "composite.frag"):
        assert (REPOS["builtin"] / "shaders/skull" / f).is_file(), f
