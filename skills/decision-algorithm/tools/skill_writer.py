#!/usr/bin/env python3
"""
Skill Writer - 决策算法 Skill 文件管理工具

用法：
    python skill_writer.py --action list
    python skill_writer.py --action validate --skill /path/to/SKILL.md
    python skill_writer.py --action validate --skill /path/to/skill-dir

validate 会对 SKILL.md 做真正的结构化校验：frontmatter 必填字段与类型、
正文约定（非空、含一级标题）、目录/文件约定（name 与目录名一致、
meta.json 合法且与目录一致），任何一条不通过都以非 0 退出码报错。
frontmatter 解析只支持仓库实际使用的 YAML 子集，遇到无法解析的行直接报错。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REQUIRED_FRONTMATTER_FIELDS = ("name", "description")
REQUIRED_META_JSON_FIELDS = ("name", "version")


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


class FrontmatterError(ValueError):
    """frontmatter 不是仓库约定的合法结构。"""


# 仅支持仓库 SKILL.md 实际用到的 YAML 子集：顶层键、嵌套映射、
# 块标量（| 与 >）、带引号/裸标量、行内 {…} /[…] 结构。
_KEY_RE = re.compile(r"^(?P<key>[A-Za-z0-9_-]+):(?:[ \t](?P<value>.*))?$")
_BLOCK_SCALARS = ("|", "|-", "|+", ">", ">-", ">+")
_INT_RE = re.compile(r"^[+-]?\d+$")
_FLOAT_RE = re.compile(r"^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$")
_NULL_VALUES = ("~", "null", "Null", "NULL")
_BOOL_VALUES = ("true", "True", "TRUE", "false", "False", "FALSE")


def split_frontmatter(text: str) -> tuple[dict, str]:
    """把 SKILL.md 拆成 (frontmatter 映射, 正文)，结构非法时抛 FrontmatterError。"""
    lines = text.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        raise FrontmatterError("文件必须以独立的 --- 行开始 YAML frontmatter")

    end = None
    for idx in range(1, len(lines)):
        raw_line = lines[idx]
        # 结束分隔符必须顶格；块标量里缩进的 --- 是正文内容，不算分隔符。
        if raw_line.rstrip() == "---" and not raw_line.startswith((" ", "\t")):
            end = idx
            break
    if end is None:
        raise FrontmatterError("frontmatter 未闭合：缺少结束的 --- 行")

    meta = _parse_mapping(lines[1:end], first_line_no=2)
    return meta, "\n".join(lines[end + 1 :])


def _parse_mapping(lines: list[str], first_line_no: int) -> dict:
    """按缩进解析受支持的 YAML 子集，无法识别的行直接报错（fail closed）。"""
    root: dict = {}
    # 栈元素: (键的缩进, 该键下的容器)。哨兵根容器缩进取 -1。
    stack: list[tuple[int, dict]] = [(-1, root)]
    i = 0
    while i < len(lines):
        raw = lines[i]
        line_no = first_line_no + i
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        leading = raw[: len(raw) - len(raw.lstrip())]
        if "\t" in leading:
            raise FrontmatterError(f"第 {line_no} 行：YAML 缩进不允许使用 Tab")
        indent = len(leading)
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]

        match = _KEY_RE.match(stripped)
        if not match:
            raise FrontmatterError(f"第 {line_no} 行无法解析: {stripped}")
        key = match.group("key")
        value_raw = (match.group("value") or "").strip()
        i += 1

        if value_raw == "":
            # 空值：后续缩进更深的行构成嵌套映射，否则视为 null。
            child_indent = _next_meaningful_indent(lines, i)
            if child_indent is not None and child_indent > indent:
                child: dict = {}
                container[key] = child
                stack.append((indent, child))
            else:
                container[key] = None
            continue

        if value_raw in _BLOCK_SCALARS:
            block, i = _read_block(lines, i, indent, keep_trailing=value_raw.endswith("+"))
            container[key] = "\n".join(block)
            continue

        container[key] = _coerce_scalar(value_raw)
    return root


def _next_meaningful_indent(lines: list[str], start: int) -> int | None:
    for idx in range(start, len(lines)):
        stripped = lines[idx].strip()
        if stripped and not stripped.startswith("#"):
            return len(lines[idx]) - len(lines[idx].lstrip(" "))
    return None


def _read_block(lines: list[str], start: int, key_indent: int, keep_trailing: bool) -> tuple[list[str], int]:
    """收集块标量内容，去掉块缩进；折叠标量(>)按字面行拼接即可满足校验需求。"""
    collected: list[str] = []
    block_indent: int | None = None
    i = start
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            collected.append("")
            i += 1
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent <= key_indent:
            break
        if block_indent is None:
            block_indent = indent
        collected.append(line[block_indent:])
        i += 1
    while collected and collected[-1] == "" and not keep_trailing:
        collected.pop()
    return collected, i


def _coerce_scalar(value: str):
    """把标量按 YAML 核心类型归类，用于字段类型校验。"""
    if value.startswith("{") and value.endswith("}"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {}  # 形状是映射但非 JSON 细节，类型校验够用
    if value.startswith("[") and value.endswith("]"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return []
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    if value in _NULL_VALUES:
        return None
    if value in _BOOL_VALUES:
        return value.lower() == "true"
    if _INT_RE.match(value):
        return int(value)
    if _FLOAT_RE.match(value):
        return float(value)
    return value


def _type_name(value) -> str:
    if isinstance(value, bool):
        return "布尔值"
    if isinstance(value, (int, float)):
        return "数字"
    if isinstance(value, str):
        return "字符串"
    if isinstance(value, list):
        return "序列"
    if isinstance(value, dict):
        return "映射"
    if value is None:
        return "null"
    return type(value).__name__


def _resolve_skill_file(skill_path: Path, issues: list[str]) -> Path | None:
    """目录参数解析为目录内的 SKILL.md；找不到合法文件时记录问题并返回 None。"""
    path = skill_path
    if path.is_dir():
        path = path / "SKILL.md"
    if not path.exists():
        issues.append(f"找不到 Skill 文件: {skill_path}")
        return None
    if not path.is_file():
        issues.append(f"不是常规文件: {skill_path}")
        return None
    # 规范化路径：相对路径（如 --skill .）的 parent.name 是空串，
    # 先 resolve 才能拿到真实目录名做约定比对。
    return path.resolve()


def validate_skill_structure(skill_path: Path) -> list[str]:
    """对单个 Skill 做结构化校验，返回全部问题；空列表表示通过。"""
    issues: list[str] = []
    path = _resolve_skill_file(skill_path, issues)
    if path is None:
        return issues

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        issues.append(f"无法按 UTF-8 读取文件: {exc}")
        return issues

    skill_dir = path.parent
    try:
        meta, body = split_frontmatter(text)
    except FrontmatterError as exc:
        issues.append(f"frontmatter 结构非法：{exc}")
        return issues

    _check_frontmatter(meta, skill_dir, issues)
    _check_body(body, issues)
    _check_meta_json(skill_dir, meta, issues)
    return issues


def _check_frontmatter(meta: dict, skill_dir: Path, issues: list[str]) -> None:
    for field in REQUIRED_FRONTMATTER_FIELDS:
        value = meta.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            issues.append(f"缺少必填字段 {field}")

    name = meta.get("name")
    if name is not None and not isinstance(name, str):
        issues.append(f"字段 name 必须是字符串，实际是 {_type_name(name)}")
    elif isinstance(name, str) and name.strip() and name != skill_dir.name:
        issues.append(f"name ({name}) 与所在目录名 ({skill_dir.name}) 不一致")

    description = meta.get("description")
    if description is not None and not isinstance(description, str):
        issues.append(f"字段 description 必须是字符串，实际是 {_type_name(description)}")

    version = meta.get("version")
    if version is not None and not isinstance(version, str):
        issues.append(f"字段 version 必须是字符串，实际是 {_type_name(version)}")

    metadata = meta.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        issues.append(f"字段 metadata 必须是映射（对象），实际是 {_type_name(metadata)}")


def _check_body(body: str, issues: list[str]) -> None:
    if not body.strip():
        issues.append("frontmatter 之后缺少正文")
        return
    if not re.search(r"(?m)^# \S", body):
        issues.append("正文缺少一级 Markdown 标题（以 \"# \" 开头的行）")


def _check_meta_json(skill_dir: Path, meta: dict, issues: list[str]) -> None:
    meta_path = skill_dir / "meta.json"
    if not meta_path.exists():
        return
    try:
        raw = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        issues.append(f"meta.json 不是合法 JSON: {exc}")
        return
    if not isinstance(raw, dict):
        issues.append(f"meta.json 顶层必须是对象，实际是 {_type_name(raw)}")
        return

    for field in REQUIRED_META_JSON_FIELDS:
        value = raw.get(field)
        if not isinstance(value, str) or not value.strip():
            issues.append(f"meta.json 缺少必填字段 {field} 或其不是非空字符串")

    slug = raw.get("slug")
    if slug is not None:
        if not isinstance(slug, str):
            issues.append(f"meta.json 字段 slug 必须是字符串，实际是 {_type_name(slug)}")
        elif slug != skill_dir.name:
            issues.append(f"meta.json slug ({slug}) 与目录名 ({skill_dir.name}) 不一致")
        elif isinstance(meta.get("name"), str) and slug != meta["name"]:
            issues.append(f"meta.json slug ({slug}) 与 frontmatter name ({meta['name']}) 不一致")

    entry_point = raw.get("entry_point")
    if entry_point is not None:
        if not isinstance(entry_point, str) or not entry_point.strip():
            issues.append(f"meta.json 字段 entry_point 必须是非空字符串，实际是 {_type_name(entry_point)}")
        elif not (skill_dir / entry_point).is_file():
            issues.append(f"meta.json entry_point 指向的文件不存在: {entry_point}")


def validate_skill(skill_path: Path) -> int:
    """验证 Skill 文件结构；有问题打印到 stderr 并返回 1。"""
    issues = validate_skill_structure(Path(skill_path).expanduser())
    if issues:
        print(f"验证失败，发现 {len(issues)} 个问题：", file=sys.stderr)
        for issue in issues:
            print(f"  - {issue}", file=sys.stderr)
        return 1

    print("验证通过！Skill 结构完整。")
    return 0


def _resolve_skill_arg(raw: Path, base_dir: Path) -> Path:
    """--skill 给的相对路径不存在时，再按 --base-dir 解析一次。"""
    if raw.is_absolute() or raw.exists():
        return raw
    candidate = base_dir / raw
    return candidate if candidate.exists() else raw


def main() -> int:
    parser = argparse.ArgumentParser(description="Skill 文件管理工具")
    parser.add_argument(
        "--action",
        choices=["list", "validate"],
        required=True,
        help="操作类型",
    )
    parser.add_argument("--skill", help="SKILL.md 文件路径（也可以是其所在目录）")
    parser.add_argument("--base-dir", default=".", help="项目根目录")

    args = parser.parse_args()
    base_dir = Path(args.base_dir).expanduser()

    if args.action == "list":
        return list_skills(base_dir)
    elif args.action == "validate":
        if args.skill:
            skill_path = _resolve_skill_arg(Path(args.skill).expanduser(), base_dir)
        else:
            skill_path = base_dir / "SKILL.md"
        return validate_skill(skill_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
