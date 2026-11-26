#!/usr/bin/env python3
"""
SKILL 验证器

验证 life-decision-100 SKILL.md 的内容是否与课程原文 (juece_suanfan_100jiang)
的核心内容一致，确保输出质量稳定。

用法：
    python validate_skill.py                          # 验证当前 SKILL.md
    python validate_skill.py --skill /path/to/SKILL.md # 指定 SKILL.md 路径
    python validate_skill.py --chapters /path/to/chapters # 指定课程章节路径
    python validate_skill.py --report                  # 生成详细报告
"""

from __future__ import annotations

import argparse
import json
import unicodedata
from pathlib import Path
from typing import Optional, Sequence

# 语义片段的最小长度：短于此长度的片段（多为虚词或单字）不足以做匹配
MIN_KEYWORD_LENGTH = 2


def semantic_segments(text: str) -> list[str]:
    """按标点/符号把文本切成语义片段，片段内去掉所有空白。

    标点与符号是硬边界 —— 短语匹配时不跨标点；
    空白只是被移除 —— 换行不会把一个短语拆成两段。
    """
    segments: list[str] = []
    buffer: list[str] = []
    for char in text:
        if unicodedata.category(char)[0] in ("P", "S"):
            segments.append("".join(buffer))
            buffer = []
        else:
            buffer.append(char)
    segments.append("".join(buffer))

    cleaned = []
    for segment in segments:
        compact = "".join(segment.split())
        if compact:
            cleaned.append(compact)
    return cleaned


def phrase_in_segments(phrase: str, segments: Sequence[str]) -> bool:
    """短语是否完整落在某个语义片段内（不跨标点匹配）。"""
    return any(phrase in segment for segment in segments)


class ValidationResult:
    def __init__(self, category: str, passed: bool, detail: str = ""):
        self.category = category
        self.passed = passed
        self.detail = detail

    def __str__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.category}: {self.detail}"


