"""PCM producers (docs/protocols.md §2) and the ring buffer they feed."""

from tidalviz.capture.base import AudioSource, OnSamples, SourceFormat
from tidalviz.capture.catap_source import (
    AudioApp,
    CatapAppSource,
    CatapSystemSource,
    list_audio_apps,
)
from tidalviz.capture.file import FileSource, read_wav
from tidalviz.capture.ring import RingBuffer
from tidalviz.capture.synthetic import SyntheticSource

__all__ = [
    "AudioApp",
    "AudioSource",
    "CatapAppSource",
    "CatapSystemSource",
    "FileSource",
    "OnSamples",
    "RingBuffer",
    "SourceFormat",
    "SyntheticSource",
    "list_audio_apps",
    "read_wav",
]
