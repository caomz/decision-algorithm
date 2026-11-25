"""Tests for skill_writer 的结构化校验。

校验必须 fail closed：缺字段、类型不对、目录/文件约定被破坏的 Skill
都要报出问题并以非 0 退出码结束。
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = (
    REPO_ROOT / "skills" / "decision-algorithm" / "tools" / "skill_writer.py"
)
SPEC = importlib.util.spec_from_file_location("skill_writer", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
# dataclasses 等机制经由 sys.modules 解析注解，先注册再执行。
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

DEFAULT_FRONTMATTER = "---\nname: demo\ndescription: 一个用于测试的示例 Skill\nversion: v1\n---\n"
DEFAULT_BODY = "# 示例\n\n正文内容。\n"


def write_skill(
    directory: Path,
    *,
    name: str = "demo",
    frontmatter: str | None = None,
    body: str | None = None,
    meta: dict | None = None,
) -> Path:
    """在 directory/<name>/ 下生成一个 SKILL.md，返回其路径。"""
    skill_dir = directory / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        (frontmatter if frontmatter is not None else DEFAULT_FRONTMATTER)
        + (body if body is not None else DEFAULT_BODY),
        encoding="utf-8",
    )
    if meta is not None:
        (skill_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8"
        )
    return skill_dir / "SKILL.md"


def issues_for(path: Path) -> list[str]:
    return MODULE.validate_skill_structure(path)


# --------------------------------------------------------------------------
# 合法结构
# --------------------------------------------------------------------------


def test_complete_skill_passes(tmp_path) -> None:
    path = write_skill(
        tmp_path,
        meta={"name": "示例", "slug": "demo", "version": "v1", "entry_point": "SKILL.md"},
    )
    assert issues_for(path) == []
    assert MODULE.validate_skill(path) == 0


@pytest.mark.parametrize(
    "frontmatter",
    [
        # 块标量描述 + 缩进式嵌套 metadata
        "---\nname: demo\ndescription: |\n  第一行\n  触发词：测试\nmetadata:\n  course_skill_contract: \"2\"\n---\n",
        # 行内 JSON 风格的 metadata
        "---\nname: demo\ndescription: 测试\nmetadata: {\"openclaw\": {\"requires\": {\"bins\": [\"python3\"]}}}\n---\n",
        # 折叠标量
        "---\nname: demo\ndescription: >\n  折叠的\n  描述\n---\n",
        # 注释与空行
        "---\n# 注释\nname: demo\n\ndescription: 测试\n---\n",
    ],
)
def test_supported_frontmatter_shapes_pass(tmp_path, frontmatter: str) -> None:
    path = write_skill(tmp_path, frontmatter=frontmatter)
    assert issues_for(path) == []


def test_split_frontmatter_separates_metadata_and_body() -> None:
    meta, body = MODULE.split_frontmatter(
        "---\nname: demo\ndescription: |\n  a\n  b\n---\n\n# 标题\n"
    )
    assert meta == {"name": "demo", "description": "a\nb"}
    assert body.startswith("\n# 标题")


# --------------------------------------------------------------------------
# 文件与 frontmatter 结构
# --------------------------------------------------------------------------


def test_missing_skill_file(tmp_path) -> None:
    issues = issues_for(tmp_path / "nope" / "SKILL.md")
    assert len(issues) == 1
    assert "找不到" in issues[0]
    assert MODULE.validate_skill(tmp_path / "nope") == 1


def test_directory_without_skill_md(tmp_path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert any("找不到" in issue for issue in issues_for(empty))


def test_directory_argument_resolves_to_inner_skill_md(tmp_path) -> None:
    skill_dir = write_skill(tmp_path).parent
    assert issues_for(skill_dir) == []
    assert issues_for(skill_dir / ".") == []
    assert MODULE.validate_skill(skill_dir) == 0


def test_missing_frontmatter_delimiter(tmp_path) -> None:
    path = write_skill(tmp_path, frontmatter="name: demo\ndescription: 测试\n---\n# 标题\n")
    issues = issues_for(path)
    assert any("frontmatter" in issue and "---" in issue for issue in issues)
    assert MODULE.validate_skill(path) == 1


def test_unclosed_frontmatter(tmp_path) -> None:
    path = write_skill(tmp_path, frontmatter="---\nname: demo\ndescription: 测试\n")
    assert any("未闭合" in issue for issue in issues_for(path))


def test_indented_delimiter_inside_block_scalar_is_content(tmp_path) -> None:
    """块标量里缩进的 --- 是描述内容，不会提前闭合 frontmatter。"""
    path = write_skill(
        tmp_path,
        frontmatter="---\nname: demo\ndescription: |\n  第一段\n  ---\n  第二段\n---\n",
    )
    assert issues_for(path) == []


def test_unparsable_frontmatter_line(tmp_path) -> None:
    path = write_skill(
        tmp_path, frontmatter="---\nname: demo\n- 意外的列表项\n---\n# 标题\n"
    )
    assert any("无法解析" in issue for issue in issues_for(path))


def test_non_utf8_file_rejected(tmp_path) -> None:
    path = write_skill(tmp_path)
    path.write_bytes(b"\xff\xfe\x00broken")
    assert any("UTF-8" in issue for issue in issues_for(path))


# --------------------------------------------------------------------------
# 必填字段与类型
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "frontmatter,field",
    [
        ("---\ndescription: 测试\n---\n", "name"),
        ("---\nname: demo\n---\n", "description"),
        ("---\nname: \"\"\ndescription: 测试\n---\n", "name"),
        ("---\nname: demo\ndescription: \"\"\n---\n", "description"),
        ("---\nname:\ndescription: 测试\n---\n", "name"),
    ],
)
def test_missing_required_field(tmp_path, frontmatter: str, field: str) -> None:
    path = write_skill(tmp_path, frontmatter=frontmatter)
    issues = issues_for(path)
    assert any(f"缺少必填字段 {field}" in issue for issue in issues)
    assert MODULE.validate_skill(path) == 1


@pytest.mark.parametrize(
    "frontmatter,fragment",
    [
        ("---\nname: 123\ndescription: 测试\n---\n", "name 必须是字符串"),
        ("---\nname: demo\ndescription: true\n---\n", "description 必须是字符串"),
        ("---\nname: demo\ndescription: 测试\nversion: 1.5\n---\n", "version 必须是字符串"),
        ("---\nname: demo\ndescription: 测试\nmetadata: 纯文本\n---\n", "metadata 必须是映射"),
        ("---\nname: demo\ndescription: 测试\nmetadata: [a, b]\n---\n", "metadata 必须是映射"),
    ],
)
def test_field_type_mismatch(tmp_path, frontmatter: str, fragment: str) -> None:
    path = write_skill(tmp_path, frontmatter=frontmatter)
    assert any(fragment in issue for issue in issues_for(path))


def test_name_must_match_directory(tmp_path) -> None:
    path = write_skill(
        tmp_path, frontmatter="---\nname: other\ndescription: 测试\n---\n"
    )
    assert any("与所在目录名" in issue for issue in issues_for(path))


# --------------------------------------------------------------------------
# 正文约定
# --------------------------------------------------------------------------


def test_empty_body_rejected(tmp_path) -> None:
    path = write_skill(tmp_path, body="")
    assert any("缺少正文" in issue for issue in issues_for(path))


def test_body_without_h1_rejected(tmp_path) -> None:
    path = write_skill(tmp_path, body="只有正文，没有标题。\n")
    assert any("一级 Markdown 标题" in issue for issue in issues_for(path))


# --------------------------------------------------------------------------
# meta.json 约定
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "meta,fragment",
    [
        ({"name": "示例"}, "缺少必填字段 version"),
        ({"version": "v1"}, "缺少必填字段 name"),
        ({}, "缺少必填字段"),
        ({"name": "示例", "version": "v1", "slug": "other"}, "与目录名"),
        ({"name": "示例", "version": "v1", "entry_point": "MISSING.md"}, "entry_point"),
    ],
)
def test_meta_json_problems(tmp_path, meta: dict, fragment: str) -> None:
    path = write_skill(tmp_path, meta=meta)
    issues = issues_for(path)
    assert any("meta.json" in issue and fragment in issue for issue in issues)


def test_meta_json_slug_must_match_frontmatter_name_and_directory(tmp_path) -> None:
    path = write_skill(
        tmp_path,
        frontmatter="---\nname: other\ndescription: 测试\n---\n",
        meta={"name": "示例", "version": "v1", "slug": "demo"},
    )
    issues = issues_for(path)
    assert any("name (other)" in issue and "与所在目录名" in issue for issue in issues)
    assert any("slug (demo)" in issue and "frontmatter name (other)" in issue for issue in issues)


def test_meta_json_top_level_must_be_object(tmp_path) -> None:
    skill_dir = write_skill(tmp_path).parent
    (skill_dir / "meta.json").write_text("[]\n", encoding="utf-8")
    assert any("顶层必须是对象" in issue for issue in issues_for(skill_dir / "SKILL.md"))


def test_meta_json_invalid_json(tmp_path) -> None:
    skill_dir = write_skill(tmp_path).parent
    (skill_dir / "meta.json").write_text("{not json", encoding="utf-8")
    assert any("不是合法 JSON" in issue for issue in issues_for(skill_dir / "SKILL.md"))


def test_meta_json_without_skill_md_alone_is_not_enough(tmp_path) -> None:
    """目录里只有 meta.json、没有 SKILL.md 时仍要报错。"""
    skill_dir = tmp_path / "demo"
    skill_dir.mkdir()
    (skill_dir / "meta.json").write_text(
        json.dumps({"name": "示例", "version": "v1"}), encoding="utf-8"
    )
    assert any("找不到" in issue for issue in issues_for(skill_dir))


# --------------------------------------------------------------------------
# CLI 行为
# --------------------------------------------------------------------------


def run_cli(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *argv],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


def test_cli_valid_skill_exits_zero(tmp_path) -> None:
    path = write_skill(tmp_path)
    proc = run_cli("--action", "validate", "--skill", str(path))
    assert proc.returncode == 0, proc.stderr
    assert "验证通过" in proc.stdout


def test_cli_broken_skill_exits_nonzero_and_reports_on_stderr(tmp_path) -> None:
    path = write_skill(tmp_path, frontmatter="---\nname: demo\n---\n# 标题\n")
    proc = run_cli("--action", "validate", "--skill", str(path))
    assert proc.returncode == 1
    assert "缺少必填字段 description" in proc.stderr


def test_cli_missing_file_exits_nonzero(tmp_path) -> None:
    proc = run_cli("--action", "validate", "--skill", str(tmp_path / "gone"))
    assert proc.returncode == 1
    assert "找不到" in proc.stderr


def test_cli_resolves_skill_name_via_base_dir(tmp_path) -> None:
    write_skill(tmp_path)
    proc = run_cli("--action", "validate", "--skill", "demo", "--base-dir", str(tmp_path))
    assert proc.returncode == 0, proc.stderr


def test_cli_list_still_works(tmp_path) -> None:
    write_skill(tmp_path)
    proc = run_cli("--action", "list", "--base-dir", str(tmp_path))
    assert proc.returncode == 0
    assert "demo" in proc.stdout


# --------------------------------------------------------------------------
# 仓库现状回归：现有 Skill 必须全部通过结构化校验
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "skill_md",
    sorted((REPO_ROOT / "skills").glob("*/SKILL.md"), key=lambda p: p.parent.name),
    ids=lambda p: p.parent.name,
)
def test_every_repo_skill_passes_validation(skill_md: Path) -> None:
    assert MODULE.validate_skill_structure(skill_md) == []
