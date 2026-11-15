from __future__ import annotations

import importlib.util
import json
import stat
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "retrieve_evidence.py"
SPEC = importlib.util.spec_from_file_location("modern_thinking_retrieve", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
COURSE_FIXTURE = Path(__file__).parent / "fixtures" / "course-mini.md"


class FakeSchemaError(Exception):
    pass


def test_training_contract_and_exact_course_coverage(monkeypatch) -> None:
    valid = {f"T{index:03d}" for index in range(1, 101)}
    MODULE.validate_request_contract(
        stage="training", queries=["机制", "反例"], tool_ids=["T025"], valid_tool_ids=valid
    )
    with pytest.raises(MODULE.EvidenceError):
        MODULE.validate_request_contract(
            stage="training", queries=["机制"], tool_ids=["T025"], valid_tool_ids=valid
        )
    target = MODULE.load_valid_tool_ids()
    assert "T025" in target
    source = {
        "source_key": "FILE:T025", "source_quality": "course_chapter_fulltext",
        "full_text_status": "loaded", "local_chapter": {"title": "颗粒度和因果中介：用模型思考"},
    }
    assert MODULE.training_coverage(["T025"], [source])["T025"]["status"] == "ready"
    assert MODULE.training_coverage(["T032"], [source])["T032"]["status"] == "missing"
    assert MODULE.training_coverage(["T025"], [{**source, "full_text_status": "loaded_truncated"}])["T025"]["status"] == "missing"


def test_training_pack_requires_every_matching_full_chapter(monkeypatch) -> None:
    titles = [
        "颗粒度和因果中介：用模型思考",
        "状态杠杆：你不是不努力，你是没做在点子上",
        "参考类：当局者迷，旁观者清，你不特殊",
    ]

    def request_json(method, path, *, body=None, **_kwargs):
        title = next((title for title in titles if title in body["query"]), "")
        return {"results": [{"note_type": "FILE", "title": title, "content": "相关章节"}] if title else []}

    monkeypatch.setattr(MODULE, "load_getnote_api", lambda: (request_json, FakeSchemaError))
    queries = [f"{title} 定义 机制 应用" if n % 2 == 0 else f"{title} 边界 反例"
               for title in titles for n in range(2)]
    options = dict(problem="合成训练", topic_id=MODULE.DEFAULT_TOPIC_ID, queries=queries,
                   stage="training", tool_ids=["T025", "T032", "T036"], top_k=10,
                   max_excerpts_per_source=2, max_note_chars=1000, max_local_chapters=3,
                   request_interval_ms=0, shared_bucket_name="test")
    pack = MODULE.build_evidence(**options, max_local_chars=60000)
    assert pack["retrieval_status"] == "ready"
    assert all(item["status"] == "ready" for item in pack["training_coverage"].values())
    limited = MODULE.build_evidence(**options, max_local_chars=30)
    assert limited["retrieval_status"] == "partial"
    assert all(item["status"] == "missing" for item in limited["training_coverage"].values())
    assert set(limited["training_fallback"]) == set(options["tool_ids"])


def test_normalize_course_title_with_prefix_and_suffix() -> None:
    title = "wwg042参考类：当局者迷，旁观者清，你不特殊【公众号：密知圈】.pdf"
    assert MODULE.normalize_title(title) == MODULE.normalize_title(
        "参考类：当局者迷，旁观者清，你不特殊"
    )


def test_parse_and_match_local_course_chapter() -> None:
    chapters = MODULE.parse_course_chapters(COURSE_FIXTURE)
    chapter = MODULE.match_course_chapter("wwg004约束：先尊重，再行动", chapters)
    assert chapter is not None
    assert chapter["title"] == "约束：先尊重，再行动"
    assert "硬约束" in chapter["text"]

    organization = MODULE.match_course_chapter(
        "wwg086组织资本：怎样让 1 + 1 大于 2", chapters
    )
    assert organization is not None
    assert organization["title"] == "组织资本：怎样让 1 \\+ 1 \\> 2"


def test_source_key_merges_file_pages_but_not_distinct_notes() -> None:
    first = {
        "note_type": "FILE",
        "note_id": "",
        "title": "wwg004约束：先尊重，再行动",
        "content": "片段一",
        "page_no": 1,
    }
    second = {**first, "content": "片段二", "page_no": 2}
    assert MODULE.source_key(first) == MODULE.source_key(second)

    note_a = {"note_type": "NOTE", "note_id": "100", "title": "同名"}
    note_b = {"note_type": "NOTE", "note_id": "101", "title": "同名"}
    assert MODULE.source_key(note_a) != MODULE.source_key(note_b)

    unidentified_a = {"note_type": "NOTE", "note_id": "", "title": "同名", "content": "内容 A"}
    unidentified_b = {"note_type": "NOTE", "note_id": "", "title": "同名", "content": "内容 B"}
    assert MODULE.source_key(unidentified_a) != MODULE.source_key(unidentified_b)


def test_match_returns_none_for_unrelated_file() -> None:
    chapters = MODULE.parse_course_chapters(COURSE_FIXTURE)
    assert MODULE.match_course_chapter("某个无关影视解读", chapters) is None


def test_v2_pack_keeps_stage_tool_ids_and_private_prompt_context(monkeypatch) -> None:
    def fake_request(method, path, *, body=None, **_kwargs):
        assert method == "POST"
        assert path == "/resource/recall/knowledge"
        assert body and body["topic_id"] == "0Rp2K3pn"
        return {
            "results": [
                {
                    "note_type": "FILE",
                    "title": "wwg004约束：先尊重，再行动",
                    "content": "先区分硬约束和软约束。",
                    "score": 0,
                    "page_no": 1,
                }
            ]
        }

    monkeypatch.setattr(MODULE, "load_getnote_api", lambda: (fake_request, FakeSchemaError))
    monkeypatch.setattr(MODULE, "COURSE_PATH", COURSE_FIXTURE)
    pack = MODULE.build_evidence(
        problem="我是否应该裸辞创业",
        topic_id="0Rp2K3pn",
        queries=["裸辞创业约束", "期权可逆", "失败反例", "行动停止条件"],
        stage="verification",
        run_id="run-test-001",
        tool_ids=["T005", "T031", "T028", "T086"],
        top_k=10,
        max_excerpts_per_source=4,
        max_note_chars=100,
        max_local_chars=500,
        max_local_chapters=20,
        request_interval_ms=0,
        shared_bucket_name="test",
    )

    assert pack["schema"] == "modern-thinking-tools.evidence.v2"
    assert pack["stage"] == "verification"
    assert pack["run_id"] == "run-test-001"
    assert pack["tool_ids"] == ["T005", "T031", "T028", "T086"]
    assert pack["retrieval_status"] == "partial"
    assert pack["quality"]["course_fulltext_count"] == 1
    assert "<modern-thinking-getnote-evidence>" in pack["prompt_context"]
    assert "约束：先尊重，再行动" in pack["prompt_context"]


def test_all_runtime_failures_emit_explicit_degraded_pack(monkeypatch) -> None:
    def unavailable(*_args, **_kwargs):
        raise RuntimeError("GetNote temporarily unavailable")

    monkeypatch.setattr(MODULE, "load_getnote_api", lambda: (unavailable, FakeSchemaError))
    pack = MODULE.build_evidence(
        problem="职业选择",
        topic_id="0Rp2K3pn",
        queries=["职业选择", "复利", "反例"],
        top_k=10,
        max_excerpts_per_source=4,
        max_note_chars=100,
        max_local_chars=500,
        max_local_chapters=20,
        request_interval_ms=0,
        shared_bucket_name="test",
    )

    assert pack["retrieval_status"] == "degraded"
    assert pack["quality"]["status"] == "degraded"
    assert pack["sources"] == []
    assert "failed" in pack["degradation_reason"]


def test_schema_mismatch_remains_a_hard_error(monkeypatch) -> None:
    def bad_schema(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(MODULE, "load_getnote_api", lambda: (bad_schema, FakeSchemaError))
    with pytest.raises(MODULE.EvidenceError, match="schema mismatch"):
        MODULE.build_evidence(
            problem="职业选择",
            topic_id="0Rp2K3pn",
            queries=["职业选择", "复利", "反例"],
            top_k=10,
            max_excerpts_per_source=4,
            max_note_chars=100,
            max_local_chars=500,
            max_local_chapters=20,
            request_interval_ms=0,
            shared_bucket_name="test",
        )


def test_note_detail_schema_error_remains_a_hard_error(monkeypatch) -> None:
    def note_schema_error(method, path, **_kwargs):
        if method == "POST":
            return {
                "results": [
                    {
                        "note_type": "NOTE",
                        "note_id": "note-1",
                        "title": "个人笔记",
                        "content": "摘要",
                    }
                ]
            }
        assert path == "/resource/note/detail"
        raise FakeSchemaError("detail schema drift")

    monkeypatch.setattr(MODULE, "load_getnote_api", lambda: (note_schema_error, FakeSchemaError))
    with pytest.raises(FakeSchemaError, match="schema drift"):
        MODULE.build_evidence(
            problem="职业选择",
            topic_id="0Rp2K3pn",
            queries=["职业选择", "复利", "反例"],
            top_k=10,
            max_excerpts_per_source=4,
            max_note_chars=100,
            max_local_chars=500,
            max_local_chapters=20,
            request_interval_ms=0,
            shared_bucket_name="test",
        )


def test_request_contract_enforces_stage_query_and_tool_shapes() -> None:
    valid_ids = {f"T{index:03d}" for index in range(1, 101)}
    MODULE.validate_request_contract(
        stage="discovery",
        queries=["q1", "q2", "q3", "q4"],
        tool_ids=[],
        valid_tool_ids=valid_ids,
    )
    MODULE.validate_request_contract(
        stage="verification",
        queries=["q1", "q2", "q3", "q4"],
        tool_ids=["T005", "T021", "T031", "T036"],
        valid_tool_ids=valid_ids,
    )
    with pytest.raises(MODULE.EvidenceError, match="exactly four"):
        MODULE.validate_request_contract(
            stage="discovery",
            queries=["q1", "q2", "q3"],
            tool_ids=[],
            valid_tool_ids=valid_ids,
        )
    with pytest.raises(MODULE.EvidenceError, match="unique"):
        MODULE.validate_request_contract(
            stage="verification",
            queries=["q1", "q2", "q3", "q4"],
            tool_ids=["T005", "T005", "T031", "T036"],
            valid_tool_ids=valid_ids,
        )
    with pytest.raises(MODULE.EvidenceError, match="invalid tool_ids"):
        MODULE.validate_request_contract(
            stage="recovery",
            queries=["q1", "q2", "q3", "q4"],
            tool_ids=["T005", "T021", "T031", "T101"],
            valid_tool_ids=valid_ids,
        )


def test_mixed_fulltext_sources_can_be_ready() -> None:
    reports = [
        {"query_index": index, "status": "ok", "result_count": 1}
        for index in range(1, 5)
    ]
    sources = [
        {"source_quality": "course_chapter_fulltext"},
        {"source_quality": "user_note_fulltext"},
    ]
    quality = MODULE.quality_summary(reports, sources)
    assert quality["status"] == "ready"
    assert quality["high_quality_fulltext_count"] == 2
    assert quality["course_fulltext_count"] == 1


def test_private_writer_repairs_existing_directory_permissions(tmp_path, monkeypatch) -> None:
    output_root = tmp_path / "modern-thinking-tools"
    output_root.mkdir(mode=0o755)
    monkeypatch.setattr(MODULE, "OUTPUT_ROOT", output_root)
    pack = {
        "problem": "测试",
        "topic": {"topic_id": "0Rp2K3pn", "name": "精英日课"},
        "run_id": "run-test",
        "stage": "manual",
        "retrieval_status": "degraded",
        "quality": {"status": "degraded"},
        "query_reports": [],
        "source_count": 0,
        "local_chapter_count": 0,
        "sources": [],
    }
    json_path = output_root / "evidence.json"
    markdown_path = output_root / "evidence.md"
    MODULE.write_private_evidence(json_path, markdown_path, pack)
    assert stat.S_IMODE(output_root.stat().st_mode) == 0o700
    assert stat.S_IMODE(json_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(markdown_path.stat().st_mode) == 0o600


def test_output_prefix_cannot_escape_private_root(tmp_path, monkeypatch) -> None:
    output_root = tmp_path / "private"
    monkeypatch.setattr(MODULE, "OUTPUT_ROOT", output_root)
    with pytest.raises(MODULE.EvidenceError, match="must stay under"):
        MODULE.sanitize_output_prefix(str(tmp_path / "outside" / "evidence"))


def test_catalog_contains_exactly_one_hundred_source_backed_tools() -> None:
    catalog_path = Path(__file__).resolve().parents[1] / "references" / "tool-catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    tools = catalog["tools"]
    assert catalog["schema"] == "modern-thinking-tools.catalog.v1"
    assert catalog["tool_count"] == 100
    assert [tool["id"] for tool in tools] == [f"T{index:03d}" for index in range(1, 101)]
    assert tools[0]["source"]["kind"] == "course_preface"
    assert all(tool["source"]["heading"] for tool in tools)
