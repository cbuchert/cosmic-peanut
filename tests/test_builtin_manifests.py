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
        "darksun": ("webgl2", []),
        "eclipse": ("webgl2", []),
        "marbling": ("webgl2", []),
        "laminar": ("webgl2", []),
        "tetraballs": ("webgl2", []),
        "lattice": ("webgl2", []),
        "tentacle-lattice": ("webgl2", []),
        "metamorphosis": ("webgl2", []),
        "tile-horizon": ("webgl2", []),
        "endless-zoom": ("webgl2", []),
        "tiled-sphere": ("webgl2", []),
        "tiled-torus": ("webgl2", []),
        "poincare-disk": ("webgl2", []),
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


COSMIC_PEANUT_PARAMS = {
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
    # Added after the PRD: classic is the original look, pixel for pixel; cinematic adds HDR
    # lines, bloom, filmic tone mapping, prefiltered lines and lens character (README → Look).
    "look": ("select", "Look", "classic", None, None, ["classic", "cinematic"]),
}


def _param_table(v: dict) -> dict:
    return {
        p["id"]: tuple(p.get(k) for k in ("type", "label", "default", "min", "max", "options"))
        for p in v["params"]
    }


def test_cosmic_peanut_pack_is_the_sphere_the_mobius_strip_and_the_field():
    vs = _manifest("cosmic-peanut")["visualizers"]
    assert [(v["id"], v["name"]) for v in vs] == [
        ("cosmic-peanut", "Cosmic Peanut"),
        ("mobius", "Möbius"),
        ("mobius-field", "Möbius Field"),
    ]
    # One entry module drives the sphere and the strip (the shape is picked by ctx.id); the field
    # has its own, sharing the pack's libs.
    entries = {v["id"]: v["entry"] for v in vs}
    assert entries == {
        "cosmic-peanut": "src/cosmic-peanut.js",
        "mobius": "src/cosmic-peanut.js",
        "mobius-field": "src/mobius-field.js",
    }
    for v in vs:
        assert v["renderer"] == "webgl2"
        assert "libs" not in v
        assert v["thumbnail"] == f"thumbs/{v['id']}.jpg"


def test_cosmic_peanut_manifest_matches_prd():
    (v,) = [v for v in _manifest("cosmic-peanut")["visualizers"] if v["id"] == "cosmic-peanut"]
    got = _param_table(v)
    assert got == COSMIC_PEANUT_PARAMS
    assert [p["id"] for p in v["params"]] == list(got)
    assert {p["id"]: p.get("step") for p in v["params"]}["travel"] == 0.5


def test_every_cosmic_peanut_visualizer_has_the_same_look_param_after_antialias():
    for v in _manifest("cosmic-peanut")["visualizers"]:
        ids = [p["id"] for p in v["params"]]
        assert ids[ids.index("antialias") + 1] == "look", v["id"]
        (look,) = [p for p in v["params"] if p["id"] == "look"]
        assert look == {
            "id": "look",
            "type": "select",
            "label": "Look",
            "options": ["classic", "cinematic"],
            "default": COSMIC_PEANUT_PARAMS["look"][2],
        }


def test_mobius_has_cosmic_peanuts_params_plus_width_beat_track_and_length():
    vs = {v["id"]: v for v in _manifest("cosmic-peanut")["visualizers"]}
    sphere, mobius = vs["cosmic-peanut"], vs["mobius"]
    assert mobius["params"][: len(sphere["params"])] == sphere["params"]
    width, beat, track, length = mobius["params"][len(sphere["params"]) :]
    assert (width["id"], width["type"], width["label"]) == ("width", "number", "Strip width")
    assert 0.35 <= width["default"] <= 0.45 and width["min"] > 0 and width["max"] < 1
    # One knob for the wring, breath and glow on the beat; the sphere has none (stays unchanged).
    assert beat == {
        "id": "beat",
        "type": "number",
        "label": "Beat",
        "min": 0,
        "max": 2,
        "step": 0.01,
        "default": 1,
    }
    # The ribbon rides the loop (default) or a figure-8 (a Möbius strip and its mirror image);
    # Length is the fraction of the track it covers (below 1 it snakes).
    assert track == {
        "id": "track",
        "type": "select",
        "label": "Track",
        "options": ["figure-8", "loop"],
        "default": "loop",
    }
    assert (length["id"], length["type"], length["label"]) == ("length", "number", "Length")
    # Defaults give back the original closed band; figure-8 and the snake are options.
    assert length["max"] == 1 and 0 < length["min"] <= 0.25 and length["default"] == 1
    assert {"beat", "track", "length"}.isdisjoint(p["id"] for p in sphere["params"])


