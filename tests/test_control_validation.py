"""Validation of shell → host control messages (docs/protocols.md §4)."""

from typing import Any

import pytest

from tidalviz.transport.control_schema import ShellMessageError, validate_shell_message

VALID: list[dict[str, Any]] = [
    {"type": "heartbeat", "t": 12.5},
    {"type": "heartbeat", "t": 3},
    {"type": "select", "key": "builtin/bars"},
    {"type": "params", "key": "builtin/bars", "values": {"gain": 1.0, "color": "#ff0000"}},
    {"type": "setSource", "id": "system"},
    {"type": "settings", "quality": "auto"},
    {"type": "settings", "reduceFlashing": True, "autoCycleSeconds": 30, "hudVisible": False},
    {"type": "settings", "somethingNew": [1, 2]},
    {"type": "pluginError", "key": "a/b", "message": "boom", "fatal": False},
    {
        "type": "pluginError",
        "key": "a/b",
        "message": "boom",
        "file": "x.js",
        "line": 3,
        "fatal": True,
    },
    {
        "type": "perf",
        "key": "a/b",
        "fps": 60,
        "frameMsP50": 4.2,
        "frameMsP99": 9.1,
        "pluginMsP50": 1.5,
        "shellMs": 0.3,
        "renderScale": 1,
        "dropped": 0,
    },
    {"type": "onsetSeen", "frameIndex": 1234},
    {"type": "install", "url": "https://github.com/a/b"},
    {"type": "installConfirm", "id": "abc", "accept": True},
    {"type": "addFolder"},
    {"type": "addFolder", "path": "/Users/me/viz"},
    {"type": "update", "repo": "gh/a/b"},
    {"type": "rollback", "repo": "gh/a/b"},
    {"type": "remove", "repo": "gh/a/b"},
    {"type": "enable", "key": "a/b"},
    {"type": "window", "action": "fullscreen"},
    {"type": "window", "action": "floatOnTop"},
    {"type": "window", "action": "borderless"},
    {"type": "window", "action": "quit"},
]

INVALID: list[dict[str, Any]] = [
    {"type": "heartbeat"},
    {"type": "heartbeat", "t": "now"},
    {"type": "heartbeat", "t": True},
    {"type": "select"},
    {"type": "select", "key": 5},
    {"type": "select", "key": None},
    {"type": "params", "key": "a/b"},
    {"type": "params", "key": "a/b", "values": [1]},
    {"type": "setSource", "id": 1},
    {"type": "settings", "quality": 3},
    {"type": "settings", "reduceFlashing": "yes"},
    {"type": "settings", "autoCycleSeconds": "30"},
    {"type": "settings", "hudVisible": 1},
    {"type": "pluginError", "key": "a/b", "message": "boom"},
    {"type": "pluginError", "key": "a/b", "message": {"html": 1}, "fatal": False},
    {"type": "pluginError", "key": "a/b", "message": "m", "line": "3", "fatal": False},
    {"type": "pluginError", "key": "a/b", "message": "m", "line": 1.5, "fatal": False},
    {"type": "pluginError", "key": "a/b", "message": "m", "file": 1, "fatal": False},
    {"type": "perf", "key": "a/b", "fps": 60},
    {
        "type": "perf",
        "key": "a/b",
        "fps": "60",
        "frameMsP50": 4.2,
        "frameMsP99": 9.1,
        "pluginMsP50": 1.5,
        "shellMs": 0.3,
        "renderScale": 1,
        "dropped": 0,
    },
    {"type": "onsetSeen", "frameIndex": -1},
    {"type": "onsetSeen", "frameIndex": 1.5},
    {"type": "onsetSeen"},
    {"type": "install", "url": ["x"]},
    {"type": "installConfirm", "id": "abc"},
    {"type": "installConfirm", "id": "abc", "accept": "yes"},
    {"type": "addFolder", "path": 7},
    {"type": "update"},
    {"type": "rollback", "repo": 1},
    {"type": "remove", "repo": None},
    {"type": "enable", "key": False},
    {"type": "window", "action": "explode"},
    {"type": "window"},
]


@pytest.mark.parametrize("msg", VALID, ids=lambda m: m["type"])
def test_valid_messages_pass(msg: dict[str, Any]) -> None:
    assert validate_shell_message(msg) is True


@pytest.mark.parametrize("msg", INVALID, ids=lambda m: m["type"])
def test_invalid_messages_raise(msg: dict[str, Any]) -> None:
    with pytest.raises(ShellMessageError):
        validate_shell_message(msg)


@pytest.mark.parametrize("msg", [{"type": "nope"}, {"type": "hello", "version": 1}])
def test_unknown_types_are_not_valid_but_not_errors(msg: dict[str, Any]) -> None:
    assert validate_shell_message(msg) is False


@pytest.mark.parametrize("msg", [{}, {"type": 1}, {"kind": "select"}])
def test_missing_or_bad_type_raises(msg: dict[str, Any]) -> None:
    with pytest.raises(ShellMessageError):
        validate_shell_message(msg)
