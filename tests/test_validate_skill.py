"""validate_skill.py 的行为测试。

覆盖三件事：
- SKILL.md 与 course_rules.json 各只读一次（不再每个校验方法各读一遍）；
- 关键词抽取按语义片段规范化，不再依赖硬编码词表与「取前 10 个字符」兜底；
- 现行包的校验结果仍是 15 项全 PASS。
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = (
    REPO_ROOT / "skills" / "decision-algorithm" / "dev" / "scripts" / "validate_skill.py"
)
SPEC = importlib.util.spec_from_file_location("validate_skill", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
# 注解里的 Optional/dict 等经由 sys.modules 解析，先注册再执行。
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

SKILL_PATH = REPO_ROOT / "skills" / "decision-algorithm" / "SKILL.md"
KNOWLEDGE_PATH = (
    REPO_ROOT / "skills" / "decision-algorithm" / "knowledge" / "course_rules.json"
)


def test_each_file_is_read_only_once(monkeypatch):
    """SKILL.md 与 course_rules.json 各只读一次。"""
    reads: list[Path] = []
    original_read_text = Path.read_text

    def counting_read_text(self, *args, **kwargs):
        reads.append(self)
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counting_read_text)

    validator = MODULE.SkillValidator(SKILL_PATH, KNOWLEDGE_PATH)
    validator.validate()

    assert reads.count(SKILL_PATH) == 1
    assert reads.count(KNOWLEDGE_PATH) == 1


def test_keywords_are_normalized_semantic_segments():
    """关键词按语义片段抽取，不依赖硬编码词表。"""
    validator = MODULE.SkillValidator(SKILL_PATH, KNOWLEDGE_PATH)

    assert validator._extract_keywords("只做正期望值的事") == ["只做正期望值的事"]
    assert validator._extract_keywords("先干为敬，持续更新") == ["先干为敬", "持续更新"]
    # 旧实现在这里会退化成「取前 10 个字符」的跨标点片段
    assert validator._extract_keywords("控制可控，接受不可控") == ["控制可控", "接受不可控"]
    # 过短的片段没有匹配价值
    assert validator._extract_keywords("的、了。") == []


def test_cross_punctuation_prefix_is_not_a_hit():
    """跨标点的「前 10 字符」片段不再被当成命中。"""
    validator = MODULE.SkillValidator(SKILL_PATH, KNOWLEDGE_PATH)

    principle = "控制可控，接受不可控"
    legacy_fragment = principle[:10]  # 旧实现的兜底：跨标点截断
    assert legacy_fragment == "控制可控，接受不可控"
    assert "，" in legacy_fragment
    # 旧兜底片段不再作为关键词出现，改成两段语义片段
    assert legacy_fragment not in validator._extract_keywords(principle)
    assert validator._extract_keywords(principle) == ["控制可控", "接受不可控"]

    # 正文里没有这条原则 → 判为未覆盖
    body = "决策过程要写下来，方便复盘。"
    segments = MODULE.semantic_segments(body)
    assert validator._principle_covered(principle, segments) is False

    # 只出现其中一段语义 → 仍然判为未覆盖
    body = "控制可控是第一原则。"
    segments = MODULE.semantic_segments(body)
    assert validator._principle_covered(principle, segments) is False

    # 正文里有完整的两段语义 → 判为已覆盖
    body = "控制可控，接受不可控。"
    segments = MODULE.semantic_segments(body)
    assert validator._principle_covered(principle, segments) is True


def test_missing_principle_is_reported_as_failure(tmp_path):
    """SKILL.md 少一条原则时，核心原则校验必须报 FAIL。"""
    original = SKILL_PATH.read_text(encoding="utf-8")
    skill_copy = tmp_path / "SKILL.md"
    skill_copy.write_text(
        original.replace("能力圈比聪明更重要", "能力圈"), encoding="utf-8"
    )

    validator = MODULE.SkillValidator(skill_copy, KNOWLEDGE_PATH)
    results = validator.validate()

    principle_result = next(r for r in results if r.category == "核心原则")
    assert principle_result.passed is False
    assert "能力圈比聪明更重要" in principle_result.detail


def test_current_package_passes_all_checks():
    """现行包的整体验证结果仍是 15 项全 PASS。"""
    validator = MODULE.SkillValidator(SKILL_PATH, KNOWLEDGE_PATH)
    results = validator.validate()

    assert len(results) == 15
    failed = [str(r) for r in results if not r.passed]
    assert failed == []


def test_cli_keeps_exit_code_and_output_shape():
    """CLI 参数、输出类别与退出码保持不变。"""
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--skill",
            str(SKILL_PATH),
            "--knowledge",
            str(KNOWLEDGE_PATH),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )

    assert result.returncode == 0
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(lines) == 15
    assert all(line.startswith("[PASS]") for line in lines)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