def test_mobius_field_has_the_strips_params_less_orbit_track_and_length_plus_its_own():
    vs = {v["id"]: v for v in _manifest("cosmic-peanut")["visualizers"]}
    mobius, field = vs["mobius"], vs["mobius-field"]
    # The camera flies instead of orbiting, and every band is the closed loop at full length.
    dropped = {"orbit", "track", "length"}
    shared = [p for p in mobius["params"] if p["id"] not in dropped]
    assert field["params"][: len(shared)] == shared
    bands, speed, fog = field["params"][len(shared) :]
    assert (bands["id"], bands["type"], bands["label"]) == ("bands", "number", "Bands")
    assert (bands["min"], bands["max"], bands["step"]) == (12, 80, 1)
    assert 12 <= bands["default"] <= 80
    assert (speed["id"], speed["type"], speed["label"]) == ("speed", "number", "Speed")
    assert speed["min"] == 0 and speed["max"] >= 3
    # lib/fly.js NOMINAL_SPEED: the path's curves run at their nominal pace at the default, and
    # Reduce motion slows the flight (motion.js GENTLE.speed) only while Speed sits here.
    assert speed["default"] == 1.4
    assert (fog["id"], fog["type"], fog["label"]) == ("fog", "number", "Fog")
    assert 0 < fog["min"] < fog["default"] < fog["max"]


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
        "rendering",
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
    # The original four, then flame-test materials (iron and nickel throw sparks).
    assert params["palette"]["options"] == [
        "natural",
        "blue gas",
        "green chemical",
        "ember mono",
        "propane",
        "copper",
        "boron",
        "sodium",
        "lithium",
        "strontium",
        "potassium",
        "calcium",
        "barium",
        "iron",
        "nickel",
    ]
    assert params["palette"]["default"] == "natural"
    # blackbody: Tetraballs' fire model; simple: the original hand-keyed colour ramps.
    assert params["rendering"]["type"] == "select"
    assert params["rendering"]["options"] == ["blackbody", "simple"]
    assert params["rendering"]["default"] == "blackbody"
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
        "motion",
        "bloom",
    ]
    # Option order is lib/tiedye.js PATTERN_OPTIONS ("auto", then the shader index order of
    # PATTERNS), PALETTES, FABRICS. "auto" morphs between the patterns with the song.
    assert params["pattern"]["options"] == ["auto", "spiral", "bullseye", "crumple", "shibori"]
    assert params["pattern"]["default"] == "auto"
    # lib/tiedye.js DEFAULT_MOTION: Reduce motion calms the flow only while Motion is at this default.
    assert params["motion"]["default"] == 1
    assert params["motion"]["min"] == 0
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


def test_darksun_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "darksun"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Dark Sun",
        "src/darksun.js",
        "webgl2",
        "thumbs/darksun.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "reactivity",
        "rangeWidth",
        "rangeDepth",
        "beam",
        "sunSize",
        "palette",
        "backdrop",
    ]
    # lib/darksun.js DEFAULTS / RANGES mirror these.
    got = {
        k: (p["min"], p["max"], p["default"]) for k, p in params.items() if p["type"] == "number"
    }
    assert got == {
        "reactivity": (0, 2, 1),
        "rangeWidth": (0.3, 0.7, 0.5),
        "rangeDepth": (0.3, 2, 1),
        "beam": (0, 2, 1),
        "sunSize": (0.5, 1.6, 1),
    }
    assert params["palette"]["options"] == ["dusk", "ash", "teal", "gold"]
    assert params["palette"]["default"] == "dusk"
    assert params["backdrop"]["options"] == ["painted", "none"]
    assert params["backdrop"]["default"] == "painted"
    for f in ("fullscreen.vert", "noise.glsl", "backdrop.frag", "darksun.frag"):
        assert (REPOS["builtin"] / "shaders/darksun" / f).is_file(), f


