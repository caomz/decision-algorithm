#!/usr/bin/env python3
"""Sync skills from GitHub open-source repos into this collection.

    python3 scripts/sync_from_github.py            # 拉取上游并报告差异，不改任何文件
    python3 scripts/sync_from_github.py --apply    # 只更新「上游为准」的 skill
    python3 scripts/sync_from_github.py --list     # 列出来源与版本策略

Design rules:

* **Fail-closed.** 默认只报告，不落盘；只有 ``--apply`` 且该 skill 的策略是
  ``upstream`` 时才会写文件。
* **Never clobber.** 策略为 ``local`` 的 skill（本机定制 / 本机领先版）**永不**
  被覆盖，只输出差异清单，需要时人工合并。
* **Recoverable.** 覆盖前把目标目录整体备份为 ``<name>.backup-<时间戳>``，
  绝不删除数据。
* **Honest.** 上游同步不到的 skill 会被明确标为「同步失败」，不会假装成功。

Standard library only; Python 3.9+.
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = ROOT / "skills"
CACHE_DIR = ROOT / ".cache"
SOURCES_DIR = ROOT / "sources"

UPSTREAM = "upstream"  # 上游为准：--apply 会更新
LOCAL = "local"        # 本机版优先：永不覆盖，只报告

POLICY_LABEL = {
    UPSTREAM: "上游为准",
    LOCAL: "本机版优先",
}


@dataclass(frozen=True)
class Source:
    name: str
    repo: str
    skills: Dict[str, str]  # skill 名 -> 策略


SOURCES: Tuple[Source, ...] = (
    Source(
        name="suyuan-skill",
        repo="https://github.com/suyuan2022/suyuan-skill.git",
        skills={
            "break-ai-slop": LOCAL,
            "claude-cleanup": UPSTREAM,
            "get-biji": LOCAL,
            "whatis": LOCAL,
        },
    ),
)


# ------------------------------------------------------------------ utils ----


def run(cmd: List[str], cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True,
                          capture_output=True, text=True)


def ensure_checkout(source: Source) -> Path:
    """Clone or fast-forward the upstream checkout inside ``.cache/``."""
    dest = CACHE_DIR / source.name
    if not (dest / ".git").is_dir():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--depth", "1", source.repo, str(dest)])
        return dest
    run(["git", "fetch", "--depth", "1", "origin"], cwd=dest)
    run(["git", "reset", "--hard", "FETCH_HEAD"], cwd=dest)
    return dest


def head_commit(path: Path) -> str:
    try:
        return run(["git", "rev-parse", "HEAD"], cwd=path).stdout.strip()
    except subprocess.CalledProcessError:
        return ""


# ---------------------------------------------------------------- compare ----


def compare_dirs(local: Path, upstream: Path) -> Dict[str, List[str]]:
    """Compare two directory trees, ignoring build/runtime noise."""
    ignore_dirs = {".git", "node_modules", "__pycache__", ".pytest_cache"}
    ignore_suffixes = {".pyc", ".pyo"}

    def walk(root: Path) -> Dict[str, Path]:
        out: Dict[str, Path] = {}
        if not root.is_dir():
            return out
        for path in root.rglob("*"):
            rel = path.relative_to(root)
            if any(part in ignore_dirs for part in rel.parts):
                continue
            if path.suffix in ignore_suffixes:
                continue
            if path.is_file():
                out[str(rel)] = path
        return out

    local_files = walk(local)
    upstream_files = walk(upstream)

    result: Dict[str, List[str]] = {
        "same": [], "differs": [], "only_local": [], "only_upstream": [],
    }
    for rel in sorted(set(local_files) | set(upstream_files)):
        if rel not in upstream_files:
            result["only_local"].append(rel)
        elif rel not in local_files:
            result["only_upstream"].append(rel)
        elif filecmp.cmp(local_files[rel], upstream_files[rel], shallow=False):
            result["same"].append(rel)
        else:
            result["differs"].append(rel)
    return result


def fmt_list(items: List[str], limit: int = 8) -> str:
    if not items:
        return "—"
    shown = items[:limit]
    tail = f" (+{len(items) - limit} 个)" if len(items) > limit else ""
    return ", ".join(shown) + tail


# ----------------------------------------------------------------- update ----


def apply_upstream(local: Path, upstream: Path, stamp: str) -> Tuple[Path, List[str]]:
    """Replace ``local`` with ``upstream`` after backing the old one up.

    Local-only files (the provenance ``README.md`` and the like) are carried
    over from the backup instead of being dropped.
    """
    diff = compare_dirs(local, upstream)
    keep = diff["only_local"]

    backup = local.parent / f"{local.name}.backup-{stamp}"
    if backup.exists():
        shutil.rmtree(backup)
    shutil.copytree(local, backup)
    shutil.rmtree(local)
    shutil.copytree(upstream, local, ignore=shutil.ignore_patterns(".git"))

    for rel in keep:
        src = backup / rel
        dst = local / rel
        if not src.is_file():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    return backup, keep


def record_history(source: Source, commit: str, applied: List[str], skipped: List[str]) -> None:
    """Append a machine record and try to insert a row into SYNC.md."""
    src_dir = SOURCES_DIR / source.name
    src_dir.mkdir(parents=True, exist_ok=True)
    (src_dir / "UPSTREAM_COMMIT").write_text(commit + "\n", encoding="utf-8")

    line = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "commit": commit[:7],
        "full_commit": commit,
        "applied": applied,
        "skipped": skipped,
    }
    import json
    with (src_dir / "history.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + "\n")

    sync_md = src_dir / "SYNC.md"
    if not sync_md.is_file():
        return
    text = sync_md.read_text(encoding="utf-8")
    marker = "## 同步历史"
    if marker not in text:
        return
    lines = text.splitlines()
    try:
        head = lines.index(marker)
    except ValueError:
        return
    sep_idx = None
    for i in range(head, len(lines)):
        if lines[i].startswith("|---"):
            sep_idx = i
            break
    if sep_idx is None:
        return
    actions = []
    if applied:
        actions.append("更新 " + "、".join(applied))
    if skipped:
        actions.append("保留本机版 " + "、".join(skipped))
    row = f"| {line['date']} | `{commit[:7]}` | — | 同步 | {'；'.join(actions) or '无变化'} |"
    if row in lines:
        return
    lines.insert(sep_idx + 1, row)
    sync_md.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ------------------------------------------------------------------- main ----


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="从 GitHub 开源项目同步 skill 到本记录仓",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--apply", action="store_true",
                        help="对「上游为准」的 skill 执行更新（其余只报告）")
    parser.add_argument("--list", action="store_true", help="列出来源与版本策略")
    parser.add_argument("--source", help="只处理指定来源")
    parser.add_argument("--skill", action="append", help="只处理指定 skill（可重复）")
    args = parser.parse_args(argv)

    if args.list:
        print(f"{'来源':<16}{'skill':<18}{'策略':<12}本地快照")
        print("-" * 72)
        for src in SOURCES:
            if args.source and src.name != args.source:
                continue
            for skill, policy in src.skills.items():
                if args.skill and skill not in args.skill:
                    continue
                mark = "✓" if (SKILLS_DIR / skill).is_dir() else "—"
                print(f"{src.name:<16}{skill:<18}{POLICY_LABEL[policy]:<12}{mark}")
        return 0

    selected = [s for s in SOURCES if not args.source or s.name == args.source]
    if not selected:
        print(f"找不到来源：{args.source}", file=sys.stderr)
        return 2

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    applied: List[str] = []
    skipped: List[str] = []
    failed: List[str] = []

    for src in selected:
        print(f"\n=== 来源 {src.name} · {src.repo}")
        try:
            checkout = ensure_checkout(src)
        except subprocess.CalledProcessError as exc:
            print(f"  ! 同步失败：{exc.stderr.strip() or exc}")
            failed.append(src.name)
            continue

        commit = head_commit(checkout)
        print(f"  上游 HEAD {commit[:7]}  ({commit[:7]})")

        for skill, policy in src.skills.items():
            if args.skill and skill not in args.skill:
                continue
            upstream_dir = checkout / skill
            local_dir = SKILLS_DIR / skill
            if not upstream_dir.is_dir():
                print(f"  - {skill}: 上游已无此 skill（保留本地）")
                skipped.append(skill)
                continue
            if not local_dir.is_dir():
                print(f"  + {skill}: 本地缺失 → 可直接新增（--apply 会自动复制）")
                if args.apply:
                    shutil.copytree(upstream_dir, local_dir, ignore=shutil.ignore_patterns(".git"))
                    applied.append(skill)
                else:
                    skipped.append(skill)
                continue

            diff = compare_dirs(local_dir, upstream_dir)
            changed = diff["differs"] + diff["only_upstream"] + diff["only_local"]
            tag = "一致" if not changed else f"{len(changed)} 处差异"
            print(f"  ~ {skill} [{POLICY_LABEL[policy]}] {tag}")
            if changed:
                if diff["differs"]:
                    print(f"      内容不同: {fmt_list(diff['differs'])}")
                if diff["only_upstream"]:
                    print(f"      上游独有: {fmt_list(diff['only_upstream'])}")
                if diff["only_local"]:
                    print(f"      本地独有: {fmt_list(diff['only_local'])}")

            if not args.apply:
                continue
            if policy == LOCAL:
                print(f"      跳过：本机版优先，不覆盖")
                skipped.append(skill)
            elif changed:
                backup, kept = apply_upstream(local_dir, upstream_dir, stamp)
                print(f"      已更新上游内容，旧版备份到 {backup.name}")
                if kept:
                    print(f"      保留本地独有文件: {fmt_list(kept)}")
                applied.append(skill)
            else:
                skipped.append(skill)

        if args.apply:
            record_history(src, commit, applied, skipped)

    print()
    if args.apply:
        print(f"完成：已更新 {len(applied)} 个（{', '.join(applied) or '无'}），"
              f"保留本机版 {len(skipped)} 个")
        if failed:
            print(f"失败来源：{', '.join(failed)}", file=sys.stderr)
            return 1
    else:
        print("报告模式，未改动任何文件。加 --apply 才会更新「上游为准」的 skill。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
