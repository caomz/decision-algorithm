#!/usr/bin/env python3
"""Retrieve and merge private GetNote evidence for modern life advice."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SKILL_ROOT = Path(__file__).resolve().parents[1]
ROOT = SKILL_ROOT.parents[1]
GETNOTE_SCRIPTS = SKILL_ROOT / "scripts" / "getnote"
# 课程原文不入库（见 .gitignore 的 /knowledge/）：默认按仓库根相对路径解析，
# 其余机器用 MODERN_THINKING_COURSE_PATH 覆盖。
DEFAULT_COURSE_PATH = ROOT / "knowledge" / "raw" / "05-素材库" / "万维钢·现代思维工具100讲.md"
COURSE_PATH = Path(os.environ.get("MODERN_THINKING_COURSE_PATH") or DEFAULT_COURSE_PATH)
OUTPUT_ROOT = ROOT / "tmp" / "modern-thinking-tools"
TOOL_CATALOG_PATH = SKILL_ROOT / "references" / "tool-catalog.json"
DEFAULT_TOPIC_ID = "0Rp2K3pn"
EVIDENCE_SCHEMA = "modern-thinking-tools.evidence.v2"
VALID_STAGES = {"discovery", "verification", "recovery", "manual", "training"}
TOOL_ID_PATTERN = re.compile(r"^T(?:00[1-9]|0[1-9]\d|100)$")
HIGH_QUALITY_FULLTEXT = {
    "user_note_fulltext",
    "user_link_fulltext",
    "course_chapter_fulltext",
}

SOURCE_QUALITY_RANK = {
    "user_note_fulltext": 0,
    "user_link_fulltext": 0,
    "course_chapter_fulltext": 1,
    "course_dictionary_excerpt": 2,
    "course_file_excerpt": 3,
    "season_anthology_excerpt": 4,
    "other_file_excerpt": 5,
    "recall_excerpt_only": 6,
    "note_excerpt_load_failed": 7,
    "course_chapter_match_not_loaded": 8,
}


class EvidenceError(RuntimeError):
    """Raised when evidence cannot be produced without hiding a data-quality issue."""


def normalize_title(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"^wwg\d+[A-Za-z_-]*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"【[^】]*】", "", text)
    text = re.sub(r"\.pdf$", "", text, flags=re.IGNORECASE)
    text = text.replace("\\", "")
    text = text.replace("大于", ">").replace("小于", "<")
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", text).casefold()


def parse_course_chapters(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    matches = list(re.finditer(r"(?m)^# ([^\n]+)\n", text))
    chapters: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        if title == "万维钢·现代思维工具100讲（文本克隆版）" or title == "图片缺失清单":
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        chapters.append(
            {
                "title": title,
                "normalized_title": normalize_title(title),
                "start_line": text.count("\n", 0, match.start()) + 1,
                "text": text[match.start():end].strip(),
            }
        )
    return chapters


def match_course_chapter(title: str, chapters: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidate = normalize_title(title)
    if not candidate:
        return None
    exact = [chapter for chapter in chapters if chapter["normalized_title"] == candidate]
    if len(exact) == 1:
        return exact[0]
    fuzzy = [
        chapter
        for chapter in chapters
        if len(candidate) >= 6
        and (
            candidate in chapter["normalized_title"]
            or chapter["normalized_title"] in candidate
        )
    ]
    if not fuzzy:
        return None
    return max(fuzzy, key=lambda item: len(item["normalized_title"]))


def source_key(result: dict[str, Any]) -> str:
    result_type = str(result.get("note_type") or "UNKNOWN").upper()
    source_id = str(result.get("note_id") or "").strip()
    if source_id:
        return f"{result_type}:id:{source_id}"
    title = normalize_title(str(result.get("title") or ""))
    if result_type == "NOTE":
        # NOTE titles are not unique. If the API omits note_id, prefer keeping
        # ambiguous notes separate instead of silently merging distinct notes.
        excerpt = str(result.get("content") or "").strip()
        digest = hashlib.sha256(excerpt.encode("utf-8")).hexdigest()[:16]
        return f"NOTE:unidentified:{title or 'untitled'}:{digest}"
    if title:
        return f"{result_type}:title:{title}"
    excerpt = normalize_title(str(result.get("content") or ""))[:160]
    return f"{result_type}:excerpt:{excerpt}"


def load_getnote_api() -> tuple[Callable[..., dict[str, Any]], type[Exception]]:
    if str(GETNOTE_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(GETNOTE_SCRIPTS))
    from common import GetNoteSchemaError, request_json  # type: ignore

    return request_json, GetNoteSchemaError


def fetch_results(
    request_json: Callable[..., dict[str, Any]],
    *,
    topic_id: str,
    query: str,
    top_k: int,
    request_options: dict[str, Any],
) -> list[dict[str, Any]]:
    data = request_json(
        "POST",
        "/resource/recall/knowledge",
        body={"topic_id": topic_id, "query": query, "top_k": top_k},
        retries=3,
        **request_options,
    )
    if "results" not in data or not isinstance(data["results"], list):
        raise EvidenceError(f"schema mismatch for query={query!r}: missing/non-list results")
    if any(not isinstance(item, dict) for item in data["results"]):
        raise EvidenceError(f"schema mismatch for query={query!r}: non-object result")
    return data["results"]


def fetch_note_fulltext(
    request_json: Callable[..., dict[str, Any]],
    note_id: str,
    *,
    request_options: dict[str, Any],
) -> tuple[str, str, str, str]:
    data = request_json(
        "GET",
        "/resource/note/detail",
        params={"id": note_id},
        retries=3,
        **request_options,
    )
    note = data.get("note")
    if not isinstance(note, dict):
        raise EvidenceError(f"schema mismatch for note detail id={note_id}: missing note")
    note_type = str(note.get("note_type") or "").lower()
    web_page = note.get("web_page") if isinstance(note.get("web_page"), dict) else {}
    if note_type == "link" and str(web_page.get("content") or "").strip():
        content = str(web_page.get("content") or "")
        field = "web_page.content"
    elif note_type in {"audio", "meeting", "local_audio", "internal_record"} and str(
        note.get("audio_original") or ""
    ).strip():
        content = str(note.get("audio_original") or "")
        field = "audio_original"
    else:
        content = str(note.get("content") or "")
        field = "content"
    source_url = str(web_page.get("url") or note.get("url") or "")
    return content, str(note.get("title") or ""), note_type, source_url or field


def truncate(value: str, limit: int) -> tuple[str, str]:
    if len(value) <= limit:
        return value, "loaded"
    return value[:limit], "loaded_truncated"


def quality_summary(query_reports: list[dict[str, Any]], sources: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe evidence quality without pretending an API failure is no evidence."""
    successful_query_count = sum(1 for report in query_reports if report.get("status") == "ok")
    course_fulltext_count = sum(
        1 for source in sources if source.get("source_quality") == "course_chapter_fulltext"
    )
    note_fulltext_count = sum(
        1
        for source in sources
        if source.get("source_quality") in {"user_note_fulltext", "user_link_fulltext"}
    )
    high_quality_fulltext_count = sum(
        1 for source in sources if source.get("source_quality") in HIGH_QUALITY_FULLTEXT
    )
    minimums_met = (
        successful_query_count >= 3
        and high_quality_fulltext_count >= 2
        and course_fulltext_count >= 1
    )
    if not sources:
        status = "degraded"
    elif minimums_met:
        status = "ready"
    else:
        status = "partial"
    return {
        "status": status,
        "successful_query_count": successful_query_count,
        "failed_query_count": len(query_reports) - successful_query_count,
        "source_count": len(sources),
        "course_fulltext_count": course_fulltext_count,
        "note_fulltext_count": note_fulltext_count,
        "high_quality_fulltext_count": high_quality_fulltext_count,
        "minimums": {
            "successful_queries": 3,
            "high_quality_fulltext_sources": 2,
            "course_fulltext_sources": 1,
        },
        "minimums_met": minimums_met,
        "requires_additional_recall": not minimums_met,
    }