def test_eclipse_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "eclipse"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Eclipse",
        "src/eclipse.js",
        "webgl2",
        "thumbs/eclipse.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "reactivity",
        "reach",
        "thickness",
        "clouds",
        "tint",
        "sky",
        "rotation",
    ]
    r = params["reactivity"]
    assert (r["type"], r["min"], r["max"], r["default"]) == ("number", 0, 2, 1)
    # lib/eclipse.js TINTS; tintGamma / skyAlpha fall back to the defaults for anything else.
    assert params["tint"]["options"] == ["monochrome", "silver", "sepia", "cold blue"]
    assert params["tint"]["default"] == "monochrome"
    assert params["sky"]["options"] == ["black", "none"]
    assert params["sky"]["default"] == "black"
    # lib/eclipse.js DEFAULT_ROTATION: Reduce motion slows the drift only while it's at this default.
    rot = params["rotation"]
    assert rot["default"] == 0.03
    assert rot["min"] < 0 < rot["max"]
    # The water reflection was dropped at the user's request (2026-10-22).
    assert not (REPOS["builtin"] / "shaders/eclipse/water.frag").exists()
    for f in ("fullscreen.vert", "noise.glsl", "eclipse.frag", "clouds.frag"):
        assert (REPOS["builtin"] / "shaders/eclipse" / f).is_file(), f


def test_marbling_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "marbling"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Marbling",
        "src/marbling.js",
        "webgl2",
        "thumbs/marbling.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "palette",
        "paper",
        "pour",
        "size",
        "rake",
        "currents",
        "reactivity",
        "renew",
    ]
    assert params["palette"]["options"] == ["beast", "indigo", "emerald", "gold"]
    assert params["palette"]["default"] == "beast"
    assert params["paper"]["options"] == ["cream", "none"]
    assert params["paper"]["default"] == "cream"
    # lib/marbling.js DEFAULTS: Reduce motion calms pour/rake/renew/currents only while they sit here.
    for pid in ("pour", "size", "rake", "currents", "reactivity", "renew"):
        assert params[pid]["type"] == "number"
        assert params[pid]["default"] == 1, pid
    assert params["rake"]["min"] == 0
    assert params["currents"]["min"] == 0
    assert params["renew"]["min"] == 0
    for f in (
        "fullscreen.vert",
        "sample.glsl",
        "events.glsl",
        "sim.frag",
        "resample.frag",
        "composite.frag",
    ):
        assert (REPOS["builtin"] / "shaders/marbling" / f).is_file(), f


def test_laminar_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "laminar"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Laminar",
        "src/laminar.js",
        "webgl2",
        "thumbs/laminar.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "reactivity",
        "speed",
        "turbulence",
        "density",
        "size",
        "detail",
        "trail",
        "palette",
        "backdrop",
    ]
    # lib/laminar.js MOTION_DEFAULTS: Reduce motion swaps these only while they're at the default.
    for pid in ("reactivity", "speed", "turbulence"):
        assert params[pid]["default"] == 1, pid
    # lib/flow.js simGrid clamps Detail to 0.08-0.4.
    assert (params["detail"]["min"], params["detail"]["max"]) == (0.08, 0.4)
    assert params["trail"] == {"id": "trail", "type": "boolean", "label": "Trail", "default": True}
    assert params["palette"]["options"] == ["currents", "sea glass", "sunset", "mono"]
    assert params["palette"]["default"] == "currents"
    assert params["backdrop"]["options"] == ["black", "none"]
    assert params["backdrop"]["default"] == "black"
    for f in ("common.glsl", "advect.frag", "correct.frag", "composite.frag"):
        assert (REPOS["builtin"] / "shaders/laminar" / f).is_file()


