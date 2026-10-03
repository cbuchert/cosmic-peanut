"""GTK window environment (Linux); the window itself is thin platform code, like `window.py`."""

from pathlib import Path

from tidalviz.window_gtk import configure_gl_environment

VAR = "__NV_DISABLE_EXPLICIT_SYNC"


def test_disables_nvidia_explicit_sync_when_the_nvidia_driver_is_loaded(tmp_path: Path):
    marker = tmp_path / "version"
    marker.write_text("NVRM version: ...")
    env: dict[str, str] = {}
    configure_gl_environment(env, nvidia_marker=marker)
    assert env == {VAR: "1"}


def test_leaves_the_environment_alone_without_the_nvidia_driver(tmp_path: Path):
    env: dict[str, str] = {}
    configure_gl_environment(env, nvidia_marker=tmp_path / "missing")
    assert env == {}


def test_a_value_the_user_set_wins(tmp_path: Path):
    marker = tmp_path / "version"
    marker.write_text("x")
    env = {VAR: "0"}
    configure_gl_environment(env, nvidia_marker=marker)
    assert env == {VAR: "0"}
