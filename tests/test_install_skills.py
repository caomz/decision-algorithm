"""Tests for the repository-level skill installer.

The installer is fail-closed, so the tests that matter most are the ones that
prove it never destroys an existing file, directory, or link without an
explicit opt-in flag.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "install_skills.py"
SPEC = importlib.util.spec_from_file_location("install_skills", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
# dataclasses resolves annotations through sys.modules, so register before exec.
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def is_link(path: Path) -> bool:
    """True for any directory link — POSIX symlink or Windows junction."""
    return MODULE.link_target(path) is not None


def make_row(path: Path, repo_skill: Path, state: str) -> MODULE.Row:
    target = MODULE.link_target(path)
    return MODULE.Row(
        skill=repo_skill.name,
        platform="claude",
        scope="personal",
        path=path,
        state=state,
        resolved=str(target) if target else "",
    )


def test_classify_recognises_every_state(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()

    assert MODULE.classify(tmp_path / "nothing", repo) == MODULE.MISSING

    linked = tmp_path / "linked"
    MODULE.create_link(linked, repo)
    assert MODULE.classify(linked, repo) == MODULE.LINKED

    other = tmp_path / "other"
    other.mkdir()
    upstream = tmp_path / "upstream"
    MODULE.create_link(upstream, other)
    assert MODULE.classify(upstream, repo) == MODULE.UPSTREAM

    copy = tmp_path / "copy"
    copy.mkdir()
    assert MODULE.classify(copy, repo) == MODULE.COPY

    # A link whose target has since been removed is broken, not merely absent.
    gone = tmp_path / "gone"
    gone.mkdir()
    dangling = tmp_path / "dangling"
    MODULE.create_link(dangling, gone)
    shutil.rmtree(gone)
    assert MODULE.classify(dangling, repo) == MODULE.BROKEN

    plain = tmp_path / "plain.txt"
    plain.write_text("x", encoding="utf-8")
    assert MODULE.classify(plain, repo) == MODULE.BROKEN


def test_apply_creates_link_for_missing_and_is_idempotent(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()
    (repo / "SKILL.md").write_text("x", encoding="utf-8")
    link = tmp_path / "skills" / "repo-skill"

    row = make_row(link, repo, MODULE.MISSING)
    MODULE.apply_row(row, repo, relink=False, dry_run=False)

    assert is_link(link)
    assert link.resolve() == repo.resolve()
    assert row.action == "create"
    assert MODULE.classify(link, repo) == MODULE.LINKED

    again = make_row(link, repo, MODULE.LINKED)
    MODULE.apply_row(again, repo, relink=False, dry_run=False)
    assert again.action == "noop"
    assert link.resolve() == repo.resolve()


def test_apply_refuses_to_touch_upstream_without_relink(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    (other / "keep.txt").write_text("keep", encoding="utf-8")
    link = tmp_path / "skills" / "repo-skill"
    link.parent.mkdir(parents=True)
    MODULE.create_link(link, other)

    row = make_row(link, repo, MODULE.UPSTREAM)
    MODULE.apply_row(row, repo, relink=False, dry_run=False)

    assert row.action == "skip"
    assert link.resolve() == other.resolve()
    assert (other / "keep.txt").read_text(encoding="utf-8") == "keep"


def test_apply_relink_repoints_upstream_at_repository(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    link = tmp_path / "skills" / "repo-skill"
    link.parent.mkdir(parents=True)
    MODULE.create_link(link, other)

    row = make_row(link, repo, MODULE.UPSTREAM)
    MODULE.apply_row(row, repo, relink=True, dry_run=False)

    assert row.action == "relink"
    assert link.resolve() == repo.resolve()
    # The upstream directory itself is untouched — only the link moved.
    assert other.is_dir()


def test_apply_relink_backs_up_real_directory_before_linking(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()
    copy = tmp_path / "skills" / "repo-skill"
    copy.mkdir(parents=True)
    (copy / "important.txt").write_text("do not lose me", encoding="utf-8")

    row = make_row(copy, repo, MODULE.COPY)
    MODULE.apply_row(row, repo, relink=True, dry_run=False)

    assert row.action == "adopt"
    assert is_link(copy)
    assert copy.resolve() == repo.resolve()

    backups = list(copy.parent.glob("repo-skill.backup-*"))
    assert len(backups) == 1
    assert (backups[0] / "important.txt").read_text(encoding="utf-8") == "do not lose me"


def test_dry_run_changes_nothing(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()
    link = tmp_path / "skills" / "repo-skill"

    row = make_row(link, repo, MODULE.MISSING)
    MODULE.apply_row(row, repo, relink=False, dry_run=True)

    assert row.action == "create"
    assert not link.exists()
    assert not is_link(link)


def test_uninstall_only_removes_links_into_this_repository(tmp_path) -> None:
    repo = tmp_path / "repo-skill"
    repo.mkdir()
    other = tmp_path / "other"
    other.mkdir()

    ours = tmp_path / "ours"
    MODULE.create_link(ours, repo)
    theirs = tmp_path / "theirs"
    MODULE.create_link(theirs, other)

    our_row = make_row(ours, repo, MODULE.LINKED)
    MODULE.uninstall_row(our_row, repo, dry_run=False)
    assert our_row.action == "unlink"
    assert not is_link(ours)

    their_row = make_row(theirs, repo, MODULE.UPSTREAM)
    MODULE.uninstall_row(their_row, repo, dry_run=False)
    assert their_row.action == "skip"
    assert is_link(theirs)
    assert other.is_dir()


def test_discover_skills_only_picks_directories_with_skill_md(tmp_path, monkeypatch) -> None:
    skills_dir = tmp_path / "skills"
    good = skills_dir / "good"
    good.mkdir(parents=True)
    (good / "SKILL.md").write_text("x", encoding="utf-8")
    (skills_dir / "empty").mkdir()
    (skills_dir / "loose.md").write_text("x", encoding="utf-8")

    monkeypatch.setattr(MODULE, "SKILLS_DIR", skills_dir)
    found = MODULE.discover_skills()

    assert [s.name for s in found] == ["good"]


def test_unknown_skill_name_is_rejected(tmp_path, monkeypatch) -> None:
    skills_dir = tmp_path / "skills"
    good = skills_dir / "good"
    good.mkdir(parents=True)
    (good / "SKILL.md").write_text("x", encoding="utf-8")
    monkeypatch.setattr(MODULE, "SKILLS_DIR", skills_dir)

    with pytest.raises(SystemExit):
        MODULE.main(["--apply", "--skill", "does-not-exist"])


def test_padding_accounts_for_wide_characters() -> None:
    assert MODULE._display_width("缺失") == 4
    assert MODULE._display_width("abc") == 3
    assert len(MODULE._pad("缺失", 10)) == 8  # 4 columns + 6 spaces


def test_fresh_machine_platform_is_only_touched_when_explicit(tmp_path, monkeypatch) -> None:
    """A platform whose skills dir does not exist is skipped unless named.

    On a brand-new machine no platform directory exists yet, so an implicit
    run must not fabricate directories for platforms the user may not even use.
    """
    home = tmp_path / "home"
    (home / ".claude" / "skills").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    # Windows resolves "~" through USERPROFILE first, POSIX through HOME.
    monkeypatch.setenv("USERPROFILE", str(home))

    claude = MODULE.Platform("claude", "Claude Code", "~/.claude/skills")
    codex = MODULE.Platform("codex", "Codex", "~/.codex/skills")

    # claude exists on this machine; codex does not.
    assert MODULE.targets_for(claude, False, explicit=False)[0].exists is True
    assert MODULE.targets_for(codex, False, explicit=False)[0].exists is False

    # Naming it explicitly opts in, and the directory gets created on apply.
    assert MODULE.targets_for(codex, False, explicit=True)[0].exists is True

    repo = tmp_path / "repo-skill"
    repo.mkdir()
    link = home / ".codex" / "skills" / "repo-skill"
    row = make_row(link, repo, MODULE.MISSING)
    MODULE.apply_row(row, repo, relink=False, dry_run=False)
    assert is_link(link)
    assert link.resolve() == repo.resolve()