def test_tetraballs_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "tetraballs"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Tetraballs",
        "src/tetraballs.js",
        "webgl2",
        "thumbs/tetraballs.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "material",
        "reactivity",
        "size",
        "bounce",
        "tumble",
        "background",
        "quality",
        "tint",
    ]
    # Order matches lib/tetra-material.js MATERIALS (after "auto").
    assert params["material"]["options"] == [
        "auto",
        "chrome",
        "soap",
        "jade",
        "brushed",
        "velvet",
        "glass",
        "water",
        "fire",
        "smoke",
    ]
    assert params["material"]["default"] == "chrome"
    assert params["background"]["options"] == ["studio", "none"]
    assert params["background"]["default"] == "studio"
    assert params["quality"]["options"] == ["low", "medium", "high"]
    # lib/tetra-motion.js DEFAULT_TUMBLE / DEFAULT_BOUNCE: Reduce motion calms them at these values.
    assert params["tumble"]["default"] == 0.35
    assert params["bounce"]["default"] == 1
    for name in ("common.glsl", "materials.glsl", "surface.glsl", "volume.glsl", "composite.frag"):
        assert (REPOS["builtin"] / "shaders/tetraballs" / name).is_file()


def test_lattice_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "lattice"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Lattice",
        "src/lattice.js",
        "webgl2",
        "thumbs/lattice.jpg",
    )
    # One line, and original wording: no artist's name or print titles in the UI.
    assert v["description"] and "\n" not in v["description"]
    assert "escher" not in json.dumps(v).lower()
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "speed",
        "reactivity",
        "thickness",
        "fog",
        "palette",
        "background",
        "look",
        "quality",
        "structure",
    ]
    # lib/lattice-look.js LOOKS / DEFAULT_LOOK: classic is the original shading, byte for byte.
    look = params["look"]
    assert (look["label"], look["type"]) == ("Look", "select")
    assert look["options"] == ["classic", "cinematic"]
    assert look["default"] in look["options"]
    # lib/structures.js STRUCTURE_OPTIONS: one entry per structure file (the seam for new ones).
    assert params["structure"]["type"] == "select"
    assert params["structure"]["options"] == [
        "cubic",
        "octet",
        "diamond",
        "bitruncated",
        "gyroid",
        "schwarz-p",
        "schwarz-d",
        "sponge",
        "kaleidoscope",
    ]
    # Each option's shader file (the TPMS share one, a define per surface).
    shared = {"gyroid": "tpms", "schwarz-p": "tpms", "schwarz-d": "tpms"}
    for name in params["structure"]["options"]:
        f = f"shaders/lattice/structure-{shared.get(name, name)}.glsl"
        assert (REPOS["builtin"] / f).is_file(), name
    assert params["structure"]["default"] == "cubic"
    # lib/lattice.js DEFAULT_SPEED: Reduce motion slows the flight only while Speed sits here.
    speed = params["speed"]
    assert (speed["type"], speed["min"], speed["default"]) == ("number", 0, 1)
    assert speed["max"] >= 3
    r = params["reactivity"]
    assert (r["type"], r["min"], r["max"], r["default"]) == ("number", 0, 2, 1)
    # lib/lattice.js THICKNESS (rod radius, cells).
    t = params["thickness"]
    assert (t["label"], t["min"], t["max"], t["default"]) == ("Rod thickness", 0.03, 0.12, 0.06)
    fog = params["fog"]
    assert (fog["min"], fog["max"], fog["default"]) == (0, 1, 0.5)
    # lib/lattice.js PALETTES / QUALITIES.
    assert params["palette"]["options"] == ["steel", "brass", "ink"]
    assert params["palette"]["default"] == "steel"
    assert params["background"]["options"] == ["fog", "none"]
    assert params["background"]["default"] == "fog"
    assert params["quality"]["options"] == ["low", "medium", "high"]
    assert params["quality"]["default"] == "medium"
    for f in (
        "fullscreen.vert",
        "lattice.frag",
        "common.glsl",
        "march.glsl",
        "shade.glsl",
        "post.frag",
        "structure-cubic.glsl",
        "structure-tentacle.glsl",
        "brdf.glsl",
        "bloom.frag",
        "structure-tpms.glsl",
        "structure-sponge.glsl",
        "structure-kaleidoscope.glsl",
    ):
        assert (REPOS["builtin"] / "shaders/lattice" / f).is_file(), f


