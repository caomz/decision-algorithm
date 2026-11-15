#!/usr/bin/env python3
"""Extract structured decision-algorithm cards from course materials.

Two modes:
1. prompt: build a reusable prompt package and schema without calling any API.
2. api: call the OpenAI Responses API and write structured JSON/Markdown.

This script is designed for course materials such as transcripts, lesson notes,
outlines, books-in-progress, or long teaching drafts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import textwrap
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "gpt-4o-mini"


@dataclass
class PromptPackage:
    system_prompt: str
    user_prompt: str
    schema: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract structured algorithm cards from course materials."
    )
    parser.add_argument("--input", help="Path to a .txt, .md, or .json text file.")
    parser.add_argument(
        "--title",
        default="人生决策100个算法",
        help="Course title used in prompts and output metadata.",
    )
    parser.add_argument(
        "--output",
        default="course_algorithms.json",
        help="Path to the primary output file.",
    )
    parser.add_argument(
        "--format",
        choices=["json", "markdown", "both"],
        default="both",
        help="Output format to write.",
    )
    parser.add_argument(
        "--mode",
        choices=["prompt", "api", "auto"],
        default="auto",
        help="Use prompt mode, api mode, or auto-detect based on OPENAI_API_KEY.",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Model for Responses API mode.",
    )
    parser.add_argument(
        "--language",
        default="zh-CN",
        help="Preferred output language.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=8000,
        help="Approximate max characters per chunk before multi-pass extraction.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Sampling temperature for API mode.",
    )
    return parser.parse_args()


def load_text(input_path: str | None) -> str:
    if input_path:
        path = Path(input_path)
        if not path.exists():
            raise FileNotFoundError(f"Input file not found: {path}")
        text = path.read_text(encoding="utf-8")
    else:
        text = sys.stdin.read()

    text = text.strip()
    if not text:
        raise ValueError("No input text provided. Use --input or pipe text via stdin.")
    return text


def normalize_whitespace(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def split_into_chunks(text: str, chunk_size: int) -> list[str]:
    text = normalize_whitespace(text)
    if len(text) <= chunk_size:
        return [text]

    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        para_len = len(para) + 2
        if current and current_len + para_len > chunk_size:
            chunks.append("\n\n".join(current))
            current = [para]
            current_len = para_len
        else:
            current.append(para)
            current_len += para_len

    if current:
        chunks.append("\n\n".join(current))

    return chunks


def build_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "course_title",
            "language",
            "course_summary",
            "algorithms",
        ],
        "properties": {
            "course_title": {"type": "string"},
            "language": {"type": "string"},
            "course_summary": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "theme",
                    "core_thesis",
                    "audience",
                    "learning_path",
                    "high_frequency_keywords",
                ],
                "properties": {
                    "theme": {"type": "string"},
                    "core_thesis": {"type": "string"},
                    "audience": {"type": "string"},
                    "learning_path": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "high_frequency_keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
            },
            "algorithms": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "algorithm_name",
                        "normalized_name",
                        "core_viewpoint",
                        "explanation",
                        "use_cases",
                        "anti_patterns",
                        "category",
                        "keywords",
                        "source_notes",
                    ],
                    "properties": {
                        "algorithm_name": {"type": "string"},
                        "normalized_name": {"type": "string"},
                        "core_viewpoint": {"type": "string"},
                        "explanation": {"type": "string"},
                        "use_cases": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "anti_patterns": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "category": {
                            "type": "string",
                            "enum": [
                                "认知判断",
                                "概率与风险",
                                "博弈与关系",
                                "行动执行",
                                "情绪与心理",
                                "资源配置",
                                "职业与成长",
                                "财富与长期主义",
                                "其他",
                            ],
                        },
                        "keywords": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "source_notes": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            },
        },
    }


def build_prompts(course_title: str, course_text: str, language: str) -> PromptPackage:
    system_prompt = textwrap.dedent(
        f"""
        你是一名课程知识架构编辑和方法论提炼助手。
        你的任务是把课程材料提炼成可复用的“算法卡片”知识库。

        规则：
        1. 只提取稳定、可复用、可命名的方法论，不要把随口举例和情绪表达当成算法。
        2. 优先保留讲师原有表达风格，但删掉口头赘词。
        3. 核心观点必须是“一句话规则”，清晰、具体、可执行。
        4. 如果名称不稳定，保留原始名称，并给一个更规范的 normalized_name。
        5. 如果材料信息不足，允许在 explanation 或 source_notes 里标记待补充，不要瞎编。
        6. 输出语言使用 {language}。
        7. 输出必须严格符合 JSON schema。
        """
    ).strip()

    user_prompt = textwrap.dedent(
        f"""
        请处理课程《{course_title}》的内容，并输出课程总览与算法卡片。

        额外要求：
        - course_summary 要能直接用于课程页简介。
        - algorithms 中的每个条目都要适合后续生成详情页、问答库、短内容脚本。
        - use_cases 和 anti_patterns 请分别给出 2 到 5 条。
        - source_notes 写明该算法来自哪类片段，例如“第3章关于职业选择”“案例：合伙创业”。

        课程内容如下：
        {course_text}
        """
    ).strip()

    return PromptPackage(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        schema=build_schema(),
    )


def create_api_payload(model: str, pkg: PromptPackage, temperature: float) -> dict[str, Any]:
    return {
        "model": model,
        "instructions": pkg.system_prompt,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": pkg.user_prompt,
                    }
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "decision_algorithm_catalog",
                "strict": True,
                "schema": pkg.schema,
            }
        },
        "temperature": temperature,
    }


def call_responses_api(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url="https://api.openai.com/v1/responses",
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {exc.code}: {body}") from exc


def collect_output_text(node: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(node, dict):
        if node.get("type") == "output_text" and isinstance(node.get("text"), str):
            texts.append(node["text"])
        for value in node.values():
            texts.extend(collect_output_text(value))
    elif isinstance(node, list):
        for item in node:
            texts.extend(collect_output_text(item))
    return texts


def parse_response_json(response: dict[str, Any]) -> dict[str, Any]:
    texts = collect_output_text(response.get("output", []))
    if not texts:
        raise RuntimeError("No output_text found in API response.")
    combined = "\n".join(texts).strip()
    try:
        return json.loads(combined)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "The model response was not valid JSON. Inspect the raw response."
        ) from exc


def merge_records(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    base_map = {
        normalize_key(item.get("normalized_name") or item.get("algorithm_name") or ""): item
        for item in merged.get("algorithms", [])
    }

    for item in incoming.get("algorithms", []):
        key = normalize_key(item.get("normalized_name") or item.get("algorithm_name") or "")
        if not key:
            continue
        if key not in base_map:
            merged.setdefault("algorithms", []).append(item)
            base_map[key] = merged["algorithms"][-1]
            continue

        target = base_map[key]
        for field in ["algorithm_name", "normalized_name", "core_viewpoint", "explanation", "category"]:
            if len(str(item.get(field, ""))) > len(str(target.get(field, ""))):
                target[field] = item[field]

        for list_field in ["use_cases", "anti_patterns", "keywords", "source_notes"]:
            existing = target.get(list_field, []) or []
            addition = item.get(list_field, []) or []
            target[list_field] = dedupe_list(existing + addition)

    if not merged.get("course_summary") and incoming.get("course_summary"):
        merged["course_summary"] = incoming["course_summary"]

    return merged


def normalize_key(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"\s+", "", value)
    value = re.sub(r"[^\w\u4e00-\u9fff-]", "", value)
    return value


def dedupe_list(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        clean = value.strip()
        if clean and clean not in seen:
            seen.add(clean)
            output.append(clean)
    return output


def extract_with_api(
    text: str,
    course_title: str,
    language: str,
    model: str,
    temperature: float,
    chunk_size: int,
    api_key: str,
) -> dict[str, Any]:
    chunks = split_into_chunks(text, chunk_size)
    merged: dict[str, Any] = {
        "course_title": course_title,
        "language": language,
        "course_summary": {
            "theme": "",
            "core_thesis": "",
            "audience": "",
            "learning_path": [],
            "high_frequency_keywords": [],
        },
        "algorithms": [],
    }

    for index, chunk in enumerate(chunks, start=1):
        scoped_text = chunk
        if len(chunks) > 1:
            scoped_text = (
                f"[分段 {index}/{len(chunks)}]\n"
                "请先提取本段涉及的算法，再在 course_summary 中只填写本段可确认的信息。\n\n"
                f"{chunk}"
            )
        pkg = build_prompts(course_title, scoped_text, language)
        payload = create_api_payload(model=model, pkg=pkg, temperature=temperature)
        response = call_responses_api(api_key=api_key, payload=payload)
        record = parse_response_json(response)
        merged = merge_records(merged, record)

    merged["algorithms"] = sorted(
        merged.get("algorithms", []),
        key=lambda item: item.get("normalized_name") or item.get("algorithm_name") or "",
    )
    return merged


def build_prompt_output(text: str, course_title: str, language: str, chunk_size: int) -> dict[str, Any]:
    chunks = split_into_chunks(text, chunk_size)
    packages = []
    for index, chunk in enumerate(chunks, start=1):
        scoped_text = chunk
        if len(chunks) > 1:
            scoped_text = f"[分段 {index}/{len(chunks)}]\n{chunk}"
        pkg = build_prompts(course_title, scoped_text, language)
        packages.append(
            {
                "chunk_index": index,
                "system_prompt": pkg.system_prompt,
                "user_prompt": pkg.user_prompt,
                "schema": pkg.schema,
            }
        )
    return {
        "course_title": course_title,
        "language": language,
        "mode": "prompt",
        "chunk_count": len(packages),
        "packages": packages,
    }


def to_markdown(data: dict[str, Any]) -> str:
    summary = data.get("course_summary", {}) or {}
    lines = [
        "# 课程总览",
        f"- 课程主题：{summary.get('theme', '')}",
        f"- 核心命题：{summary.get('core_thesis', '')}",
        f"- 适合人群：{summary.get('audience', '')}",
        f"- 学习顺序建议：{'；'.join(summary.get('learning_path', []))}",
        f"- 高频关键词：{'、'.join(summary.get('high_frequency_keywords', []))}",
        "",
        "# 算法卡片",
    ]

    for idx, item in enumerate(data.get("algorithms", []), start=1):
        lines.extend(
            [
                f"## {idx}. {item.get('algorithm_name', '')}",
                f"- 规范名称：{item.get('normalized_name', '')}",
                f"- 核心观点：{item.get('core_viewpoint', '')}",
                f"- 说明：{item.get('explanation', '')}",
                f"- 适用场景：{'；'.join(item.get('use_cases', []))}",
                f"- 误用提醒：{'；'.join(item.get('anti_patterns', []))}",
                f"- 分类标签：{item.get('category', '')}",
                f"- 关键词：{'、'.join(item.get('keywords', []))}",
                f"- 来源备注：{'；'.join(item.get('source_notes', []))}",
                "",
            ]
        )

    return "\n".join(lines).strip() + "\n"


def write_outputs(data: dict[str, Any], output_path: Path, fmt: str) -> None:
    if fmt in {"json", "both"}:
        output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if fmt in {"markdown", "both"}:
        md_path = output_path.with_suffix(".md")
        md_path.write_text(to_markdown(data), encoding="utf-8")


def resolve_mode(requested_mode: str) -> str:
    if requested_mode != "auto":
        return requested_mode
    return "api" if os.getenv("OPENAI_API_KEY") else "prompt"


def main() -> int:
    args = parse_args()
    try:
        text = load_text(args.input)
        mode = resolve_mode(args.mode)
        output_path = Path(args.output)

        if mode == "api":
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                raise RuntimeError("OPENAI_API_KEY is required for api mode.")
            data = extract_with_api(
                text=text,
                course_title=args.title,
                language=args.language,
                model=args.model,
                temperature=args.temperature,
                chunk_size=args.chunk_size,
                api_key=api_key,
            )
        else:
            data = build_prompt_output(
                text=text,
                course_title=args.title,
                language=args.language,
                chunk_size=args.chunk_size,
            )

        write_outputs(data, output_path=output_path, fmt=args.format)
        print(f"Wrote output to {output_path}")
        if args.format in {"markdown", "both"}:
            print(f"Wrote markdown to {output_path.with_suffix('.md')}")
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
