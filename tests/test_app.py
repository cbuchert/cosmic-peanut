from pathlib import Path

from tidalviz.app import builtin_dirs, parse_args


def test_defaults():
    a = parse_args([])
    assert a.dev is None and a.source is None and a.bench is None and a.seconds == 60


def test_dev_folder_and_source(tmp_path: Path):
    a = parse_args(["--dev", str(tmp_path), "--source", "synthetic:demo"])
    assert a.dev == tmp_path and a.source == "synthetic:demo"


def test_bench(tmp_path: Path):
    a = parse_args(["--bench", "builtin/bars", "--seconds", "5", "--out", str(tmp_path / "r.json")])
    assert (a.bench, a.seconds, a.out) == ("builtin/bars", 5, tmp_path / "r.json")


def test_builtin_dirs_exist_with_manifests():
    dirs = builtin_dirs()
    assert [d.name for d in dirs] == ["builtin", "template"]
    assert all((d / "tidalviz.json").is_file() for d in dirs)