def test_tentacle_lattice_manifest():
    vs = {v["id"]: v for v in _manifest("builtin")["visualizers"]}
    v, lattice = vs["tentacle-lattice"], vs["lattice"]
    # Lattice's entry module and shaders; the variant is picked by ctx.id (lib/tentacle-lattice.js).
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Tentacle Lattice",
        "src/lattice.js",
        "webgl2",
        "thumbs/tentacle-lattice.jpg",
    )
    assert v["description"] and "\n" not in v["description"]
    assert "escher" not in json.dumps(v).lower()
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "speed",
        "reactivity",
        "length",
        "sway",
        "twitch",
        "material",
        "fog",
        "palette",
        "background",
        "look",
        "quality",
    ]
    # Lattice's params, less Rod thickness and Structure (it's fixed to "tentacle"), unchanged.
    shared = {p["id"]: p for p in lattice["params"] if p["id"] not in ("thickness", "structure")}
    for pid, spec in shared.items():
        assert params[pid] == spec, pid
    # lib/tentacle-lattice.js LENGTH, and Sway / Twitch 0–2 (Reduce motion calms Twitch at 1).
    length = params["length"]
    assert (length["label"], length["min"], length["max"], length["default"]) == (
        "Tentacle length",
        0.3,
        0.48,
        0.42,
    )
    for pid, label in (("sway", "Sway"), ("twitch", "Twitch")):
        p = params[pid]
        assert (p["label"], p["type"], p["min"], p["max"], p["default"]) == (
            label,
            "number",
            0,
            2,
            1,
        )
    # lib/tentacle-lattice.js MATERIALS (Tentacube's presets after "auto").
    assert params["material"]["options"] == ["auto", "chrome", "iridescent", "emissive", "obsidian"]
    assert params["material"]["default"] == "auto"


# The relief's params: Metamorphosis's, and the surfaces that have adopted it (Tile Horizon,
# Endless Zoom, Tiled Sphere).
RELIEF_PARAMS = ("relief", "light")
TESS_VISUALIZERS = (
    "metamorphosis",
    "tile-horizon",
    "endless-zoom",
    "tiled-sphere",
    "tiled-torus",
    "poincare-disk",
)


def test_every_tessellation_visualizer_has_the_same_look_param_before_quality():
    # lib/tess-look.js LOOKS / DEFAULT_LOOK: classic is the woodcut print as it was, byte for byte;
    # cinematic lights it as a carved, inked, printed object (shaders/tess/look.glsl, post.frag).
    for v in _manifest("builtin")["visualizers"]:
        if v["id"] not in TESS_VISUALIZERS:
            continue
        ids = [p["id"] for p in v["params"]]
        assert ids[-2:] == ["look", "quality"], v["id"]
        (look,) = [p for p in v["params"] if p["id"] == "look"]
        assert look == {
            "id": "look",
            "type": "select",
            "label": "Look",
            "options": ["classic", "cinematic"],
            "default": "classic",
        }, v["id"]
    for name in ("look.glsl", "post.frag", "bloom.frag", "dof.frag"):
        assert (REPOS["builtin"] / "shaders" / "tess" / name).is_file(), name


