"""PluginRegistry: built-ins, install/confirm/cancel, updates, rollback, remove, dev folders, disable."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from tests.test_git_fetch import commit_files, plugin_files
from tidalviz.plugins.git import GitFetcher, LimitError, local_transport
from tidalviz.plugins.registry import InstallError, ManifestInvalid, PluginRegistry
from tidalviz.plugins.repo_url import parse_repo_url

URL = "https://example.com/me/viz"
KEY = parse_repo_url(URL).key
DAY = 24 * 3600


def write_plugin(folder: Path, *ids: str) -> Path:
    for rel, text in plugin_files(*ids).items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text)
    return folder


@pytest.fixture
def origin(tmp_path: Path) -> Path:
    return tmp_path / "origin"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "support"


def make(
    root: Path, origin: Path, builtin_dirs: list[Path] | None = None, now: float = 1000.0
) -> PluginRegistry:
    fetcher = GitFetcher(root / "cache", transport=local_transport({URL: origin}))
    return PluginRegistry(root, builtin_dirs or [], fetcher=fetcher, clock=lambda: now)


def install(reg: PluginRegistry, text: str = URL) -> str:
    pending = reg.prepare_install(text)
    return reg.confirm_install(pending.id).commit


# --- built-ins -------------------------------------------------------------


def test_builtin_dirs_register_by_folder_name(tmp_path: Path, root: Path, origin: Path) -> None:
    b = write_plugin(tmp_path / "plugins" / "builtin", "bars", "undertow")
    t = write_plugin(tmp_path / "plugins" / "template", "template")
    reg = make(root, origin, [b, t])
    assert reg.repo_dir("builtin") == b
    assert reg.repo_dir("template") == t
    assert not reg.is_dev("builtin")
    assert [v["key"] for v in reg.visualizers()] == [
        "builtin/bars",
        "builtin/undertow",
        "template/template",
    ]
    repos = {r["repo"]: r for r in reg.repos()}
    assert repos["builtin"] == {
        "repo": "builtin",
        "url": None,
        "path": str(b),
        "commit": None,
        "previous": None,
        "dev": False,
        "builtin": True,
        "errors": [],
    }
    assert reg.entry("builtin", "bars") == {
        "id": "bars",
        "name": "Bars",
        "entry": "src/bars.js",
        "renderer": "2d",
    }
    assert reg.entry("builtin", "nope") is None
    assert reg.entry("nope", "bars") is None
    assert reg.repo_dir("nope") is None


def test_viz_info_fields(tmp_path: Path, root: Path, origin: Path) -> None:
    b = write_plugin(tmp_path / "builtin", "bars")
    reg = make(root, origin, [b])
    (info,) = reg.visualizers()
    assert info == {
        "key": "builtin/bars",
        "repo": "builtin",
        "id": "bars",
        "name": "Bars",
        "description": "",
        "author": "",
        "renderer": "2d",
        "params": [],
        "libs": [],
        "fallback": None,
        "entry": "src/bars.js",
        "thumbnail": None,
        "disabled": False,
        "dev": False,
        "builtin": True,
    }


# --- install ---------------------------------------------------------------


def test_prepare_install_reports_trust_prompt_data(root: Path, origin: Path) -> None:
    sha = commit_files(origin, plugin_files("a", "b"), "hello")
    reg = make(root, origin)
    pending = reg.prepare_install(URL)
    assert pending.commit == sha
    assert pending.spec.key == KEY
    assert pending.visualizers == [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]
    assert pending.warnings == []
    assert pending.temp_dir.is_dir()
    assert reg.visualizers() == []  # nothing registered until confirmed


def test_confirm_install_moves_into_read_only_store(root: Path, origin: Path) -> None:
    sha = commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    pending = reg.prepare_install(URL)
    record = reg.confirm_install(pending.id)
    assert (record.key, record.url, record.ref, record.commit, record.previous) == (
        KEY,
        URL,
        None,
        sha,
        None,
    )
    assert record.installed_at == 1000.0
    store = root / "plugins" / KEY / sha
    assert reg.repo_dir(KEY) == store
    assert (store / "src/a.js").read_text() == "// a\n"
    assert not (store / "src/a.js").stat().st_mode & stat.S_IWUSR
    assert not (store / "src").stat().st_mode & stat.S_IWUSR
    assert not pending.temp_dir.exists()
    assert list((root / "cache").glob("*")) == []
    assert [v["key"] for v in reg.visualizers()] == [f"{KEY}/a"]
    (info,) = reg.repos()
    assert info["commit"] == sha and info["url"] == URL and not info["builtin"] and not info["dev"]


def test_install_persists_across_restart_and_works_offline(
    root: Path, origin: Path, tmp_path: Path
) -> None:
    sha = commit_files(origin, plugin_files("a"))
    install(make(root, origin))
    offline = PluginRegistry(
        root, [], fetcher=GitFetcher(root / "cache", transport=local_transport({}))
    )
    assert offline.repo_dir(KEY) == root / "plugins" / KEY / sha
    assert [v["key"] for v in offline.visualizers()] == [f"{KEY}/a"]
    saved = json.loads((root / "registry.json").read_text())
    assert saved["repos"][KEY]["commit"] == sha


def test_install_with_tag_ref(root: Path, origin: Path) -> None:
    from dulwich import porcelain

    v1 = commit_files(origin, plugin_files("a"))
    porcelain.tag_create(str(origin), "v1", annotated=True, message="v1", author=b"A <a@b.c>")
    commit_files(origin, {"src/a.js": "// newer\n"})
    reg = make(root, origin)
    pending = reg.prepare_install("https://example.com/me/viz#v1")
    assert pending.commit == v1
    assert reg.confirm_install(pending.id).ref == "v1"


def test_cancel_install_deletes_temp(root: Path, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    pending = reg.prepare_install(URL)
    reg.cancel_install(pending.id)
    assert not pending.temp_dir.exists()
    assert list((root / "cache").glob("*")) == []
    with pytest.raises(InstallError):
        reg.confirm_install(pending.id)


def test_invalid_manifest_raises_errors_and_deletes_temp(root: Path, origin: Path) -> None:
    files = plugin_files("a")
    files["tidalviz.json"] = json.dumps(
        {
            "apiVersion": 1,
            "visualizers": [{"id": "a", "name": "A", "entry": "missing.js", "renderer": "2d"}],
        }
    )
    commit_files(origin, files)
    reg = make(root, origin)
    with pytest.raises(ManifestInvalid) as exc:
        reg.prepare_install(URL)
    assert [e.path for e in exc.value.errors] == ["visualizers[0].entry"]
    assert list((root / "cache").glob("*")) == []


def test_limit_violation_propagates(root: Path, origin: Path) -> None:
    commit_files(origin, {**plugin_files("a"), **{f"x/{i}": "" for i in range(8)}})
    fetcher = GitFetcher(root / "cache", transport=local_transport({URL: origin}))
    fetcher.limits = type(fetcher.limits)(max_files=5)
    reg = PluginRegistry(root, [], fetcher=fetcher)
    with pytest.raises(LimitError):
        reg.prepare_install(URL)


def test_bad_url_is_install_error(root: Path, origin: Path) -> None:
    with pytest.raises(InstallError, match="SSH"):
        make(root, origin).prepare_install("git@github.com:a/b.git")


def test_installing_twice_is_an_error(root: Path, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    with pytest.raises(InstallError, match="already installed"):
        reg.prepare_install(URL)


# --- updates / rollback / remove --------------------------------------------


def test_check_updates_at_most_daily_and_never_applies(root: Path, origin: Path) -> None:
    first = commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    assert reg.check_updates(now=2000.0) == []
    second = commit_files(origin, {"src/a.js": "// 2\n"}, "Faster rings\n\nDetails")
    assert reg.check_updates(now=2000.0 + DAY - 1) == []  # checked < 24 h ago
    updates = reg.check_updates(now=2000.0 + DAY)
    assert updates == [{"repo": KEY, "commit": second[:7], "message": "Faster rings"}]
    assert reg.repo_dir(KEY) == root / "plugins" / KEY / first  # not applied
    # Cached result is reported without refetching, and survives a restart.
    offline = PluginRegistry(
        root, [], fetcher=GitFetcher(root / "cache", transport=local_transport({}))
    )
    assert offline.check_updates(now=2000.0 + DAY + 5) == updates


def test_check_updates_skips_unreachable_repos(root: Path, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    install(make(root, origin))
    offline = PluginRegistry(
        root, [], fetcher=GitFetcher(root / "cache", transport=local_transport({}))
    )
    assert offline.check_updates(now=10 * DAY) == []


def test_update_then_rollback_then_prune(root: Path, origin: Path) -> None:
    c1 = commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    c2 = commit_files(origin, {"src/a.js": "// 2\n"}, "two")
    pending = reg.update(KEY)
    assert pending.commit == c2
    rec = reg.confirm_install(pending.id)
    assert (rec.commit, rec.previous) == (c2, c1)
    assert (reg.repo_dir(KEY) or Path()).joinpath("src/a.js").read_text() == "// 2\n"
    assert reg.check_updates(now=10 * DAY) == []

    # Rollback: no network needed.
    offline = PluginRegistry(
        root, [], fetcher=GitFetcher(root / "cache", transport=local_transport({}))
    )
    rec = offline.rollback(KEY)
    assert (rec.commit, rec.previous) == (c1, c2)
    assert (offline.repo_dir(KEY) or Path()).joinpath("src/a.js").read_text() == "// a\n"

    # A third commit: only current + previous are kept on disk.
    c3 = commit_files(origin, {"src/a.js": "// 3\n"}, "three")
    reg = make(root, origin)
    rec = reg.confirm_install(reg.update(KEY).id)
    assert (rec.commit, rec.previous) == (c3, c1)
    assert sorted(p.name for p in (root / "plugins" / KEY).iterdir()) == sorted([c1, c3])


def test_update_validates_new_commit(root: Path, origin: Path) -> None:
    c1 = commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    commit_files(origin, {"tidalviz.json": "{}"}, "broken")
    with pytest.raises(ManifestInvalid):
        reg.update(KEY)
    assert reg.repo_dir(KEY) == root / "plugins" / KEY / c1


def test_update_when_current_is_an_error(root: Path, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    with pytest.raises(InstallError, match="up to date"):
        reg.update(KEY)


def test_rollback_without_previous_is_an_error(root: Path, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    with pytest.raises(InstallError, match="previous"):
        reg.rollback(KEY)


def test_remove_deletes_store_and_record(root: Path, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    reg.disable(f"{KEY}/a")
    reg.remove(KEY)
    assert reg.repo_dir(KEY) is None
    assert not (root / "plugins" / KEY).exists()
    assert reg.visualizers() == []
    assert PluginRegistry(root, []).repos() == []
    assert json.loads((root / "registry.json").read_text())["disabled"] == []


def test_builtins_cannot_be_removed(tmp_path: Path, root: Path, origin: Path) -> None:
    reg = make(root, origin, [write_plugin(tmp_path / "builtin", "bars")])
    with pytest.raises(InstallError):
        reg.remove("builtin")


def test_missing_store_dir_reports_error_not_crash(root: Path, origin: Path) -> None:
    sha = commit_files(origin, plugin_files("a"))
    reg = make(root, origin)
    install(reg)
    store = root / "plugins" / KEY / sha
    for p in [store, *store.rglob("*")]:
        if p.is_dir():
            p.chmod(0o755)
    import shutil

    shutil.rmtree(root / "plugins" / KEY)
    again = PluginRegistry(root, [])
    assert again.visualizers() == []
    (info,) = again.repos()
    assert info["errors"]


def test_stale_fetch_dirs_are_cleaned_on_start(root: Path, origin: Path) -> None:
    (root / "cache" / "fetch-leftover").mkdir(parents=True)
    make(root, origin)
    assert not (root / "cache" / "fetch-leftover").exists()


# --- disable ---------------------------------------------------------------


def test_disable_enable_persist(tmp_path: Path, root: Path, origin: Path) -> None:
    b = write_plugin(tmp_path / "builtin", "bars")
    reg = make(root, origin, [b])
    reg.disable("builtin/bars")
    assert reg.visualizers()[0]["disabled"] is True
    assert make(root, origin, [b]).visualizers()[0]["disabled"] is True
    reg.enable("builtin/bars")
    assert make(root, origin, [b]).visualizers()[0]["disabled"] is False


# --- dev folders -----------------------------------------------------------


def test_add_dev_folder_registers_in_place(tmp_path: Path, root: Path, origin: Path) -> None:
    folder = write_plugin(tmp_path / "My Viz!", "pulse")
    reg = make(root, origin)
    key = reg.add_dev_folder(folder)
    assert key.startswith("dev-my-viz-") and len(key.rsplit("-", 1)[1]) == 8
    assert reg.is_dev(key)
    assert reg.repo_dir(key) == folder.resolve()
    assert [v["key"] for v in reg.visualizers()] == [f"{key}/pulse"]
    assert reg.visualizers()[0]["dev"] is True
    assert not (root / "plugins").exists() or not any((root / "plugins").iterdir())
    # Persisted
    again = make(root, origin)
    assert again.is_dev(key) and again.repo_dir(key) == folder.resolve()
    assert again.add_dev_folder(folder) == key  # idempotent


def test_dev_folder_must_validate(tmp_path: Path, root: Path, origin: Path) -> None:
    (tmp_path / "empty").mkdir()
    with pytest.raises(ManifestInvalid):
        make(root, origin).add_dev_folder(tmp_path / "empty")


def test_dev_folder_reload_keeps_last_good_manifest(
    tmp_path: Path, root: Path, origin: Path
) -> None:
    folder = write_plugin(tmp_path / "viz", "pulse")
    reg = make(root, origin)
    key = reg.add_dev_folder(folder)
    (folder / "tidalviz.json").write_text("{ broken")
    errors = reg.reload(key)
    assert errors and errors[0].path == "tidalviz.json"
    assert [v["key"] for v in reg.visualizers()] == [f"{key}/pulse"]  # last good kept
    (info,) = reg.repos()
    assert info["errors"] == [{"path": errors[0].path, "message": errors[0].message}]
    write_plugin(folder, "pulse", "second")
    assert reg.reload(key) == []
    assert [v["id"] for v in reg.visualizers()] == ["pulse", "second"]


def test_dev_folder_missing_at_startup_is_kept_with_error(
    tmp_path: Path, root: Path, origin: Path
) -> None:
    folder = write_plugin(tmp_path / "viz", "pulse")
    key = make(root, origin).add_dev_folder(folder)
    import shutil

    shutil.rmtree(folder)
    again = make(root, origin)
    assert again.is_dev(key)
    assert again.visualizers() == []
    assert again.repos()[0]["errors"]


def test_remove_dev_folder_never_deletes_files(tmp_path: Path, root: Path, origin: Path) -> None:
    folder = write_plugin(tmp_path / "viz", "pulse")
    reg = make(root, origin)
    key = reg.add_dev_folder(folder)
    reg.remove(key)
    assert (folder / "tidalviz.json").exists()
    assert reg.repos() == []
    assert make(root, origin).repos() == []


def test_dev_folders_listed(tmp_path: Path, root: Path, origin: Path) -> None:
    folder = write_plugin(tmp_path / "viz", "pulse")
    reg = make(root, origin)
    key = reg.add_dev_folder(folder)
    assert reg.dev_folders() == {key: folder.resolve()}
    assert reg.repos()[0] == {
        "repo": key,
        "url": None,
        "path": str(folder.resolve()),
        "commit": None,
        "previous": None,
        "dev": True,
        "builtin": False,
        "errors": [],
    }
    assert os.path.isabs(reg.repos()[0]["path"])
