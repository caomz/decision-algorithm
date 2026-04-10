#!/usr/bin/env python3
"""
版本管理器

负责 Skill 文件的版本存档和回滚。

用法：
    python version_manager.py --action list --skill-dir ./decision-algorithm
    python version_manager.py --action rollback --skill-dir ./decision-algorithm --version v2
    python version_manager.py --action cleanup --skill-dir ./decision-algorithm
"""

from __future__ import annotations

import json
import shutil
import argparse
import sys
from pathlib import Path
from datetime import datetime, timezone

MAX_VERSIONS = 10  # 最多保留的版本数


def list_versions(skill_dir: Path) -> list:
    """列出所有历史版本"""
    versions_dir = skill_dir / "versions"
    if not versions_dir.exists():
        return []

    versions = []
    for v_dir in sorted(versions_dir.iterdir()):
        if not v_dir.is_dir():
            continue

        version_name = v_dir.name
        mtime = v_dir.stat().st_mtime
        archived_at = datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        files = [f.name for f in v_dir.iterdir() if f.is_file()]

        versions.append({
            "version": version_name,
            "archived_at": archived_at,
            "files": files,
            "path": str(v_dir),
        })

    return versions


def rollback(skill_dir: Path, target_version: str) -> bool:
    """回滚到指定版本"""
    version_dir = skill_dir / "versions" / target_version

    if not version_dir.exists():
        print(f"错误：版本 {target_version} 不存在", file=sys.stderr)
        return False

    # 先存档当前版本
    meta_path = skill_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        current_version = meta.get("version", "v?")
        backup_dir = skill_dir / "versions" / f"{current_version}_before_rollback"
        backup_dir.mkdir(parents=True, exist_ok=True)
        for fname in ("SKILL.md", "work.md", "persona.md"):
            src = skill_dir / fname
            if src.exists():
                shutil.copy2(src, backup_dir / fname)

    # 从目标版本恢复文件
    restored_files = []
    for fname in ("SKILL.md", "work.md", "persona.md"):
        src = version_dir / fname
        if src.exists():
            shutil.copy2(src, skill_dir / fname)
            restored_files.append(fname)

    # 更新 meta
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["version"] = target_version + "_restored"
        meta["updated_at"] = datetime.now(timezone.utc).isoformat()
        meta["rollback_from"] = current_version
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"已回滚到 {target_version}，恢复文件：{', '.join(restored_files)}")
    return True


def cleanup_old_versions(skill_dir: Path, max_versions: int = MAX_VERSIONS):
    """清理超出限制的旧版本"""
    versions_dir = skill_dir / "versions"
    if not versions_dir.exists():
        return

    version_dirs = sorted(
        [d for d in versions_dir.iterdir() if d.is_dir()],
        key=lambda d: d.stat().st_mtime,
    )

    to_delete = version_dirs[:-max_versions] if len(version_dirs) > max_versions else []

    for old_dir in to_delete:
        shutil.rmtree(old_dir)
        print(f"已清理旧版本：{old_dir.name}")


def backup(skill_dir: Path) -> Path:
    """创建当前版本的备份"""
    meta_path = skill_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        current_version = meta.get("version", "v1")
    else:
        current_version = "v1"

    backup_dir = skill_dir / "versions" / current_version
    backup_dir.mkdir(parents=True, exist_ok=True)

    for fname in ("SKILL.md", "work.md", "persona.md"):
        src = skill_dir / fname
        if src.exists():
            shutil.copy2(src, backup_dir / fname)

    return backup_dir


def main():
    parser = argparse.ArgumentParser(description="决策算法 Skill 版本管理器")
    parser.add_argument(
        "--action",
        required=True,
        choices=["list", "rollback", "cleanup", "backup"],
    )
    parser.add_argument(
        "--skill-dir",
        default=".",
        help="Skill 根目录（默认：当前目录）",
    )
    parser.add_argument(
        "--version",
        help="目标版本号（rollback 时使用）",
    )
    parser.add_argument(
        "--max-versions",
        type=int,
        default=MAX_VERSIONS,
        help=f"最多保留的版本数（默认：{MAX_VERSIONS}）",
    )

    args = parser.parse_args()
    skill_dir = Path(args.skill_dir).expanduser().resolve()

    if not skill_dir.exists():
        print(f"错误：找不到 Skill 目录 {skill_dir}", file=sys.stderr)
        sys.exit(1)

    if args.action == "list":
        versions = list_versions(skill_dir)
        if not versions:
            print(f"{skill_dir.name} 暂无历史版本")
        else:
            print(f"{skill_dir.name} 的历史版本：\n")
            for v in versions:
                print(f"  {v['version']}  存档时间: {v['archived_at']}  文件: {', '.join(v['files'])}")

    elif args.action == "rollback":
        if not args.version:
            print("错误：rollback 操作需要 --version", file=sys.stderr)
            sys.exit(1)
        rollback(skill_dir, args.version)

    elif args.action == "cleanup":
        cleanup_old_versions(skill_dir, args.max_versions)
        print("清理完成")

    elif args.action == "backup":
        backup_dir = backup(skill_dir)
        print(f"已备份到：{backup_dir}")


if __name__ == "__main__":
    main()