def training_coverage(
    tool_ids: list[str], sources: list[dict[str, Any]], catalog_path: Path = TOOL_CATALOG_PATH
) -> dict[str, dict[str, Any]]:
    """Require a full, matching course chapter for each trained tool."""
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    names = {item["id"]: item["title"] for item in catalog["tools"]}
    coverage: dict[str, dict[str, Any]] = {}
    for tool_id in tool_ids:
        expected = normalize_title(names[tool_id])
        matches = [
            source for source in sources
            if source.get("source_quality") == "course_chapter_fulltext"
            and source.get("full_text_status") == "loaded"
            and normalize_title((source.get("local_chapter") or {}).get("title", "")) == expected
        ]
        coverage[tool_id] = {
            "status": "ready" if matches else "missing",
            "source_keys": [source["source_key"] for source in matches],
        }
    return coverage


def finish_quality(
    pack: dict[str, Any], chapters: list[dict[str, Any]]
) -> None:
    """Keep the existing advice gate, while training uses per-tool coverage."""
    if pack["stage"] != "training":
        return
    coverage = training_coverage(pack["tool_ids"], pack["sources"])
    successful = {report["query_index"] for report in pack["query_reports"] if report["status"] == "ok"}
    query_coverage = {
        tool_id: any(index in successful for index in (2 * offset + 1, 2 * offset + 2))
        for offset, tool_id in enumerate(pack["tool_ids"])
    }
    ready = bool(coverage) and all(item["status"] == "ready" for item in coverage.values()) and all(query_coverage.values())
    pack["training_coverage"] = coverage
    pack["quality"]["status"] = "ready" if ready else ("partial" if pack["sources"] else "degraded")
    pack["quality"]["minimums_met"] = ready
    pack["quality"]["requires_additional_recall"] = False
    pack["quality"]["training_query_coverage"] = query_coverage
    if not ready:
        catalog = json.loads(TOOL_CATALOG_PATH.read_text(encoding="utf-8"))
        names = {item["id"]: normalize_title(item["title"]) for item in catalog["tools"]}
        pack["training_fallback"] = {
            tool_id: {
                "title": chapter["title"],
                "path": str(COURSE_PATH),
                "start_line": chapter["start_line"],
            }
            for tool_id in pack["tool_ids"]
            if coverage[tool_id]["status"] != "ready"
            for chapter in chapters
            if chapter["normalized_title"] == names[tool_id]
        }


