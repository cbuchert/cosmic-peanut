"""Field validation for shell → host control messages (docs/protocols.md §4)."""

import math
from collections.abc import Callable, Mapping
from typing import Any


class ShellMessageError(ValueError):
    """A known message type with missing or mistyped fields."""


Check = Callable[[Any], bool]


def _str(v: Any) -> bool:
    return isinstance(v, str)


def _bool(v: Any) -> bool:
    return isinstance(v, bool)


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _count(v: Any) -> bool:
    return _int(v) and v >= 0


def _obj(v: Any) -> bool:
    return isinstance(v, dict)


def _one_of(*options: str) -> Check:
    return lambda v: isinstance(v, str) and v in options


# type -> {field: (check, required)}
_SCHEMAS: dict[str, dict[str, tuple[Check, bool]]] = {
    "heartbeat": {"t": (_num, True)},
    "select": {"key": (_str, True)},
    "params": {"key": (_str, True), "values": (_obj, True)},
    "setSource": {"id": (_str, True)},
    "settings": {
        "quality": (_str, False),
        "reduceFlashing": (_bool, False),
        "autoCycleSeconds": (_num, False),
        "hudVisible": (_bool, False),
    },
    "pluginError": {
        "key": (_str, True),
        "message": (_str, True),
        "file": (_str, False),
        "line": (_int, False),
        "fatal": (_bool, True),
    },
    "perf": {
        "key": (_str, True),
        **{
            name: (_num, True)
            for name in (
                "fps",
                "frameMsP50",
                "frameMsP99",
                "pluginMsP50",
                "shellMs",
                "renderScale",
                "dropped",
            )
        },
    },
    "onsetSeen": {"frameIndex": (_count, True)},
    "install": {"url": (_str, True)},
    "installConfirm": {"id": (_str, True), "accept": (_bool, True)},
    "addFolder": {"path": (_str, False)},
    "update": {"repo": (_str, True)},
    "rollback": {"repo": (_str, True)},
    "remove": {"repo": (_str, True)},
    "enable": {"key": (_str, True)},
    "openPermissions": {},
    "window": {"action": (_one_of("fullscreen", "floatOnTop", "borderless", "quit"), True)},
}

SHELL_MESSAGE_TYPES = frozenset(_SCHEMAS)


def validate_shell_message(msg: Mapping[str, Any]) -> bool:
    """True for a valid known message, False for an unknown type (to be ignored).

    Raises ShellMessageError when ``type`` is missing or not a string, or when a known type has
    a missing or mistyped field. Extra fields are allowed (``settings`` is a partial object).
    """
    kind = msg.get("type")
    if not isinstance(kind, str):
        raise ShellMessageError("message has no string 'type'")
    schema = _SCHEMAS.get(kind)
    if schema is None:
        return False
    for name, (check, required) in schema.items():
        if name not in msg:
            if required:
                raise ShellMessageError(f"{kind}: missing field {name!r}")
            continue
        if not check(msg[name]):
            raise ShellMessageError(f"{kind}: bad value for field {name!r}")
    return True
