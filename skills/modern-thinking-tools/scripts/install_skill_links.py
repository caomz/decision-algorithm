#!/usr/bin/env python3
"""Check or install canonical modern-thinking-tools skill links.

The script is intentionally fail-closed: it creates missing links but never
overwrites an existing file, directory, or mismatched symlink.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CANONICAL = (ROOT / "skills" / "modern-thinking-tools").resolve()

IS_WINDOWS = os.name == "nt"


def link_target(path: Path) -> Path | None:
    """Resolve a directory link (POSIX symlink or Windows junction)."""
    if path.is_symlink():
        return path.resolve(strict=False)
    if IS_WINDOWS:
        try:
            raw = os.readlink(str(path))
        except (OSError, ValueError):
            return None
        if raw.startswith("\\\\?\\"):
            raw = raw[4:]
        return Path(raw)
    return None


def create_link(link: Path, target: Path) -> None:
    """Create a directory link, falling back to a junction when needed.

    A junction needs no ``SeCreateSymbolicLinkPrivilege``, so the skill links
    still work on a stock Windows install.
    """
    link.parent.mkdir(parents=True, exist_ok=True)
    absolute = target if target.is_absolute() else (link.parent / target).resolve()
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        if not IS_WINDOWS:
            raise
    proc = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(absolute)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise OSError(
            "创建目录链接失败："
            f"mklink /J → {proc.stderr.strip() or proc.stdout.strip()}"
        )


def link_targets() -> list[tuple[str, Path, str]]:
    project_relative = "../../skills/modern-thinking-tools"
    return [
        (
            "project_codex",
            ROOT / ".codex" / "skills" / "modern-thinking-tools",
            project_relative,
        ),
        (
            "project_claude",
            ROOT / ".claude" / "skills" / "modern-thinking-tools",
            project_relative,
        ),
        (
            "personal_claude",
            Path.home() / ".claude" / "skills" / "modern-thinking-tools",
            str(CANONICAL),
        ),
    ]


def inspect_link(name: str, path: Path) -> dict[str, str | bool]:
    target = link_target(path)
    exists = path.exists()
    resolved = str(target) if target else ""
    if target is not None and target.exists():
        status = "current" if Path(resolved) == CANONICAL else "conflict"
    elif target is not None:
        status = "conflict"  # a link whose target is gone
    elif exists:
        status = "conflict"
    else:
        status = "missing"
    return {
        "name": name,
        "path": str(path),
        "status": status,
        "is_symlink": target is not None,
        "resolved": resolved,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="report drift without changing links")
    mode.add_argument("--apply", action="store_true", help="create missing links without overwriting")
    args = parser.parse_args()

    if not (CANONICAL / "SKILL.md").is_file():
        parser.error(f"canonical skill is missing: {CANONICAL / 'SKILL.md'}")

    results: list[dict[str, str | bool]] = []
    conflict = False
    missing = False
    for name, path, target in link_targets():
        result = inspect_link(name, path)
        if result["status"] == "conflict":
            conflict = True
        elif result["status"] == "missing":
            missing = True
            if args.apply:
                create_link(path, Path(target))
                result = inspect_link(name, path)
        results.append(result)

    print(
        json.dumps(
            {
                "ok": not conflict and all(item["status"] == "current" for item in results),
                "mode": "apply" if args.apply else "check",
                "canonical": str(CANONICAL),
                "links": results,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if conflict:
        return 2
    if args.check and missing:
        return 1
    return 0 if all(item["status"] == "current" for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