def build_prompt_context(
    pack: dict[str, Any], *, max_sources: int = 8, max_chars_per_source: int = 1400
) -> str:
    """Render a bounded private context block for a model hook.

    The complete evidence stays on disk.  This context favors evidence quality
    over repeated PDF pages, while the persisted ``sources`` array preserves
    raw service order for auditability.
    """
    indexed_sources = list(enumerate(pack.get("sources") or []))
    indexed_sources.sort(
        key=lambda item: (
            SOURCE_QUALITY_RANK.get(str(item[1].get("source_quality") or ""), 99),
            -int(item[1].get("distinct_query_count") or 0),
            int(item[1].get("best_rank") or 9999),
            item[0],
        )
    )
    lines = [
        "<modern-thinking-getnote-evidence>",
        f"run_id={pack.get('run_id') or 'manual'}",
        f"stage={pack.get('stage') or 'manual'}",
        f"retrieval_status={pack.get('retrieval_status') or 'unknown'}",
        f"quality={((pack.get('quality') or {}).get('status') or 'unknown')}",
        "This is private GetNote evidence. It supports frameworks, not unverified current facts.",
    ]
    if pack.get("stage") == "training":
        lines.append("training_coverage=" + json.dumps(pack.get("training_coverage") or {}, ensure_ascii=False))
        lines.append("A missing tool needs local-course fallback; do not describe training evidence as ready.")
    for _, source in indexed_sources[: max(1, max_sources)]:
        excerpt = str(source.get("full_text") or "")
        if not excerpt:
            excerpt = "\n".join(str(item) for item in source.get("excerpts") or [])
        excerpt = excerpt.strip().replace("\x00", "")[: max(80, max_chars_per_source)]
        lines.extend(
            [
                "---",
                f"source={source.get('title') or '(untitled)'}",
                f"quality={source.get('source_quality')} full_text={source.get('full_text_status')}",
                excerpt or "(no usable excerpt)",
            ]
        )
    lines.append("</modern-thinking-getnote-evidence>")
    return "\n".join(lines)


