#!/usr/bin/env python3
"""Build the canonical 100-item Modern Thinking Tools catalog from the course text.

The course transcript contains 99 substantive chapters.  The catalog's first
entry is the course preface's "智能生活系统" meta-tool; the remaining entries
track those 99 chapters in source order.  Q&A, special broadcasts, leave notes
and the image appendix are deliberately kept as supporting evidence rather
than being used to pad the tool count.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
COURSE_PATH = ROOT / "knowledge" / "raw" / "05-素材库" / "万维钢·现代思维工具100讲.md"
OUTPUT_PATH = ROOT / "skills" / "modern-thinking-tools" / "references" / "tool-catalog.json"

EXCLUDED_PREFIXES = (
    "万维钢·现代思维工具100讲",
    "发刊词",
    "特别放送",
    "问答",
    "请假条",
    "图片缺失清单",
)

EXTRA_ALIASES = {
    "约束": ["硬约束", "软约束", "先尊重，再行动"],
    "复利": ["可积累优势"],
    "WOOP": ["Wish", "Outcome", "Obstacle", "Plan"],
    "探索与利用": ["exploration", "exploitation"],
    "凯利公式": ["Kelly", "凯利仓位"],
    "非遍历性": ["避免出局", "生存优先"],
    "期权": ["可选项", "可逆试验"],
    "OODA 环": ["Observe", "Orient", "Decide", "Act"],
    "ICAP 框架": ["主动学习", "交互学习"],
    "效果推理": ["effectuation", "可承受损失"],
    "激励相容": ["机制设计"],
    "软预算约束": ["兜底", "责任变形"],
    "古德哈特定律": ["指标失真", "KPI"],
    "委托—代理问题": ["principal-agent"],
    "反馈回路": ["正反馈", "负反馈"],
    "目标函数": ["优化目标"],
    "副产品": ["不能直接追求"],
    "立题": ["问题定义"],
}


def category_for(chapter_number: int) -> str:
    ranges = (
        (1, 9, "基本世界观"),
        (10, 20, "自我、情绪与个人成长"),
        (21, 37, "不确定性与决策"),
        (38, 47, "学习与能力"),
        (48, 58, "职业、商业与战略"),
        (59, 69, "社会、制度与协作"),
        (70, 80, "组织与领导"),
        (81, 89, "复杂系统与变化"),
        (90, 99, "意义、元认知与人生方向"),
    )
    for first, last, category in ranges:
        if first <= chapter_number <= last:
            return category
    raise ValueError(f"unexpected course chapter number: {chapter_number}")


def split_tool_name(title: str) -> str:
    return title.split("：", 1)[0].replace("\\+", "+").strip()


def load_substantive_chapters(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    chapters: list[dict[str, Any]] = []
    for match in re.finditer(r"(?m)^# ([^\n]+)$", text):
        title = match.group(1).strip()
        if title.startswith(EXCLUDED_PREFIXES):
            continue
        chapters.append(
            {
                "title": title,
                "short_name": split_tool_name(title),
                "line": text.count("\n", 0, match.start()) + 1,
            }
        )
    if len(chapters) != 99:
        raise ValueError(f"expected 99 substantive course chapters, got {len(chapters)}")
    return chapters


def build_catalog() -> dict[str, Any]:
    chapters = load_substantive_chapters(COURSE_PATH)
    tools: list[dict[str, Any]] = [
        {
            "id": "T001",
            "title": "智能生活系统",
            "short_name": "智能生活系统",
            "category": "元工具与总纲",
            "source": {
                "kind": "course_preface",
                "heading": "发刊词：现代精英的思维武器库",
                "line": 4,
            },
            "aliases": ["目标函数", "世界模型", "反馈回路", "预算带宽"],
            "role": "先把生活当作可校正的系统：目标、模型、行动和反馈要形成闭环。",
        }
    ]
    for index, chapter in enumerate(chapters, 1):
        short_name = str(chapter["short_name"])
        aliases = list(dict.fromkeys([short_name, *EXTRA_ALIASES.get(short_name, [])]))
        tools.append(
            {
                "id": f"T{index + 1:03d}",
                "title": chapter["title"],
                "short_name": short_name,
                "category": category_for(index),
                "source": {
                    "kind": "course_chapter",
                    "heading": chapter["title"],
                    "line": chapter["line"],
                },
                "aliases": aliases,
                "role": "用该工具重述当前处境；具体解释、案例和边界必须再由 GetNote 召回核验。",
            }
        )
    return {
        "schema": "modern-thinking-tools.catalog.v1",
        "catalog_version": 1,
        "source_file": str(COURSE_PATH),
        "source_rule": "T001 是发刊词元工具；T002-T100 依课程 99 个实质章节顺序生成；问答和特别放送仅作辅助证据。",
        "tool_count": len(tools),
        "tools": tools,
    }


def serialized_catalog() -> str:
    return json.dumps(build_catalog(), ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate or check the Modern Thinking Tools catalog.")
    parser.add_argument("--write", action="store_true", help="write the generated catalog to references/tool-catalog.json")
    parser.add_argument("--check", action="store_true", help="fail when the checked-in catalog differs from generated output")
    args = parser.parse_args()
    if args.write and args.check:
        parser.error("--write and --check cannot be used together")

    rendered = serialized_catalog()
    if args.check:
        if not OUTPUT_PATH.exists() or OUTPUT_PATH.read_text(encoding="utf-8") != rendered:
            print(f"catalog drift: run {Path(__file__).name} --write", flush=True)
            return 1
        print(f"catalog is current: {OUTPUT_PATH}")
        return 0
    if args.write:
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_PATH.write_text(rendered, encoding="utf-8")
        print(f"wrote {OUTPUT_PATH}")
        return 0
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