def test_metamorphosis_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "metamorphosis"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Metamorphosis",
        "src/metamorphosis.js",
        "webgl2",
        "thumbs/metamorphosis.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "symmetry",
        "palette",
        "reactivity",
        "speed",
        "morph",
        "ink",
        "hatching",
        "relief",
        "light",
        "creatures",
        "look",
        "quality",
    ]
    # Relief (lib/tess-music.js RELIEF_DEFAULT; 0 is the flat print) and the raking light's
    # direction round the view in degrees (LIGHT_DEFAULT: from the upper left).
    rel = params["relief"]
    assert (rel["type"], rel["label"], rel["min"], rel["max"], rel["default"]) == (
        "number",
        "Relief",
        0,
        1,
        0.6,
    )
    li = params["light"]
    assert (li["type"], li["label"], li["min"], li["max"], li["default"]) == (
        "number",
        "Light",
        0,
        360,
        135,
    )
    # Creatures: the warp's abstract creatures (default, unchanged) or the bestiary's animal tiles
    # by group (lib/bestiary.js GROUPS; lib/atlas.js creatureList). Fixed options, so designers
    # adding species never edit the manifest.
    c = params["creatures"]
    assert (c["type"], c["label"], c["default"]) == ("select", "Creatures", "abstract")
    assert c["options"] == ["abstract", "all", "fish", "birds", "reptiles", "mammals"]
    for g in c["options"][2:]:
        assert (REPOS["builtin"] / "tiles" / g / "index.json").is_file(), g
    # Option order is lib/tess-music.js SYMMETRIES, lib/tess.js PALETTES, tess-music QUALITIES.
    assert params["symmetry"]["options"] == ["p4", "p3"]
    assert params["palette"]["options"] == ["ink", "dusk", "four-block", "ochre", "watercolour"]
    assert params["quality"]["options"] == ["low", "medium", "high"]
    r = params["reactivity"]
    assert (r["min"], r["max"], r["default"]) == (0, 2, 1)
    m = params["morph"]
    assert (m["min"], m["max"]) == (0, 1)
    h = params["hatching"]
    assert (h["min"], h["max"]) == (0, 1)
    # The palettes and the visualizer's name stay neutral (original work, no artist's name).
    text = json.dumps(v).lower()
    assert "escher" not in text
    for name in (
        "shaders/tess/tess.glsl",
        "shaders/tess/metamorphosis.frag",
        "shaders/tess/paper.frag",
    ):
        assert (REPOS["builtin"] / name).is_file(), name


def test_tile_horizon_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "tile-horizon"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Tile Horizon",
        "src/tile-horizon.js",
        "webgl2",
        "thumbs/tile-horizon.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    # Metamorphosis's params with its Relief and Light (the carved block, raised off the floor),
    # plus the floor's camera (lib/tess-floor.js maps them, 0-1).
    assert list(params) == [
        "symmetry",
        "palette",
        "reactivity",
        "speed",
        "morph",
        "ink",
        "hatching",
        "relief",
        "light",
        "height",
        "tilt",
        "fog",
        "look",
        "quality",
    ]
    (meta,) = [m for m in _manifest("builtin")["visualizers"] if m["id"] == "metamorphosis"]
    for p in meta["params"]:
        if p["id"] == "creatures":  # Metamorphosis-only for now
            continue
        assert params[p["id"]] == p, p["id"]
    for name in ("height", "tilt", "fog"):
        assert (params[name]["type"], params[name]["min"], params[name]["max"]) == ("number", 0, 1)
    # Original work: no artist's name, artwork title or trademark anywhere in its strings.
    text = json.dumps(v).lower()
    for word in ("escher", "droste"):
        assert word not in text
    for name in ("shaders/tess/tess.glsl", "shaders/tess/tile-horizon.frag"):
        assert (REPOS["builtin"] / name).is_file(), name


def test_endless_zoom_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "endless-zoom"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Endless Zoom",
        "src/endless-zoom.js",
        "webgl2",
        "thumbs/endless-zoom.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    # Metamorphosis's params, Relief and Light included (the carved block through the zoom; Relief
    # 0 is the flat print), plus the surface's own before Quality.
    (m,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "metamorphosis"]
    shared = [p for p in m["params"] if p["id"] not in ("quality", "creatures", "look")]
    assert [p["id"] for p in shared][-2:] == list(RELIEF_PARAMS)
    assert v["params"][: len(shared)] == shared
    assert list(params)[len(shared) :] == ["spiral", "zoom", "direction", "look", "quality"]
    # Option order is lib/tess-zoom.js SPIRALS and DIRECTIONS (default DEFAULT_SPIRAL).
    assert params["spiral"]["options"] == ["none", "gentle", "medium", "strong"]
    assert params["spiral"]["default"] == "gentle"
    assert params["direction"]["options"] == ["in", "out"]
    z = params["zoom"]
    assert (z["label"], z["min"], z["max"], z["default"]) == ("Zoom speed", 0, 2, 1)
    # Original work: no artist's name, artwork titles or trademarked names in UI strings.
    text = json.dumps(v).lower()
    for word in ("escher", "droste", "print gallery"):
        assert word not in text, word
    for name in ("shaders/tess/endless-zoom.frag", "shaders/tess/tess.glsl"):
        assert (REPOS["builtin"] / name).is_file(), name