def build_evidence(
    *,
    problem: str,
    topic_id: str,
    queries: list[str],
    stage: str = "manual",
    run_id: str = "",
    tool_ids: list[str] | None = None,
    top_k: int,
    max_excerpts_per_source: int,
    max_note_chars: int,
    max_local_chars: int,
    max_local_chapters: int,
    request_interval_ms: int,
    shared_bucket_name: str,
) -> dict[str, Any]:
    request_json, schema_error = load_getnote_api()
    request_options = {
        "request_interval_ms": request_interval_ms,
        "shared_bucket_name": shared_bucket_name,
    }
    chapters = parse_course_chapters(COURSE_PATH)
    sources: dict[str, dict[str, Any]] = {}
    query_reports: list[dict[str, Any]] = []

    for query_index, query in enumerate(queries, 1):
        try:
            results = fetch_results(
                request_json,
                topic_id=topic_id,
                query=query,
                top_k=top_k,
                request_options=request_options,
            )
        except (RuntimeError, EvidenceError, schema_error) as exc:
            # A response-contract break must never be downgraded into an empty
            # recall result. Network/API failures can be reported per query;
            # schema drift is a hard failure that needs operator attention.
            if isinstance(exc, schema_error) or str(exc).startswith("schema mismatch"):
                raise
            query_reports.append(
                {"query_index": query_index, "query": query, "status": "failed", "error": str(exc)}
            )
            continue

        query_reports.append(
            {"query_index": query_index, "query": query, "status": "ok", "result_count": len(results)}
        )
        for rank, result in enumerate(results, 1):
            key = source_key(result)
            result_type = str(result.get("note_type") or "UNKNOWN").upper()
            source = sources.setdefault(
                key,
                {
                    "source_key": key,
                    "result_type": result_type,
                    "source_id": str(result.get("note_id") or "").strip(),
                    "title": str(result.get("title") or "").strip(),
                    "published_at": str(result.get("created_at") or ""),
                    "source_url": str(result.get("url") or ""),
                    "hits": [],
                    "excerpts": [],
                    "score_policy": "observational_only_no_threshold",
                    "full_text": "",
                    "full_text_status": "not_loaded",
                    "local_chapter": None,
                    "privacy": "private",
                    "publish_allowed": False,
                    "verification": "internal_framework_source",
                    "source_quality": "unclassified",
                },
            )
            source["hits"].append(
                {
                    "query_index": query_index,
                    "query": query,
                    "rank": rank,
                    "score_observed": result.get("score"),
                    "page_no": result.get("page_no"),
                }
            )
            excerpt = str(result.get("content") or "").strip()
            if (
                excerpt
                and excerpt not in source["excerpts"]
                and len(source["excerpts"]) < max_excerpts_per_source
            ):
                source["excerpts"].append(excerpt)

    if not sources:
        failures = [report for report in query_reports if report["status"] == "failed"]
        empty_pack = {
            "schema": EVIDENCE_SCHEMA,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "run_id": run_id,
            "stage": stage,
            "tool_ids": list(dict.fromkeys(tool_ids or [])),
            "problem": problem,
            "topic": {"topic_id": topic_id, "name": "精英日课"},
            "privacy": "private",
            "publish_allowed": False,
            "external_verification_required_for_current_facts": True,
            "result_order": "query_order_then_service_rank",
            "dedupe_policy": "merge_same_source_keep_hit_trace_and_unique_excerpts",
            "score_policy": "observational_only_no_threshold",
            "query_reports": query_reports,
            "source_count": 0,
            "local_chapter_count": 0,
            "local_fulltext_loaded_count": 0,
            "sources": [],
            "retrieval_status": "degraded",
            "degradation_reason": (
                "all GetNote queries failed" if failures else "all GetNote queries returned no sources"
            ),
        }
        empty_pack["quality"] = quality_summary(query_reports, [])
        finish_quality(empty_pack, chapters)
        empty_pack["prompt_context"] = build_prompt_context(empty_pack)
        return empty_pack

    local_loaded = 0
    for source in sources.values():
        if source["result_type"] == "NOTE" and source["source_id"]:
            try:
                full_text, detail_title, detail_note_type, detail_source = fetch_note_fulltext(
                    request_json,
                    source["source_id"],
                    request_options=request_options,
                )
                if detail_title:
                    source["title"] = detail_title
                source["detail_note_type"] = detail_note_type
                if detail_source.startswith("http"):
                    source["source_url"] = detail_source
                else:
                    source["full_text_field"] = detail_source
                source["full_text"], source["full_text_status"] = truncate(
                    full_text, max_note_chars
                )
                source["source_quality"] = (
                    "user_link_fulltext" if detail_note_type == "link" else "user_note_fulltext"
                )
            except schema_error:
                raise
            except EvidenceError as exc:
                if str(exc).startswith("schema mismatch"):
                    raise
                source["full_text_status"] = "load_failed"
                source["full_text_error"] = str(exc)
                source["source_quality"] = "note_excerpt_load_failed"
            except RuntimeError as exc:
                source["full_text_status"] = "load_failed"
                source["full_text_error"] = str(exc)
                source["source_quality"] = "note_excerpt_load_failed"
            continue

        if source["result_type"] != "FILE":
            source["full_text_status"] = "unavailable_from_recall"
            source["source_quality"] = "recall_excerpt_only"
            continue

        chapter = match_course_chapter(source["title"], chapters)
        if chapter is None:
            source["full_text_status"] = "recall_excerpt_only"
            normalized = normalize_title(source["title"])
            if re.match(r"^wwg\d+", str(source["title"]), flags=re.IGNORECASE):
                source["source_quality"] = (
                    "course_dictionary_excerpt" if "现代思维工具词典" in source["title"] else "course_file_excerpt"
                )
            elif "精英日课" in source["title"] and "全集" in source["title"]:
                source["source_quality"] = "season_anthology_excerpt"
            else:
                source["source_quality"] = "other_file_excerpt"
            continue
        source["local_chapter"] = {
            "title": chapter["title"],
            "path": str(COURSE_PATH),
            "start_line": chapter["start_line"],
        }
        if local_loaded >= max_local_chapters:
            source["full_text_status"] = "local_match_not_loaded_budget"
            source["source_quality"] = "course_chapter_match_not_loaded"
            continue
        source["full_text"], source["full_text_status"] = truncate(
            chapter["text"], max_local_chars
        )
        source["source_quality"] = "course_chapter_fulltext"
        local_loaded += 1

    for source in sources.values():
        source["distinct_query_count"] = len(
            {int(hit["query_index"]) for hit in source["hits"]}
        )
        source["best_rank"] = min(int(hit["rank"]) for hit in source["hits"])

    ordered_sources = list(sources.values())
    pack = {
        "schema": EVIDENCE_SCHEMA,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "run_id": run_id,
        "stage": stage,
        "tool_ids": list(dict.fromkeys(tool_ids or [])),
        "problem": problem,
        "topic": {"topic_id": topic_id, "name": "精英日课"},
        "privacy": "private",
        "publish_allowed": False,
        "external_verification_required_for_current_facts": True,
        "result_order": "query_order_then_service_rank",
        "dedupe_policy": "merge_same_source_keep_hit_trace_and_unique_excerpts",
        "score_policy": "observational_only_no_threshold",
        "query_reports": query_reports,
        "source_count": len(ordered_sources),
        "local_chapter_count": sum(1 for item in ordered_sources if item["local_chapter"]),
        "local_fulltext_loaded_count": local_loaded,
        "sources": ordered_sources,
    }
    pack["quality"] = quality_summary(query_reports, ordered_sources)
    finish_quality(pack, chapters)
    pack["retrieval_status"] = (
        "ready" if pack["quality"]["status"] == "ready" else "partial"
    )
    pack["degradation_reason"] = (
        "GetNote recall did not meet full-evidence minimums"
        if pack["quality"]["status"] != "ready"
        else ""
    )
    pack["prompt_context"] = build_prompt_context(pack)
    return pack


