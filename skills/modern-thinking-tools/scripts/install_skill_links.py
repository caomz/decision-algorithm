#!/usr/bin/env python3
"""Check or install canonical modern-thinking-tools skill links.

The script is intentionally fail-closed: it creates missing links but never
overwrites an existing file, directory, or mismatched symlink.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CANONICAL = (ROOT / "skills" / "modern-thinking-tools").resolve()


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
    is_link = path.is_symlink()
    exists = path.exists()
    resolved = str(path.resolve(strict=False)) if is_link else ""
    if is_link and Path(resolved) == CANONICAL:
        status = "current"
    elif is_link:
        status = "conflict"
    elif exists:
        status = "conflict"
    else:
        status = "missing"
    return {
        "name": name,
        "path": str(path),
        "status": status,
        "is_symlink": is_link,
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
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(target, target_is_directory=True)
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