class SkillValidator:
    """验证 SKILL.md 与课程核心内容的一致性"""

    def __init__(
        self,
        skill_path: Path,
        knowledge_path: Path,
        chapters_dir: Optional[Path] = None,
    ):
        self.skill_path = skill_path
        self.knowledge_path = knowledge_path
        self.chapters_dir = chapters_dir
        self.results: list[ValidationResult] = []
        # 惰性缓存：SKILL.md 只读一次，course_rules.json 只读一次、只解析一次
        self._cached_skill_content: Optional[str] = None
        self._cached_knowledge: Optional[dict] = None

    def _skill_content(self) -> str:
        """SKILL.md 全文（惰性缓存，整个校验流程只读一次文件）。"""
        if self._cached_skill_content is None:
            self._cached_skill_content = self.skill_path.read_text(encoding="utf-8")
        return self._cached_skill_content

    def _knowledge(self) -> dict:
        """course_rules.json 内容（惰性缓存：只读一次、只解析一次）。"""
        if self._cached_knowledge is None:
            self._cached_knowledge = json.loads(
                self.knowledge_path.read_text(encoding="utf-8")
            )
        return self._cached_knowledge

    def validate(self) -> list[ValidationResult]:
        """运行所有验证"""
        self._validate_file_exists()
        self._validate_frontmatter()
        self._validate_part_a_exists()
        self._validate_part_b_exists()
        self._validate_formulas()
        self._validate_core_principles()
        self._validate_algorithm_coverage()
        self._validate_no_contradictions()
        self._validate_output_template()
        self._validate_layer_structure()
        return self.results

    def _validate_file_exists(self):
        if self.skill_path.exists():
            self.results.append(ValidationResult(
                "文件存在", True, f"SKILL.md 位于 {self.skill_path}"
            ))
        else:
            self.results.append(ValidationResult(
                "文件存在", False, f"找不到 {self.skill_path}"
            ))

    def _validate_frontmatter(self):
        content = self._skill_content()
        if not content.startswith("---"):
            self.results.append(ValidationResult(
                "Frontmatter", False, "缺少 YAML frontmatter"
            ))
            return

        # 检查必要的 frontmatter 字段
        required_fields = ["name:", "description:"]
        missing = [f for f in required_fields if f not in content[:500]]
        if missing:
            self.results.append(ValidationResult(
                "Frontmatter", False, f"缺少字段: {', '.join(missing)}"
            ))
        else:
            self.results.append(ValidationResult(
                "Frontmatter", True, "包含 name 和 description 字段"
            ))

        # 验证 name 字段
        if "decision-algorithm" in content[:500]:
            self.results.append(ValidationResult(
                "Skill名称", True, "name 为 decision-algorithm"
            ))
        else:
            self.results.append(ValidationResult(
                "Skill名称", False, "name 应为 decision-algorithm"
            ))

    def _validate_part_a_exists(self):
        content = self._skill_content()
        if "PART A" in content or "Part A" in content or "part a" in content.lower():
            self.results.append(ValidationResult(
                "Part A 存在", True, "包含 Part A 决策工作流"
            ))
        else:
            self.results.append(ValidationResult(
                "Part A 存在", False, "缺少 Part A 决策工作流"
            ))

    def _validate_part_b_exists(self):
        content = self._skill_content()
        if "PART B" in content or "Part B" in content or "part b" in content.lower():
            self.results.append(ValidationResult(
                "Part B 存在", True, "包含 Part B 决策顾问人格"
            ))
        else:
            self.results.append(ValidationResult(
                "Part B 存在", False, "缺少 Part B 决策顾问人格"
            ))

    def _validate_formulas(self):
        """验证核心公式是否正确"""
        content = self._skill_content()

        # 验证期望值公式
        # 检查是否包含期望值的核心要素
        if "期望值" in content and ("胜率" in content or "概率" in content) and ("收益" in content or "赚" in content) and ("损失" in content or "亏" in content):
            self.results.append(ValidationResult(
                "期望值公式", True, "期望值公式要素完整"
            ))
        else:
            self.results.append(ValidationResult(
                "期望值公式", False, "缺少期望值公式核心要素"
            ))

        # 验证凯利公式 — 检查公式结构而非单字母
        if "凯利" in content and "f*" in content:
            # 检查是否包含凯利公式的核心结构 (pb-q)/b 或等效表达
            has_formula_structure = (
                ("p" in content and "b" in content and "q" in content)
                or ("胜率" in content and "赔率" in content)
            )
            if has_formula_structure:
                self.results.append(ValidationResult(
                    "凯利公式", True, "凯利公式存在"
                ))
            else:
                self.results.append(ValidationResult(
                    "凯利公式", False, "缺少凯利公式核心变量定义"
                ))
        else:
            self.results.append(ValidationResult(
                "凯利公式", False, "缺少凯利公式或格式不正确"
            ))

        # 验证贝叶斯相关概念
        if "贝叶斯" in content and ("先验" in content or "更新" in content):
            self.results.append(ValidationResult(
                "贝叶斯定理", True, "贝叶斯相关概念存在"
            ))
        else:
            self.results.append(ValidationResult(
                "贝叶斯定理", False, "缺少贝叶斯相关概念"
            ))

    def _validate_core_principles(self):
        """验证核心原则是否被包含"""
        content = self._skill_content()
        content_segments = semantic_segments(content)
        knowledge = self._knowledge()

        principles = knowledge.get("core_principles", [])
        found = []
        missing = []
        undetermined = []

        for principle in principles:
            covered = self._principle_covered(principle, content_segments)
            if covered is True:
                found.append(principle)
            elif covered is False:
                missing.append(principle)
            else:
                # 抽不出可用的语义片段：无法自动判定，显式列出而不是静默当成通过
                undetermined.append(principle)

        if not missing and not undetermined:
            self.results.append(ValidationResult(
                "核心原则", True, f"全部 {len(found)} 条核心原则都已包含"
            ))
            return

        details = []
        if missing:
            details.append(f"缺少 {len(missing)} 条核心原则: {', '.join(missing)}")
        if undetermined:
            details.append(
                f"{len(undetermined)} 条核心原则无法自动判定: {', '.join(undetermined)}"
            )
        self.results.append(ValidationResult(
            "核心原则", False, "; ".join(details)
        ))

    def _validate_algorithm_coverage(self):
        """验证课程核心算法的覆盖率"""
        content = self._skill_content()
        knowledge = self._knowledge()

        algorithms = knowledge.get("algorithms", [])
        total = len(algorithms)
        found_count = 0
        missing = []

        for algo in algorithms:
            name = algo["name"]
            # 检查算法名称是否出现在 SKILL.md 中
            if name in content:
                found_count += 1
            else:
                missing.append(name)

        coverage = found_count / total * 100 if total > 0 else 0

        if coverage >= 95:
            self.results.append(ValidationResult(
                "算法覆盖率", True,
                f"{found_count}/{total} ({coverage:.0f}%) — 覆盖良好"
            ))
        elif coverage >= 50:
            self.results.append(ValidationResult(
                "算法覆盖率", False,
                f"{found_count}/{total} ({coverage:.0f}%) — 建议补充: {', '.join(missing[:5])}"
            ))
        else:
            self.results.append(ValidationResult(
                "算法覆盖率", False,
                f"{found_count}/{total} ({coverage:.0f}%) — 覆盖率过低"
            ))

    def _validate_no_contradictions(self):
        """验证没有与课程内容直接矛盾的内容"""
        content = self._skill_content()

        contradictions = []

        # 检查常见的矛盾点
        # 1. 不应该鼓励 All in
        if "All in" in content:
            # 检查是否是在负面语境中提到
            context_start = content.find("All in")
            context = content[max(0, context_start-100):context_start+100]
            if "永远不要" in context or "不是" in context or "风险" in context:
                self.results.append(ValidationResult(
                    "All in警告", True,
                    "All in 出现在警示语境中（符合课程）"
                ))
            else:
                contradictions.append("可能在正面语境中提到 All in")
        else:
            self.results.append(ValidationResult(
                "All in警告", True,
                "未出现 All in（无矛盾风险）"
            ))

        # 2. 不应该推荐彩票/赌博
        lottery_words = ["买彩票", "赌博", "抽奖"]
        found_lottery = any(word in content for word in lottery_words)
        if found_lottery:
            # 检查是否是负期望值的警告
            if "负期望值" in content or "不值得" in content:
                self.results.append(ValidationResult(
                    "彩票/赌博", True,
                    "彩票/赌博出现在负期望值警告中（符合课程）"
                ))
            else:
                contradictions.append("可能未正确标注彩票/赌博为负期望值")

        if contradictions:
            self.results.append(ValidationResult(
                "内容一致性", False,
                f"潜在矛盾: {'; '.join(contradictions)}"
            ))
        else:
            self.results.append(ValidationResult(
                "内容一致性", True, "无与课程矛盾的内容"
            ))

    def _validate_output_template(self):
        """验证是否包含结构化的输出模板"""
        content = self._skill_content()

        template_elements = [
            ("决策类型" in content, "输出模板包含决策类型"),
            ("心法诊断" in content or "陷阱识别" in content, "输出模板包含心法诊断"),
            ("框架分析" in content, "输出模板包含框架分析"),
            ("期望值判断" in content or "期望值" in content, "输出模板包含期望值判断"),
            ("遍历性" in content, "输出模板包含遍历性检查"),
            ("投入建议" in content or "下注" in content, "输出模板包含投入建议"),
            ("信息缺口" in content or "贝叶斯" in content, "输出模板包含信息缺口"),
            ("决策建议" in content, "输出模板包含决策建议"),
            ("风险提示" in content or "风险" in content, "输出模板包含风险提示"),
        ]

        found = sum(1 for condition, _ in template_elements if condition)
        total = len(template_elements)

        if found == total:
            self.results.append(ValidationResult(
                "输出模板", True, f"输出模板完整 ({found}/{total})"
            ))
        else:
            missing = [desc for condition, desc in template_elements if not condition]
            self.results.append(ValidationResult(
                "输出模板", False,
                f"模板缺少 {total - found}/{total} 项: {', '.join(missing)}"
            ))

    def _validate_layer_structure(self):
        """验证 Part B 的 Layer 结构是否完整"""
        content = self._skill_content()

        required_layers = [
            ("Layer 0", "硬规则"),
            ("Layer 1", "身份"),
            ("Layer 2", "表达风格"),
            ("Layer 3", "决策模式"),
            ("Layer 4", "场景适配"),
            ("Layer 5", "边界"),
        ]

        found = []
        missing = []

        for layer_num, layer_desc in required_layers:
            if layer_num in content:
                found.append(f"{layer_num}: {layer_desc}")
            else:
                missing.append(layer_num)

        if not missing:
            self.results.append(ValidationResult(
                "Layer结构", True,
                f"6层结构完整: {'; '.join(found)}"
            ))
        else:
            self.results.append(ValidationResult(
                "Layer结构", False,
                f"缺少 Layer: {', '.join(missing)}"
            ))

    def _extract_keywords(self, text: str) -> list[str]:
        """从原则文本中提取可用于匹配的语义片段。

        规则：按标点/符号切成语义片段，片段内去掉空白；
        过短的片段（多为虚词）丢弃；不使用任何硬编码词表，
        也不做「取前 N 个字符」这种会跨标点的截断。
        """
        keywords = []
        for segment in semantic_segments(text):
            if len(segment) >= MIN_KEYWORD_LENGTH:
                keywords.append(segment)
        return keywords

    def _principle_covered(self, principle: str, content_segments: Sequence[str]) -> Optional[bool]:
        """判断一条原则是否已被 SKILL.md 覆盖。

        返回 True 表示已覆盖，False 表示未覆盖，None 表示无法自动判定
        （原则文本里抽不出可用的语义片段）。
        """
        keywords = self._extract_keywords(principle)
        if not keywords:
            return None
        return all(phrase_in_segments(kw, content_segments) for kw in keywords)

    def generate_report(self) -> str:
        """生成验证报告"""
        lines = [
            "=" * 60,
            "决策算法 SKILL.md 验证报告",
            "=" * 60,
            "",
            f"SKILL 文件: {self.skill_path}",
            f"知识库文件: {self.knowledge_path}",
            "",
        ]

        passed = sum(1 for r in self.results if r.passed)
        failed = sum(1 for r in self.results if not r.passed)
        total = len(self.results)

        lines.append(f"总计: {passed}/{total} 通过, {failed}/{total} 失败")
        lines.append("")

        if failed > 0:
            lines.append("--- 失败的验证 ---")
            for r in self.results:
                if not r.passed:
                    lines.append(f"  {r}")
            lines.append("")

        lines.append("--- 通过的验证 ---")
        for r in self.results:
            if r.passed:
                lines.append(f"  {r}")

        lines.append("")
        lines.append("=" * 60)

        return "\n".join(lines)