def render_markdown(pack: dict[str, Any]) -> str:
    quality = pack.get("quality") or {}
    lines = [
        "# 现代思维工具检索证据包",
        "",
        "> 私有研究材料。课程框架不等于用户现实事实；涉及当前事实必须独立核验。",
        "",
        f"- 问题：{pack['problem']}",
        f"- Knowledge base：`{pack['topic']['topic_id']}`（{pack['topic']['name']}）",
        f"- Run ID：`{pack.get('run_id') or 'manual'}`；阶段：`{pack.get('stage') or 'manual'}`",
        f"- 检索状态：`{pack.get('retrieval_status') or 'unknown'}`；质量：`{quality.get('status') or 'unknown'}`",
        f"- 查询数：{len(pack['query_reports'])}",
        f"- 去重来源数：{pack['source_count']}",
        f"- 本地章节匹配：{pack['local_chapter_count']}",
        "- 排序：查询顺序 + 服务端 rank；不使用 `score` 过滤",
        "",
        "## 查询状态",
        "",
        "| # | 状态 | 结果数 | 查询 |",
        "|---:|---|---:|---|",
    ]
    if pack.get("tool_ids"):
        lines.extend(["", f"- 核验工具：{', '.join(pack['tool_ids'])}"])
    if pack.get("degradation_reason"):
        lines.extend(["", f"> GetNote 检索降级：{pack['degradation_reason']}"])
    for report in pack["query_reports"]:
        query = str(report["query"]).replace("|", "\\|")
        lines.append(
            f"| {report['query_index']} | {report['status']} | {report.get('result_count', 0)} | {query} |"
        )
    lines.extend(
        [
            "",
            "## 来源",
            "",
        "| # | 类型 | 标题 | 查询覆盖 | 质量 | 全文状态 |",
        "|---:|---|---|---:|---|---|",
        ]
    )
    for index, source in enumerate(pack["sources"], 1):
        title = str(source["title"]).replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {index} | {source['result_type']} | {title} | {source['distinct_query_count']} | {source['source_quality']} | {source['full_text_status']} |"
        )
    lines.extend(["", "## 来源明细", ""])
    for index, source in enumerate(pack["sources"], 1):
        lines.extend(
            [
                f"### {index}. {source['title'] or '(无标题)'}",
                "",
                f"- 类型：`{source['result_type']}`",
                f"- ID：`{source['source_id'] or 'unavailable'}`",
                f"- 全文状态：`{source['full_text_status']}`",
                f"- 来源质量：`{source['source_quality']}`",
                f"- 命中：{json.dumps(source['hits'], ensure_ascii=False)}",
            ]
        )
        if source.get("local_chapter"):
            lines.append(
                f"- 本地章节：{source['local_chapter']['title']}（{source['local_chapter']['path']}:{source['local_chapter']['start_line']}）"
            )
        for excerpt_index, excerpt in enumerate(source["excerpts"], 1):
            lines.extend(["", f"#### 召回片段 {excerpt_index}", "", excerpt])
        if source.get("full_text"):
            lines.extend(["", "<details><summary>已加载全文/本地章节</summary>", "", source["full_text"], "", "</details>"])
        lines.append("")
    return "\n".join(lines)


