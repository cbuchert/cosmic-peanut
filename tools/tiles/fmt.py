"""Species files' house style: two-space JSON with numbers, points and point lists kept on one
line each, so a file reads like the drawing and diffs stay small."""

from __future__ import annotations

import json
import re
from typing import Any

# An array holding only numbers, or only arrays of numbers (a point list), printed inline.
_INLINE = re.compile(r"\[\s*(?:-?[\d.eE+-]+\s*,\s*)*-?[\d.eE+-]+\s*\]")


def dumps(data: Any) -> str:
    text = json.dumps(data, indent=2, ensure_ascii=False)

    def squash(m: re.Match[str]) -> str:
        return re.sub(r"\s+", " ", m.group(0)).replace("[ ", "[").replace(" ]", "]")

    text = _INLINE.sub(squash, text)
    # Point lists: [ [x, y], [x, y] ] onto one line.
    text = re.sub(
        r"\[\s*((?:\[[^\[\]]*\],\s*)*\[[^\[\]]*\])\s*\]",
        lambda m: "[" + re.sub(r",\s+", ", ", m.group(1)) + "]",
        text,
    )
    return text + "\n"
