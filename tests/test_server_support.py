"""Helpers shared by the server tests (no tests here)."""

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class RawResponse:
    status: int
    headers: dict[str, str]
    body: bytes


async def raw_request(
    port: int, target: str, *, host: str | None = None, method: str = "GET", version: str = "1.1"
) -> RawResponse:
    """Send a request byte-for-byte (no client-side normalization of the path or Host)."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    lines = [f"{method} {target} HTTP/{version}"]
    if host is not None:
        lines.append(f"Host: {host}")
    lines += ["Connection: close", "", ""]
    writer.write("\r\n".join(lines).encode("latin-1"))
    await writer.drain()
    data = await reader.read()
    writer.close()
    await writer.wait_closed()
    head, _, body = data.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode("latin-1").split("\r\n")
    headers: dict[str, str] = {}
    for line in header_lines:
        k, _, v = line.partition(":")
        headers[k.strip().lower()] = v.strip()
    return RawResponse(int(status_line.split()[1]), headers, body)


@dataclass
class FakeRegistry:
    repos: dict[str, Path] = field(default_factory=dict[str, Path])
    entries: dict[tuple[str, str], Mapping[str, Any]] = field(
        default_factory=dict[tuple[str, str], Mapping[str, Any]]
    )
    dev: set[str] = field(default_factory=set[str])

    def repo_dir(self, repo_key: str) -> Path | None:
        return self.repos.get(repo_key)

    def entry(self, repo_key: str, viz_id: str) -> Mapping[str, Any] | None:
        return self.entries.get((repo_key, viz_id))

    def is_dev(self, repo_key: str) -> bool:
        return repo_key in self.dev