def output_paths(prefix: Path) -> tuple[Path, Path]:
    return Path(f"{prefix}.json"), Path(f"{prefix}.md")


def load_stdin_request() -> dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"stdin JSON invalid: {exc}") from exc
    if not isinstance(payload, dict):
        raise EvidenceError("stdin JSON must be an object")
    return payload


def sanitize_output_prefix(value: str) -> Path:
    """Keep private evidence in the dedicated temporary tree."""
    raw = Path(value).expanduser()
    prefix = raw if raw.is_absolute() else ROOT / raw
    resolved_root = OUTPUT_ROOT.resolve()
    resolved_prefix = prefix.resolve()
    if resolved_prefix != resolved_root and resolved_root not in resolved_prefix.parents:
        raise EvidenceError(f"output prefix must stay under {OUTPUT_ROOT}")
    return resolved_prefix


def load_valid_tool_ids(path: Path = TOOL_CATALOG_PATH) -> set[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvidenceError(f"tool catalog unavailable or invalid: {path}: {exc}") from exc
    tools = payload.get("tools") if isinstance(payload, dict) else None
    if not isinstance(tools, list):
        raise EvidenceError(f"tool catalog schema mismatch: {path}: missing tools list")
    valid_ids = {
        str(tool.get("id") or "")
        for tool in tools
        if isinstance(tool, dict) and TOOL_ID_PATTERN.fullmatch(str(tool.get("id") or ""))
    }
    if valid_ids != {f"T{index:03d}" for index in range(1, 101)}:
        raise EvidenceError(f"tool catalog must contain exactly T001-T100: {path}")
    return valid_ids


def validate_request_contract(
    *, stage: str, queries: list[str], tool_ids: list[str], valid_tool_ids: set[str]
) -> None:
    if stage not in VALID_STAGES:
        raise EvidenceError(f"stage must be one of {sorted(VALID_STAGES)}")
    if len(queries) != len(set(queries)):
        raise EvidenceError("queries must be unique")
    if len(tool_ids) != len(set(tool_ids)):
        raise EvidenceError("tool_ids must be unique")
    invalid_tool_ids = [
        tool_id
        for tool_id in tool_ids
        if not TOOL_ID_PATTERN.fullmatch(tool_id) or tool_id not in valid_tool_ids
    ]
    if invalid_tool_ids:
        raise EvidenceError(f"invalid tool_ids: {', '.join(invalid_tool_ids)}")
    if stage == "discovery":
        if len(queries) != 4:
            raise EvidenceError("discovery requires exactly four unique queries")
        if tool_ids:
            raise EvidenceError("discovery does not accept tool_ids")
        return
    if stage in {"verification", "recovery"}:
        if len(queries) != 4:
            raise EvidenceError(f"{stage} requires exactly four unique queries")
        if len(tool_ids) != 4:
            raise EvidenceError(f"{stage} requires exactly four unique canonical tool_ids")
        return
    if stage == "training":
        if not 1 <= len(tool_ids) <= 3 or len(queries) != 2 * len(tool_ids):
            raise EvidenceError("training requires 1-3 unique tool_ids and two queries per tool")
        return
    if not 3 <= len(queries) <= 5:
        raise EvidenceError("manual stage requires three to five unique queries")


def write_private_evidence(json_path: Path, markdown_path: Path, pack: dict[str, Any]) -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    OUTPUT_ROOT.chmod(0o700)
    json_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    json_path.parent.chmod(0o700)
    json_path.write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(render_markdown(pack), encoding="utf-8")
    for path in (json_path, markdown_path):
        try:
            path.chmod(0o600)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Retrieve multi-query GetNote evidence and backfill matching local course chapters."
    )
    parser.add_argument("--problem", default="")
    parser.add_argument("--query", action="append", default=[])
    parser.add_argument("--topic-id", default=DEFAULT_TOPIC_ID)
    parser.add_argument("--stage", choices=sorted(VALID_STAGES), default="discovery")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--tool-id", action="append", default=[])
    parser.add_argument("--stdin-json", action="store_true", help="read problem/queries from stdin JSON")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--max-excerpts-per-source", type=int, default=4)
    parser.add_argument("--max-note-chars", type=int, default=20000)
    parser.add_argument("--max-local-chars", type=int, default=60000)
    parser.add_argument("--max-local-chapters", type=int, default=20)
    parser.add_argument("--request-interval-ms", type=int, default=500)
    parser.add_argument("--shared-bucket-name", default="modern-thinking-tools")
    parser.add_argument("--output-prefix", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        stdin_request = load_stdin_request() if args.stdin_json else {}
    except EvidenceError as exc:
        parser.error(str(exc))

    problem = str(stdin_request.get("problem", args.problem) or "").strip()
    raw_queries = stdin_request.get("queries", args.query)
    if not isinstance(raw_queries, list):
        parser.error("queries must be a JSON list")
    queries = [str(query).strip() for query in raw_queries if str(query).strip()]
    topic_id = str(stdin_request.get("topic_id", args.topic_id) or "").strip()
    stage = str(stdin_request.get("stage", args.stage) or "manual").strip() or "manual"
    run_id = str(stdin_request.get("run_id", args.run_id) or "").strip()
    raw_tool_ids = stdin_request.get("tool_ids", args.tool_id)
    if not isinstance(raw_tool_ids, list):
        parser.error("tool_ids must be a JSON list")
    tool_ids = [str(value).strip().upper() for value in raw_tool_ids if str(value).strip()]
    if not problem:
        parser.error("--problem 不能为空")
    if not topic_id:
        parser.error("--topic-id 不能为空")
    top_k = min(10, max(1, int(args.top_k)))
    if args.request_interval_ms < 0:
        parser.error("--request-interval-ms 不能小于 0")
    try:
        validate_request_contract(
            stage=stage,
            queries=queries,
            tool_ids=tool_ids,
            valid_tool_ids=load_valid_tool_ids(),
        )
    except EvidenceError as exc:
        parser.error(str(exc))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    try:
        prefix = (
            sanitize_output_prefix(args.output_prefix)
            if args.output_prefix
            else OUTPUT_ROOT / f"evidence-{stamp}"
        )
    except EvidenceError as exc:
        parser.error(str(exc))
    json_path, md_path = output_paths(prefix)
    if args.dry_run:
        print(
            json.dumps(
                {
                    "ok": True,
                    "dry_run": True,
                    "problem": problem,
                    "queries": queries,
                    "topic_id": topic_id,
                    "stage": stage,
                    "run_id": run_id,
                    "tool_ids": tool_ids,
                    "top_k": top_k,
                    "json_path": str(json_path),
                    "markdown_path": str(md_path),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    try:
        pack = build_evidence(
            problem=problem,
            topic_id=topic_id,
            queries=queries,
            stage=stage,
            run_id=run_id,
            tool_ids=tool_ids,
            top_k=top_k,
            max_excerpts_per_source=max(1, int(args.max_excerpts_per_source)),
            max_note_chars=max(1, int(args.max_note_chars)),
            max_local_chars=max(1, int(args.max_local_chars)),
            max_local_chapters=max(0, int(args.max_local_chapters)),
            request_interval_ms=int(args.request_interval_ms),
            shared_bucket_name=str(args.shared_bucket_name),
        )
    except (RuntimeError, EvidenceError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 2

    write_private_evidence(json_path, md_path, pack)
    print(
        json.dumps(
            {
                "ok": True,
                "query_count": len(pack["query_reports"]),
                "retrieval_status": pack["retrieval_status"],
                "quality_status": pack["quality"]["status"],
                "successful_query_count": sum(
                    1 for report in pack["query_reports"] if report["status"] == "ok"
                ),
                "source_count": pack["source_count"],
                "local_chapter_count": pack["local_chapter_count"],
                "local_fulltext_loaded_count": pack["local_fulltext_loaded_count"],
                "json_path": str(json_path),
                "markdown_path": str(md_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
