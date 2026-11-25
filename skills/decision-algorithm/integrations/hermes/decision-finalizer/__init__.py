"""Finish a Hermes decision turn with text after its bundled calculator succeeds."""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
from pathlib import Path
from threading import Lock

_LOG = logging.getLogger(__name__)
_SKILL_NAME = "decision-algorithm"
_SKILL_ROOT = Path(__file__).resolve().parents[3]
_CALCULATOR = _SKILL_ROOT / "tools/decision_calculator.py"
_ANSWER_INSTRUCTION = (
    "配套计算器已完成本轮量化分析。请直接给出最终答复，停止调用工具。"
    "基于已有数据说明估计成功概率、期望净收益、盈亏平衡概率及单次最坏净损失上限。"
    "加码前重算最坏净损失，超限就缩减重算或取消。缺少预报名数据时只给出观察项和条件式决策。"
)
_TEXT_FINAL_SYSTEM = (
    "只输出用户可读的中文决策答复。题设和配套计算器报告已经在消息中给出。"
    "用报告中的数字解释期望值和盈亏平衡，按用户确认的最坏净损失上限给出继续、降级或取消的条件。"
    "凯利建议投入和理论保本亏损仅供分析，均不得放宽该上限。"
    "预报名数据不足时，说明需要观察的指标和复核时点。"
)


def _payload(result):
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return {}
    return result if isinstance(result, dict) else {}


def _same_path(candidate: str, expected: Path) -> bool:
    try:
        path = Path(candidate)
        return path.is_absolute() and path.resolve(strict=True) == expected
    except (OSError, RuntimeError, TypeError, ValueError):
        return False


def _shell_words(command: str) -> list[str]:
    # A stderr merge must stay on the same command line to preserve its exit code.
    command = re.sub(r"[ \t]+2>&1[ \t]*$", "", command)
    if re.search(r"[;|<>`$#()\\\r\n]", command):
        return []
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _is_calculator_preamble(segments: list[str]) -> bool:
    checks = []
    for segment in segments:
        words = _shell_words(segment)
        if len(words) == 3 and words[:2] == ["ls", "-la"] and _same_path(words[2], _CALCULATOR.parent):
            checks.append("listing")
        elif words == ["echo", "---"]:
            checks.append("separator")
        elif words in (["echo"], ["echo", ""]):
            continue
        elif len(words) == 2 and re.fullmatch(r'''echo[ \t]+(?:"===[^"]+==="|'===[^']+===')''', segment.strip()):
            continue
        else:
            return False
    return checks == ["listing", "separator"]


def _ran_full_calculator(args: dict) -> bool:
    command = args.get("command")
    if not isinstance(command, str) or args.get("background"):
        return False
    segments = command.split(";")
    if len(segments) > 1 and not _is_calculator_preamble(segments[:-1]):
        return False
    parts = _shell_words(segments[-1])

    workdir = args.get("workdir")
    if parts[:1] == ["cd"] and len(parts) >= 3 and parts[2] == "&&":
        workdir, parts = parts[1], parts[3:]
    if len(parts) < 3 or parts[0] not in {"python", "python3"}:
        return False
    if "--full" not in parts[2:] or any("&" in part for part in parts):
        return False
    script = Path(parts[1])
    if not script.is_absolute():
        if not isinstance(workdir, str) or not Path(workdir).is_absolute():
            return False
        script = Path(workdir) / script
    return _same_path(str(script), _CALCULATOR)


def _fictional_final_messages(messages, report: str):
    """Send a first-turn hypothetical and its verified report as plain text."""
    if not isinstance(messages, list) or len(messages) < 3 or not all(isinstance(m, dict) for m in messages):
        return None
    if messages[0].get("role") != "user":
        return None
    content = messages[0].get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list) or not content or not all(
        isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        for block in content
    ):
        return None
    question = content[0]["text"].lstrip()
    fictional = question.startswith(("虚构", "纯假设")) or (
        question.startswith(("假设", "假如", "设想")) and "已确认" in question and "直接分析" in question
    )
    if not fictional:
        return None

    for message in messages[1:]:
        blocks = message.get("content")
        if not isinstance(blocks, list) or not blocks or not all(isinstance(block, dict) for block in blocks):
            return None
        if message.get("role") == "user":
            if any(block.get("type") != "tool_result" for block in blocks):
                return None
        elif message.get("role") == "assistant":
            calls = [block for block in blocks if block.get("type") == "tool_use"]
            if not calls or any(call.get("name") not in {"skill_view", "skills_list", "terminal"} for call in calls):
                return None
            if any(call.get("name") == "skill_view" and call.get("input") != {"name": _SKILL_NAME} for call in calls):
                return None
            if any(call.get("name") == "skills_list" and call.get("input") != {} for call in calls):
                return None
        else:
            return None

    # Omit tool envelopes only on this outbound request. The stored turn stays intact.
    return [{"role": "user", "content": [*content, {
        "type": "text", "text": f"\n本回合已核验的配套计算器报告\n{report}\n\n{_ANSWER_INSTRUCTION}",
    }]}]