def test_tiled_sphere_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "tiled-sphere"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Tiled Sphere",
        "src/tiled-sphere.js",
        "webgl2",
        "thumbs/tiled-sphere.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    # p4 only (the cube-sphere's edges are quarter turns), so no Symmetry param.
    assert list(params) == [
        "view",
        "palette",
        "reactivity",
        "speed",
        "morph",
        "ink",
        "hatching",
        "relief",
        "light",
        "look",
        "quality",
    ]
    # The carved block lifting off the globe: Metamorphosis's Relief (0 is the flat print, as
    # before relief) and Light, the same definitions.
    (meta,) = [m for m in _manifest("builtin")["visualizers"] if m["id"] == "metamorphosis"]
    for p in meta["params"]:
        if p["id"] in RELIEF_PARAMS:
            assert params[p["id"]] == p, p["id"]
    # Option order is lib/sphere-view.js VIEWS, lib/tess.js PALETTES, tess-music QUALITIES.
    assert params["view"]["options"] == ["outside", "inside", "auto"]
    assert params["view"]["default"] == "auto"
    assert params["palette"]["options"] == ["ink", "dusk", "four-block", "ochre", "watercolour"]
    assert params["quality"]["options"] == ["low", "medium", "high"]
    r = params["reactivity"]
    assert (r["min"], r["max"], r["default"]) == (0, 2, 1)
    assert "\n" not in v["description"] and len(v["description"]) < 200
    text = json.dumps(v).lower()
    assert "escher" not in text
    for name in (
        "shaders/tess/tess.glsl",
        "shaders/tess/sphere.frag",
        "shaders/tess/paper.frag",
    ):
        assert (REPOS["builtin"] / name).is_file(), name


def test_tiled_torus_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "tiled-torus"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Tiled Torus",
        "src/tiled-torus.js",
        "webgl2",
        "thumbs/tiled-torus.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "view",
        "symmetry",
        "thickness",
        "wave",
        "travel",
        "detail",
        "spin",
        "twist",
        "palette",
        "reactivity",
        "speed",
        "morph",
        "ink",
        "hatching",
        "relief",
        "light",
        "look",
        "quality",
    ]
    # The carved block riding the waves (lib/torus-relief.js; lib/torus.js mapParams): Relief 0 is
    # the smooth print as before relief, Light the raking light's direction round the view.
    rel, li = params["relief"], params["light"]
    assert (rel["type"], rel["label"], rel["min"], rel["max"], rel["default"]) == (
        "number",
        "Relief",
        0,
        1,
        0.6,
    )
    assert (li["type"], li["label"], li["min"], li["max"], li["default"]) == (
        "number",
        "Light",
        0,
        360,
        135,
    )
    (meta,) = [m for m in _manifest("builtin")["visualizers"] if m["id"] == "metamorphosis"]
    for pid in RELIEF_PARAMS:
        assert params[pid] == {p["id"]: p for p in meta["params"]}[pid], pid
    # Option order is lib/torus.js VIEWS, lib/tess-music.js SYMMETRIES, lib/tess.js PALETTES,
    # tess-music QUALITIES; Thickness is lib/torus.js THICKNESS.
    assert params["view"]["options"] == ["auto", "outside", "inside"]
    assert params["symmetry"]["options"] == ["p4", "p3"]
    assert params["palette"]["options"] == ["ink", "dusk", "four-block", "ochre", "watercolour"]
    assert params["quality"]["options"] == ["low", "medium", "high"]
    t = params["thickness"]
    assert (t["min"], t["max"], t["default"]) == (0.2, 0.5, 0.36)
    # lib/torus.js mapParams: Wave height 0–1, Travel time TRAVEL (s a lap round the tube), Detail 0–1.
    w = params["wave"]
    assert (w["label"], w["min"], w["max"], w["default"]) == ("Wave height", 0, 1, 0.7)
    tr = params["travel"]
    assert (tr["label"], tr["min"], tr["max"], tr["default"]) == ("Travel time", 1, 8, 4)
    d = params["detail"]
    assert (d["label"], d["min"], d["max"], d["default"]) == ("Detail", 0, 1, 0.15)
    # Spin: turns a minute round the tube (signed); Twist: half-turns a lap (lib/torus.js).
    sp = params["spin"]
    assert (sp["label"], sp["min"], sp["max"], sp["default"]) == ("Spin", -2, 2, 1)
    tw = params["twist"]
    assert (tw["label"], tw["min"], tw["max"], tw["default"]) == ("Twist", 0, 2, 0)
    r = params["reactivity"]
    assert (r["min"], r["max"], r["default"]) == (0, 2, 1)
    m = params["morph"]
    assert (m["min"], m["max"]) == (0, 1)
    h = params["hatching"]
    assert (h["min"], h["max"]) == (0, 1)
    text = json.dumps(v).lower()
    assert "escher" not in text
    for name in (
        "shaders/tess/tess.glsl",
        "shaders/tess/torus.frag",
        "shaders/tess/torus-disp.frag",
        "shaders/tess/paper.frag",
    ):
        assert (REPOS["builtin"] / name).is_file(), name


