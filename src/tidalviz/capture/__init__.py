"""PCM producers (docs/protocols.md §2) and the ring buffer they feed."""

import sys

from tidalviz.capture.base import AudioSource, OnSamples, SourceFormat
from tidalviz.capture.file import FileSource, read_wav
from tidalviz.capture.ring import RingBuffer
from tidalviz.capture.synthetic import SyntheticSource

__all__ = [
    "AudioApp",
    "AudioSource",
    "FileSource",
    "OnSamples",
    "RingBuffer",
    "SourceFormat",
    "SyntheticSource",
    "app_source",
    "list_audio_apps",
    "read_wav",
    "system_source",
]

# The platform's capture backend (the rest of the package is portable): catap on macOS,
# PipeWire elsewhere (Linux). Each branch defines the same four names.
if sys.platform == "darwin":
    from tidalviz.capture.catap_source import (
        AudioApp,
        CatapAppSource,
        CatapSystemSource,
        list_audio_apps,
    )

    __all__ += ["CatapAppSource", "CatapSystemSource"]

    def system_source() -> AudioSource:
        return CatapSystemSource()

    def app_source(app: AudioApp) -> AudioSource:
        return CatapAppSource(app.name)

else:
    from tidalviz.capture.pipewire_source import (
        AudioApp,
        PipeWireAppSource,
        PipeWireSystemSource,
        list_audio_apps,
    )

    __all__ += ["PipeWireAppSource", "PipeWireSystemSource"]

    def system_source() -> AudioSource:
        return PipeWireSystemSource()

    def app_source(app: AudioApp) -> AudioSource:
        return PipeWireAppSource(app)
