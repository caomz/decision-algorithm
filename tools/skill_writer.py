#!/usr/bin/env python3
"""
Skill Writer - 决策算法 Skill 文件管理工具

用法：
    python skill_writer.py --action list
    python skill_writer.py --action validate --skill /path/to/SKILL.md
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def list_skills(base_dir: Path) -> int:
    """列出所有可用的 Skill"""
    skill_dirs = list(base_dir.glob("*/SKILL.md"))
    if not skill_dirs:
        print("未找到任何 Skill")
        return 0

    print(f"找到 {len(skill_dirs)} 个 Skill:\n")
    for skill_path in sorted(skill_dirs):
        meta_path = skill_path.parent / "meta.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            name = meta.get("name", skill_path.parent.name)
            version = meta.get("version", "unknown")
            print(f"  - {name} ({version})")
            print(f"    路径: {skill_path.parent}")
        else:
            print(f"  - {skill_path.parent.name}")
            print(f"    路径: {skill_path.parent}")
        print()

    return 0


def validate_skill(skill_path: Path) -> int:
    """验证 Skill 文件结构"""
    if not skill_path.exists():
        print(f"错误：找不到 {skill_path}", file=sys.stderr)
        return 1

    content = skill_path.read_text(encoding="utf-8")
    issues = []

    # 检查 frontmatter
    if not content.startswith("---"):
        issues.append("缺少 YAML frontmatter")

    # 检查必要部分
    if "PART A" not in content and "Part A" not in content:
        issues.append("缺少 Part A 决策工作流")

    if "PART B" not in content and "Part B" not in content:
        issues.append("缺少 Part B 决策顾问人格")

    # 检查核心公式
    if "期望值" not in content:
        issues.append("缺少期望值相关内容")

    if "凯利" not in content:
        issues.append("缺少凯利公式相关内容")

    if "贝叶斯" not in content:
        issues.append("缺少贝叶斯相关内容")

    if issues:
        print(f"验证失败，发现 {len(issues)} 个问题：\n")
        for issue in issues:
            print(f"  - {issue}")
        return 1

    print("验证通过！Skill 结构完整。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Skill 文件管理工具")
    parser.add_argument(
        "--action",
        choices=["list", "validate"],
        required=True,
        help="操作类型",
    )
    parser.add_argument("--skill", help="SKILL.md 文件路径")
    parser.add_argument("--base-dir", default=".", help="项目根目录")

    args = parser.parse_args()
    base_dir = Path(args.base_dir).expanduser()

    if args.action == "list":
        return list_skills(base_dir)
    elif args.action == "validate":
        skill_path = Path(args.skill).expanduser() if args.skill else base_dir / "SKILL.md"
        return validate_skill(skill_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