def test_poincare_disk_manifest():
    (v,) = [v for v in _manifest("builtin")["visualizers"] if v["id"] == "poincare-disk"]
    assert (v["name"], v["entry"], v["renderer"], v["thumbnail"]) == (
        "Poincaré Disk",
        "src/poincare-disk.js",
        "webgl2",
        "thumbs/poincare-disk.jpg",
    )
    params = {p["id"]: p for p in v["params"]}
    assert list(params) == [
        "scene",
        "camera",
        "spin",
        "tiling",
        "palette",
        "reactivity",
        "speed",
        "morph",
        "ink",
        "hatching",
        "relief",
        "light",
        "look",
        "quality",
    ]
    # Relief and Light as Metamorphosis's (the kites carved like a woodblock; 0 is the print as it
    # was before relief, byte for byte).
    (meta,) = [m for m in _manifest("builtin")["visualizers"] if m["id"] == "metamorphosis"]
    for pid in RELIEF_PARAMS:
        assert params[pid] == {p["id"]: p for p in meta["params"]}[pid], pid
    # Option order is lib/tess-disk.js TILINGS, lib/tess.js PALETTES, tess-music QUALITIES.
    assert params["tiling"]["options"] == ["{7,3}", "{5,4}", "{4,5}", "{6,4}"]
    assert params["tiling"]["default"] == "{7,3}"
    # lib/disk3d.js SCENES and CAMERAS; the sphere scene is the default, flat the print alone.
    assert params["scene"]["options"] == ["flat", "sphere"]
    assert params["scene"]["default"] == "sphere"
    assert params["camera"]["default"] == "auto"
    assert params["camera"]["options"] == ["auto", "still"]
    sp = params["spin"]
    assert (sp["min"], sp["max"], sp["default"]) == (0, 2, 1)
    assert params["palette"]["options"] == ["ink", "dusk", "four-block", "ochre", "watercolour"]
    assert params["quality"]["options"] == ["low", "medium", "high"]
    r = params["reactivity"]
    assert (r["min"], r["max"], r["default"]) == (0, 2, 1)
    for pid in ("morph", "hatching"):
        assert (params[pid]["min"], params[pid]["max"]) == (0, 1)
    # Original work: no artist's name or artwork titles in any string.
    text = json.dumps(v).lower()
    for banned in ("escher", "circle limit"):
        assert banned not in text
    for name in (
        "shaders/tess/tess.glsl",
        "shaders/tess/disk.frag",
        "shaders/tess/disk.glsl",
        "shaders/tess/disk3d.frag",
        "shaders/tess/sphere.glsl",
        "shaders/tess/paper.frag",
        "src/lib/tess-disk.js",
        "src/lib/disk3d.js",
    ):
        assert (REPOS["builtin"] / name).is_file(), name
