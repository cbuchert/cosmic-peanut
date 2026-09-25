"""Manifest validation: JSON Schema plus semantic checks, with exact error paths."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from tidalviz.plugins.manifest import ManifestError, validate_manifest


def valid() -> dict[str, Any]:
    return {
        "apiVersion": 1,
        "visualizers": [
            {
                "id": "undertow",
                "name": "Undertow",
                "description": "Feedback-warp rings.",
                "author": "Jane Doe",
                "entry": "src/undertow.js",
                "renderer": "webgl2",
                "libs": [],
                "thumbnail": "thumbs/undertow.png",
                "params": [
                    {
                        "id": "speed",
                        "type": "number",
                        "label": "Speed",
                        "min": 0,
                        "max": 2,
                        "step": 0.01,
                        "default": 1,
                    },
                    {"id": "tint", "type": "color", "label": "Tint", "default": "#7cf0ff"},
                    {"id": "mirror", "type": "boolean", "label": "Mirror", "default": False},
                    {
                        "id": "mode",
                        "type": "select",
                        "label": "Mode",
                        "options": ["rings", "bars"],
                        "default": "rings",
                    },
                ],
            }
        ],
    }


def paths(obj: Any) -> list[str]:
    return [e.path for e in validate_manifest(obj)]


def test_valid_manifest_has_no_errors() -> None:
    assert validate_manifest(valid()) == []


def test_error_is_path_and_message() -> None:
    m = valid()
    m["apiVersion"] = 2
    errors = validate_manifest(m)
    assert errors == [ManifestError("apiVersion", errors[0].message)]
    assert errors[0].message


def _set(m: dict[str, Any], path: tuple[Any, ...], value: Any) -> None:
    target: Any = m
    for p in path[:-1]:
        target = target[p]
    target[path[-1]] = value


def _del(m: dict[str, Any], path: tuple[Any, ...]) -> None:
    target: Any = m
    for p in path[:-1]:
        target = target[p]
    del target[path[-1]]


V = ("visualizers", 0)
P = (*V, "params")

SCHEMA_CASES: list[tuple[str, Any, str, str]] = [
    # (case id, mutation, expected path, message substring)
    ("not-object", lambda m: "x", "", "object"),
    ("missing-visualizers", lambda m: _del(m, ("visualizers",)), "visualizers", "required"),
    ("empty-visualizers", lambda m: _set(m, ("visualizers",), []), "visualizers", "at least 1"),
    ("unknown-top-level", lambda m: _set(m, ("extra",), 1), "extra", "not allowed"),
    ("missing-entry", lambda m: _del(m, (*V, "entry")), "visualizers[0].entry", "required"),
    ("bad-id", lambda m: _set(m, (*V, "id"), "Bad_Id"), "visualizers[0].id", "a-z0-9-"),
    ("long-id", lambda m: _set(m, (*V, "id"), "a" * 41), "visualizers[0].id", "a-z0-9-"),
    (
        "bad-renderer",
        lambda m: _set(m, (*V, "renderer"), "vulkan"),
        "visualizers[0].renderer",
        "2d",
    ),
    (
        "absolute-entry",
        lambda m: _set(m, (*V, "entry"), "/etc/passwd"),
        "visualizers[0].entry",
        "relative",
    ),
    (
        "dotdot-entry",
        lambda m: _set(m, (*V, "entry"), "a/../../x.js"),
        "visualizers[0].entry",
        "relative",
    ),
    ("unknown-lib", lambda m: _set(m, (*V, "libs"), ["react"]), "visualizers[0].libs[0]", "three"),
    ("empty-name", lambda m: _set(m, (*V, "name"), ""), "visualizers[0].name", "empty"),
    (
        "unknown-viz-field",
        lambda m: _set(m, (*V, "color"), 1),
        "visualizers[0].color",
        "not allowed",
    ),
    (
        "param-type",
        lambda m: _set(m, (*P, 0, "type"), "slider"),
        "visualizers[0].params[0].type",
        "number",
    ),
    (
        "number-default-type",
        lambda m: _set(m, (*P, 0, "default"), "1"),
        "visualizers[0].params[0].default",
        "number",
    ),
    (
        "number-missing-min",
        lambda m: _del(m, (*P, 0, "min")),
        "visualizers[0].params[0].min",
        "required",
    ),
    (
        "step-zero",
        lambda m: _set(m, (*P, 0, "step"), 0),
        "visualizers[0].params[0].step",
        "greater than 0",
    ),
    (
        "color-default",
        lambda m: _set(m, (*P, 1, "default"), "red"),
        "visualizers[0].params[1].default",
        "#rrggbb",
    ),
    (
        "boolean-default",
        lambda m: _set(m, (*P, 2, "default"), 1),
        "visualizers[0].params[2].default",
        "boolean",
    ),
    (
        "select-no-options",
        lambda m: _del(m, (*P, 3, "options")),
        "visualizers[0].params[3].options",
        "required",
    ),
    (
        "color-extra",
        lambda m: _set(m, (*P, 1, "min"), 0),
        "visualizers[0].params[1].min",
        "not allowed",
    ),
    (
        "param-missing-label",
        lambda m: _del(m, (*P, 2, "label")),
        "visualizers[0].params[2].label",
        "required",
    ),
    (
        "bad-param-id",
        lambda m: _set(m, (*P, 2, "id"), "9x"),
        "visualizers[0].params[2].id",
        "letter",
    ),
]


@pytest.mark.parametrize(
    ("mutate", "path", "fragment"), [c[1:] for c in SCHEMA_CASES], ids=[c[0] for c in SCHEMA_CASES]
)
def test_schema_errors_have_exact_paths(mutate: Any, path: str, fragment: str) -> None:
    m = valid()
    result = mutate(m)
    obj = m if result is None else result
    errors = validate_manifest(obj)
    assert [e.path for e in errors] == [path], errors
    assert fragment.lower() in errors[0].message.lower(), errors[0].message


def two_viz() -> dict[str, Any]:
    m = valid()
    gpu = copy.deepcopy(m["visualizers"][0])
    gpu.update(id="undertow-gpu", renderer="webgpu", fallback="undertow")
    m["visualizers"].append(gpu)
    return m


SEMANTIC_CASES: list[tuple[str, Any, str, str]] = [
    (
        "dup-viz-id",
        lambda m: _set(m, ("visualizers", 1, "id"), "undertow"),
        "visualizers[1].id",
        "duplicate",
    ),
    (
        "default-above-max",
        lambda m: _set(m, (*P, 0, "default"), 3),
        "visualizers[0].params[0].default",
        "between 0 and 2",
    ),
    (
        "default-below-min",
        lambda m: _set(m, (*P, 0, "default"), -1),
        "visualizers[0].params[0].default",
        "between 0 and 2",
    ),
    (
        "min-equals-max",
        lambda m: m["visualizers"][0]["params"][0].update(min=2, default=2),
        "visualizers[0].params[0].max",
        "greater than min",
    ),
    (
        "select-default",
        lambda m: _set(m, (*P, 3, "default"), "waves"),
        "visualizers[0].params[3].default",
        "one of the options",
    ),
    (
        "dup-param-id",
        lambda m: _set(m, (*P, 2, "id"), "speed"),
        "visualizers[0].params[2].id",
        "duplicate",
    ),
    (
        "fallback-on-webgl2",
        lambda m: _set(m, (*V, "fallback"), "undertow-gpu"),
        "visualizers[0].fallback",
        "webgpu",
    ),
    (
        "fallback-missing",
        lambda m: _set(m, ("visualizers", 1, "fallback"), "nope"),
        "visualizers[1].fallback",
        "no visualizer",
    ),
    (
        "fallback-self",
        lambda m: _set(m, ("visualizers", 1, "fallback"), "undertow-gpu"),
        "visualizers[1].fallback",
        "webgpu",
    ),
    (
        "three-needs-lib",
        lambda m: _set(m, (*V, "renderer"), "three"),
        "visualizers[0].libs",
        "three",
    ),
]


@pytest.mark.parametrize(
    ("mutate", "path", "fragment"),
    [c[1:] for c in SEMANTIC_CASES],
    ids=[c[0] for c in SEMANTIC_CASES],
)
def test_semantic_errors_have_exact_paths(mutate: Any, path: str, fragment: str) -> None:
    m = two_viz()
    mutate(m)
    errors = validate_manifest(m)
    assert [e.path for e in errors] == [path], errors
    assert fragment.lower() in errors[0].message.lower(), errors[0].message


def test_two_viz_fixture_with_fallback_is_valid() -> None:
    assert validate_manifest(two_viz()) == []


def test_three_with_lib_is_valid() -> None:
    m = valid()
    m["visualizers"][0].update(renderer="three", libs=["three"])
    assert validate_manifest(m) == []


def test_semantic_checks_tolerate_schema_invalid_input() -> None:
    m = valid()
    m["visualizers"][0]["params"] = [
        {"id": "x", "type": "number", "label": "X", "min": "a", "max": None, "default": 1},
        3,
    ]
    m["visualizers"].append("nope")
    assert validate_manifest(m)  # reports errors, never raises
