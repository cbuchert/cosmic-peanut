"""Content types for served files. A fixed table, so results don't depend on the machine."""

from pathlib import PurePath

_TEXT = "; charset=utf-8"
_TYPES: dict[str, str] = {
    ".js": "text/javascript" + _TEXT,
    ".mjs": "text/javascript" + _TEXT,
    ".json": "application/json" + _TEXT,
    ".map": "application/json" + _TEXT,
    ".wasm": "application/wasm",
    ".glsl": "text/plain" + _TEXT,
    ".frag": "text/plain" + _TEXT,
    ".vert": "text/plain" + _TEXT,
    ".wgsl": "text/plain" + _TEXT,
    ".txt": "text/plain" + _TEXT,
    ".css": "text/css" + _TEXT,
    ".html": "text/html" + _TEXT,
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".ktx2": "image/ktx2",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
}
DEFAULT = "application/octet-stream"


def content_type_for(path: PurePath) -> str:
    return _TYPES.get(path.suffix.lower(), DEFAULT)
