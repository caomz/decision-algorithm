from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "install_skill_links.py"
SPEC = importlib.util.spec_from_file_location("modern_thinking_links", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_inspect_link_distinguishes_current_missing_and_conflict(tmp_path, monkeypatch) -> None:
    canonical = tmp_path / "canonical"
    canonical.mkdir()
    monkeypatch.setattr(MODULE, "CANONICAL", canonical.resolve())

    current = tmp_path / "current"
    MODULE.create_link(current, canonical)
    assert MODULE.inspect_link("current", current)["status"] == "current"

    assert MODULE.inspect_link("missing", tmp_path / "missing")["status"] == "missing"

    conflict = tmp_path / "conflict"
    conflict.write_text("not a link", encoding="utf-8")
    assert MODULE.inspect_link("conflict", conflict)["status"] == "conflict"