def register(ctx):
    turns = {}
    lock = Lock()

    def observe(*, session_id, turn_id, tool_name, args, result, status, **_):
        if not session_id or not turn_id or status != "ok":
            return
        key = session_id, turn_id
        data = _payload(result)
        if tool_name == "skill_view" and not args.get("file_path"):
            if (data.get("success") is True and data.get("name") == _SKILL_NAME
                    and _same_path(data.get("skill_dir"), _SKILL_ROOT)):
                with lock:
                    if turns.get(key) == ("eligible", None):
                        turns[key] = ("loaded", None)
            return
        if tool_name != "terminal" or data.get("exit_code") != 0 or data.get("error"):
            return
        output = data.get("output")
        if not isinstance(output, str) or "决策分析报告" not in output:
            return
        if _ran_full_calculator(args):
            with lock:
                if turns.get(key) == ("loaded", None):
                    if ";" in args["command"]:
                        report = re.search(r"(?m)^期望值 \(EV\):", output)
                        if report:
                            output = output[report.start():]
                    turns[key] = ("calculated", output)

    def annotate_result(*, session_id, turn_id, tool_name, args, result, status, **_):
        if tool_name != "terminal" or status != "ok" or not _ran_full_calculator(args):
            return None
        data = _payload(result)
        if data.get("exit_code") != 0 or data.get("error") or "决策分析报告" not in str(data.get("output", "")):
            return None
        with lock:
            if turns.get((session_id, turn_id)) != ("loaded", None):
                return None
        return json.dumps({**data, "final_response_instruction": _ANSWER_INSTRUCTION}, ensure_ascii=False)

    def finalize(*, session_id, turn_id, provider, api_mode, request, platform="", **_):
        if not session_id or not turn_id:
            return None
        key = session_id, turn_id
        if provider not in {"minimax", "minimax-cn"} or api_mode != "anthropic_messages":
            with lock:
                turns.pop(key, None)
            return None
        with lock:
            phase, report = turns.setdefault(key, ("eligible", None))
            if phase not in {"calculated", "finalizing"}:
                return None
            turns[key] = ("finalizing", report)
        final_request = dict(request)
        for name in ("tools", "tool_choice", "parallel_tool_calls"):
            final_request.pop(name, None)
        if platform == "cli" and os.environ.get("HERMES_IGNORE_RULES") == "1":
            plain_messages = _fictional_final_messages(final_request.get("messages"), report)
            if plain_messages is not None:
                # This wire request has no tools. Do not carry the agent's tool guidance into it.
                final_request["messages"] = plain_messages
                final_request["system"] = _TEXT_FINAL_SYSTEM
                _LOG.info("Using the verified calculator report as text for decision finalization")
        _LOG.info("Decision calculator completed; requesting a text answer")
        return {
            "request": final_request,
            "source": "decision-finalizer",
            "reason": "Bundled decision calculator completed",
        }

    def block_late_tool(*, session_id, turn_id, **_):
        with lock:
            # A sequential sibling tool can reach the guard before the next LLM request.
            phase, _ = turns.get((session_id, turn_id), (None, None))
            if phase not in {"calculated", "finalizing"}:
                return None
        _LOG.info("Blocked a tool request during decision finalization")
        return {"action": "block", "message": _ANSWER_INSTRUCTION}

    def cleanup(*, session_id, turn_id=None, **_):
        with lock:
            if turn_id:
                turns.pop((session_id, turn_id), None)
            else:
                for key in tuple(turns):
                    if key[0] == session_id:
                        del turns[key]

    ctx.register_hook("post_tool_call", observe)
    ctx.register_hook("transform_tool_result", annotate_result)
    ctx.register_hook("pre_tool_call", block_late_tool)
    ctx.register_hook("post_llm_call", cleanup)
    ctx.register_hook("on_session_end", cleanup)
    ctx.register_middleware("llm_request", finalize)