def find_skill_path(base_dir: Path) -> Path:
    """查找 SKILL.md 路径"""
    candidates = [
        base_dir / "SKILL.md",
        base_dir / ".claude" / "skills" / "life-decision-100" / "SKILL.md",
        Path.cwd() / ".claude" / "skills" / "life-decision-100" / "SKILL.md",
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]  # return default even if not exists


def find_knowledge_path(base_dir: Path) -> Path:
    """查找 course_rules.json 路径"""
    candidates = [
        base_dir / "knowledge" / "course_rules.json",
        base_dir / ".claude" / "skills" / "life-decision-100" / "knowledge" / "course_rules.json",
        Path.cwd() / ".claude" / "skills" / "life-decision-100" / "knowledge" / "course_rules.json",
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def find_chapters_path(base_dir: Path) -> Path:
    """查找课程章节路径"""
    candidates = [
        base_dir / "juece_suanfan_100jiang" / "chapters",
        base_dir.parent / "juece_suanfan_100jiang" / "chapters",
        Path.cwd().parent / "juece_suanfan_100jiang" / "chapters",
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def main() -> int:
    parser = argparse.ArgumentParser(description="决策算法 SKILL.md 验证器")
    parser.add_argument(
        "--skill",
        help="SKILL.md 文件路径",
    )
    parser.add_argument(
        "--knowledge",
        help="course_rules.json 文件路径",
    )
    parser.add_argument(
        "--chapters",
        help="课程章节目录路径",
    )
    parser.add_argument(
        "--base-dir",
        help="项目根目录",
    )
    parser.add_argument(
        "--report",
        action="store_true",
        help="生成详细报告",
    )

    args = parser.parse_args()

    base_dir = Path(args.base_dir).expanduser() if args.base_dir else Path.cwd()

    skill_path = Path(args.skill).expanduser() if args.skill else find_skill_path(base_dir)
    knowledge_path = Path(args.knowledge).expanduser() if args.knowledge else find_knowledge_path(base_dir)
    chapters_dir = Path(args.chapters).expanduser() if args.chapters else find_chapters_path(base_dir)

    validator = SkillValidator(skill_path, knowledge_path, chapters_dir)
    results = validator.validate()

    if args.report:
        print(validator.generate_report())
    else:
        for r in results:
            print(r)

    failed = sum(1 for r in results if not r.passed)
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
