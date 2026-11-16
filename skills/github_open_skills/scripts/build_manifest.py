#!/usr/bin/env python3
"""Generate the multi-source manifest from the local skill lock file.

    python3 scripts/build_manifest.py            # 打印预览
    python3 scripts/build_manifest.py --write    # 写入 sources/manifest.json

The manifest is the single source of truth for :mod:`sync_from_github`:

* which upstream each recorded skill comes from
* where inside that upstream it lives
* whether ``--apply`` may overwrite it (``upstream``) or not (``local``)

Provenance is read from ``~/.agents/.skill-lock.json``, which the ``skills``
CLI maintains. Skills that were installed from this repository itself are
marked ``local`` and carry no upstream.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List

ROOT = Path(__file__).resolve().parents[1]
SOURCES_DIR = ROOT / "sources"
MANIFEST = SOURCES_DIR / "manifest.json"
LOCK_PATH = Path(os.path.expanduser("~/.agents/.skill-lock.json"))

REPO_ROOT = "/Volumes/WorkSSD/Dev/decision-algorithm"

# Skills this repository already manages by itself.
OWNED = {
    "whatis": "local",
    "claude-cleanup": "local",
    "break-ai-slop": "local",
    "get-biji": "local",
}

# 交叉验证的两个全局技能仓：MiniMax Code 与 ZCode。
GLOBAL_DIRS = [
    Path(os.path.expanduser("~/.minimax/skills")),
    Path(os.path.expanduser("~/.zcode/skills")),
]


def cross_validated() -> set:
    """技能名出现在两个全局仓里，且内容逐字节一致。

    这就是「mx ∩ zcode 用于交叉验证的 skills」——只有同时被两个宿主装上、
    且内容相同的 skill 才算交叉验证通过。
    """
    sets = []
    for d in GLOBAL_DIRS:
        sets.append({c.name for c in d.iterdir()} if d.is_dir() else set())
    common = set.intersection(*sets) if sets else set()

    import hashlib

    def tree_hash(root: Path) -> str:
        h = hashlib.md5()
        files = []
        for r, dirs, fs in os.walk(root):
            dirs[:] = [x for x in dirs if x not in ("__pycache__", "node_modules", ".git")]
            for f in fs:
                if f.endswith((".pyc", ".pyo")):
                    continue
                files.append(os.path.relpath(os.path.join(r, f), root))
        for rel in sorted(files):
            h.update(rel.encode())
            try:
                h.update(open(os.path.join(root, rel), "rb").read())
            except OSError:
                pass
        return h.hexdigest()

    verified = set()
    for name in common:
        paths = [d / name for d in GLOBAL_DIRS]
        if not all((p / "SKILL.md").is_file() for p in paths):
            continue
        hashes = {tree_hash(p) for p in paths}
        if len(hashes) == 1:
            verified.add(name)
    return verified


def build() -> Dict:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    skills = lock.get("skills", {})
    verified = cross_validated()

    by_repo: Dict[str, Dict[str, str]] = defaultdict(dict)
    wellknown: Dict[str, str] = {}
    untracked: List[str] = []

    for name, entry in sorted(skills.items()):
        if name not in verified:
            continue
        stype = entry.get("sourceType")
        if stype == "github":
            by_repo[entry["source"]][name] = entry.get("skillPath") or ""
        elif stype == "well-known":
            wellknown[name] = entry.get("sourceUrl") or ""

    # 不在 lock 里的交叉验证 skill（如 hallmark）：本地留存，无上游
    for name in sorted(verified - set(skills)):
        untracked.append(name)

    sources = []
    for repo, members in sorted(by_repo.items()):
        sources.append({
            "name": repo.replace("/", "__"),
            "kind": "git",
            "repo": entry_url(repo),
            "display": repo,
            "skills": {
                n: {
                    "path": p,
                    "policy": OWNED.get(n, "upstream"),
                }
                for n, p in sorted(members.items())
            },
        })

    if wellknown:
        sources.append({
            "name": "open-feishu",
            "kind": "wellknown",
            "display": "open.feishu.cn（飞书开放平台，非 GitHub）",
            "baseUrl": "https://open.feishu.cn/.well-known/skills",
            "skills": {
                n: {
                    "path": f"{n}/SKILL.md",
                    "url": u,
                    "policy": "upstream",
                }
                for n, u in sorted(wellknown.items())
            },
        })

    if untracked:
        sources.append({
            "name": "local-untracked",
            "kind": "local",
            "display": "本机自装（不在 skills CLI lock 中）",
            "skills": {n: {"policy": "local"} for n in untracked},
        })

    # 本仓自己管理的 skill：无上游，策略恒为 local
    owned = {n: {"policy": "local"} for n in sorted(OWNED)}
    if owned:
        sources.append({
            "name": "owned-by-this-repo",
            "kind": "local",
            "display": "本仓自管（decision-algorithm 自有 skill 与已定制快照）",
            "skills": owned,
        })

    return {
        "version": 1,
        "generatedFrom": str(LOCK_PATH),
        "crossValidatedAgainst": [str(d) for d in GLOBAL_DIRS],
        "crossValidatedCount": len(verified),
        "repoRoot": REPO_ROOT,
        "sources": sources,
    }


def entry_url(source: str) -> str:
    if source.startswith("http"):
        return source
    if source.startswith("/"):
        return ""
    return f"https://github.com/{source}.git"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    manifest = build()
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"

    total = sum(len(s["skills"]) for s in manifest["sources"])
    print(f"来源 {len(manifest['sources'])} 个，覆盖 skill {total} 个")
    for s in manifest["sources"]:
        print(f"  {s['name']:<42} {len(s['skills']):>3} 个  ({s['kind']})")

    if args.write:
        SOURCES_DIR.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(text, encoding="utf-8")
        print(f"\n已写入 {MANIFEST}")
    else:
        print("\n（预览，加 --write 写入）")
