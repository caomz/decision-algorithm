"""Tests for the decision-algorithm version manager.

cleanup must never treat *_before_rollback backups as disposable versions,
and a failed rollback must be observable by callers through a non-zero exit
code plus a printed reason.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "decision-algorithm"
    / "tools"
    / "version_manager.py"
)
SPEC = importlib.util.spec_from_file_location("version_manager", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

BASE = 1700000000.0  # Fixed epoch so mtimes are deterministic and ordered.


def make_skill_dir(tmp_path: Path) -> Path:
    skill_dir = tmp_path / "decision-algorithm"
    (skill_dir / "versions").mkdir(parents=True)
    return skill_dir


def make_version(skill_dir: Path, name: str, marker: str | None = None) -> Path:
    v_dir = skill_dir / "versions" / name
    v_dir.mkdir()
    (v_dir / "SKILL.md").write_text(marker or name, encoding="utf-8")
    return v_dir


def set_mtime(path: Path, timestamp: float) -> None:
    os.utime(path, (timestamp, timestamp))


def run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        capture_output=True,
        text=True,
    )


def test_cleanup_keeps_before_rollback_backups(tmp_path) -> None:
    skill_dir = make_skill_dir(tmp_path)
    for i, name in enumerate(["v1", "v2", "v3"]):
        make_version(skill_dir, name)
        set_mtime(skill_dir / "versions" / name, BASE + i)
    backup = make_version(skill_dir, "v3_before_rollback")
    # The backup is the oldest entry, so the buggy behaviour deletes it first.
    set_mtime(backup, BASE - 10000)

    MODULE.cleanup_old_versions(skill_dir, max_versions=2)

    assert backup.is_dir()
    survivors = sorted(d.name for d in (skill_dir / "versions").iterdir())
    assert survivors == ["v2", "v3", "v3_before_rollback"]


def test_cleanup_does_not_count_backups_toward_limit(tmp_path) -> None:
    skill_dir = make_skill_dir(tmp_path)
    for i, name in enumerate(["v1", "v2", "v3"]):
        make_version(skill_dir, name)
        set_mtime(skill_dir / "versions" / name, BASE + i)
    backup = make_version(skill_dir, "v2_before_rollback")
    set_mtime(backup, BASE + 100)

    # Three real versions fit exactly; the backup must not steal a slot.
    MODULE.cleanup_old_versions(skill_dir, max_versions=3)

    assert backup.is_dir()
    assert (skill_dir / "versions" / "v1").is_dir()
    assert (skill_dir / "versions" / "v2").is_dir()
    assert (skill_dir / "versions" / "v3").is_dir()


def test_rollback_missing_version_returns_false_with_reason(tmp_path, capsys) -> None:
    skill_dir = make_skill_dir(tmp_path)

    assert MODULE.rollback(skill_dir, "v99") is False

    err = capsys.readouterr().err
    assert "v99" in err


def test_cli_rollback_failure_exits_nonzero(tmp_path) -> None:
    skill_dir = make_skill_dir(tmp_path)

    proc = run_cli("--action", "rollback", "--skill-dir", str(skill_dir), "--version", "v99")

    assert proc.returncode != 0
    assert "v99" in proc.stderr


def test_cli_rollback_success_exits_zero_and_backs_up_current(tmp_path) -> None:
    skill_dir = make_skill_dir(tmp_path)
    (skill_dir / "meta.json").write_text(
        json.dumps({"version": "v2"}), encoding="utf-8"
    )
    (skill_dir / "SKILL.md").write_text("v2-current", encoding="utf-8")
    target = make_version(skill_dir, "v1")
    (target / "work.md").write_text("v1-work", encoding="utf-8")

    proc = run_cli("--action", "rollback", "--skill-dir", str(skill_dir), "--version", "v1")

    assert proc.returncode == 0
    assert (skill_dir / "SKILL.md").read_text(encoding="utf-8") == "v1"
    assert (skill_dir / "work.md").read_text(encoding="utf-8") == "v1-work"
    backup = skill_dir / "versions" / "v2_before_rollback"
    assert (backup / "SKILL.md").read_text(encoding="utf-8") == "v2-current"


def test_rollback_backup_survives_later_cleanup(tmp_path) -> None:
    skill_dir = make_skill_dir(tmp_path)
    (skill_dir / "meta.json").write_text(
        json.dumps({"version": "v3"}), encoding="utf-8"
    )
    (skill_dir / "SKILL.md").write_text("v3-current", encoding="utf-8")
    make_version(skill_dir, "v1")

    proc = run_cli("--action", "rollback", "--skill-dir", str(skill_dir), "--version", "v1")
    assert proc.returncode == 0
    backup = skill_dir / "versions" / "v3_before_rollback"
    assert backup.is_dir()

    # Make the backup the oldest entry: the buggy cleanup deletes exactly it.
    set_mtime(backup, BASE - 10000)
    set_mtime(skill_dir / "versions" / "v1", BASE)

    MODULE.cleanup_old_versions(skill_dir, max_versions=1)

    assert backup.is_dir()
    assert (backup / "SKILL.md").read_text(encoding="utf-8") == "v3-current"
    assert (skill_dir / "versions" / "v1").is_dir()
