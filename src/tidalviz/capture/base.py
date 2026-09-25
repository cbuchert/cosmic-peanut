"""Source protocol and the paced base shared by file and synthetic sources."""

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from tidalviz.frame import F32

OnSamples = Callable[[F32, float], None]


@dataclass(frozen=True, slots=True)
class SourceFormat:
    sample_rate: float
    channels: int


class AudioSource(Protocol):
    failed: threading.Event

    @property
    def format(self) -> SourceFormat: ...

    def start(self, on_samples: OnSamples) -> None: ...

    def stop(self) -> None: ...
