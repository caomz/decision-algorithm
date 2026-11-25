"""Unit tests for the Hermes decision-finalizer plugin state machine.

The plugin keeps one state entry per (session, turn) inside ``register``:

    (absent) --finalize--> eligible --skill_view--> loaded
    loaded --full calculator run--> calculated --finalize--> finalizing
    calculated/finalizing --cleanup--> (absent)
    any phase --finalize with foreign provider/api_mode--> (absent)

The tests drive the hooks registered on a fake Hermes ctx, so transitions,
guards and terminal states stay pinned without Hermes installed. The plugin
directory name contains a dash, so the module is loaded from its file path.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

PLUGIN_PATH = (
    Path(__file__).resolve().parents[1]
    / "skills" / "decision-algorithm" / "integrations" / "hermes"
    / "decision-finalizer" / "__init__.py"
)
SPEC = importlib.util.spec_from_file_location("decision_finalizer_plugin", PLUGIN_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
# The module resolves paths relative to its own file at import time.
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

SESSION = "session-1"
TURN = "turn-1"

# Sentinel so helpers can pass result=None through to the plugin explicitly.
UNSET = object()

CALCULATOR = MODULE._CALCULATOR
SKILL_ROOT = MODULE._SKILL_ROOT

# Terminal output around a bundled calculator run. The ls noise only shows up
# when the command carries a shell preamble, which the plugin trims away.
REPORT_NOISE = "total 24\n-rw-r--r-- 1 user user 1024 decision_calculator.py\n"
REPORT_BODY = "决策分析报告\n期望值 (EV): 0.55\n盈亏平衡概率: 0.30\n单次最坏净损失上限: 500\n"

FICTIONAL_QUESTION = "假设某笔交易胜率四成、赔率二比一。已确认这是纯推演，请直接分析。"


class FakeCtx:
    """Records hook and middleware registrations, exposing them for tests."""

    def __init__(self) -> None:
        self.hooks: dict = {}
        self.middleware: dict = {}

    def register_hook(self, name, fn) -> None:
        self.hooks[name] = fn

    def register_middleware(self, name, fn) -> None:
        self.middleware[name] = fn


@pytest.fixture
def ctx() -> FakeCtx:
    fake = FakeCtx()
    MODULE.register(fake)
    return fake


def tool_call(name: str, call_input: dict) -> dict:
    return {"type": "tool_use", "id": f"call-{name}", "name": name, "input": call_input}


def tool_result(call_id: str) -> dict:
    return {"type": "tool_result", "tool_use_id": call_id, "content": "ok"}


def calculator_command(stderr_merge: bool = False) -> str:
    command = f"python3 {CALCULATOR} --full"
    return f"{command} 2>&1" if stderr_merge else command


def preamble_command() -> str:
    return f"ls -la {CALCULATOR.parent}; echo ---; {calculator_command()}"


def good_fictional_messages() -> list:
    """A valid first-turn hypothetical trail: question, skill_view, tool result."""
    return [
        {"role": "user", "content": FICTIONAL_QUESTION},
        {"role": "assistant", "content": [tool_call("skill_view", {"name": MODULE._SKILL_NAME})]},
        {"role": "user", "content": [tool_result("call-skill_view")]},
    ]


def observe_skill_view(ctx, *, session=SESSION, turn=TURN, args=None, result=UNSET, status="ok") -> None:
    ctx.hooks["post_tool_call"](
        session_id=session,
        turn_id=turn,
        tool_name="skill_view",
        args=args if args is not None else {},
        result=result if result is not UNSET else {
            "success": True,
            "name": MODULE._SKILL_NAME,
            "skill_dir": str(SKILL_ROOT),
        },
        status=status,
    )


def observe_calculator(ctx, *, session=SESSION, turn=TURN, args=None, result=UNSET, status="ok",
                       output=REPORT_BODY) -> None:
    ctx.hooks["post_tool_call"](
        session_id=session,
        turn_id=turn,
        tool_name="terminal",
        args=args if args is not None else {"command": calculator_command()},
        result=result if result is not UNSET else {"exit_code": 0, "output": output},
        status=status,
    )


def annotate_calculator(ctx, *, session=SESSION, turn=TURN, args=None, result=UNSET, status="ok"):
    """Probe and drive ``transform_tool_result``; fires only while loaded."""
    return ctx.hooks["transform_tool_result"](
        session_id=session,
        turn_id=turn,
        tool_name="terminal",
        args=args if args is not None else {"command": calculator_command()},
        result=result if result is not UNSET else {"exit_code": 0, "output": REPORT_BODY},
        status=status,
    )


def finalize_request(ctx, *, session=SESSION, turn=TURN, provider="minimax",
                     api_mode="anthropic_messages", request=None, platform=""):
    return ctx.middleware["llm_request"](
        session_id=session,
        turn_id=turn,
        provider=provider,
        api_mode=api_mode,
        request=request if request is not None else {"messages": [{"role": "user", "content": "hi"}]},
        platform=platform,
    )


def block_late_tool(ctx, *, session=SESSION, turn=TURN):
    return ctx.hooks["pre_tool_call"](session_id=session, turn_id=turn)


def observe_session_end(ctx, *, session=SESSION, turn=None) -> None:
    ctx.hooks["on_session_end"](session_id=session, turn_id=turn)


def seed_turn(ctx, *, session=SESSION, turn=TURN) -> None:
    """Start a turn like Hermes would: its first llm_request seeds eligibility."""
    assert finalize_request(ctx, session=session, turn=turn) is None


def drive_to_calculated(ctx, *, session=SESSION, turn=TURN) -> None:
    seed_turn(ctx, session=session, turn=turn)
    observe_skill_view(ctx, session=session, turn=turn)
    annotate_calculator(ctx, session=session, turn=turn)
    observe_calculator(ctx, session=session, turn=turn)


# ---------------------------------------------------------------------------
# Wiring


def test_register_wires_expected_hooks_and_middleware():
    fake = FakeCtx()
    MODULE.register(fake)

    assert set(fake.hooks) == {
        "post_tool_call", "transform_tool_result", "pre_tool_call",
        "post_llm_call", "on_session_end",
    }
    assert set(fake.middleware) == {"llm_request"}
    # Session end and post-LLM cleanup share one implementation.
    assert fake.hooks["post_llm_call"] is fake.hooks["on_session_end"]


# ---------------------------------------------------------------------------
# Pure helpers


def test_payload_parses_json_strings_and_rejects_other_types():
    assert MODULE._payload('{"exit_code": 0}') == {"exit_code": 0}
    assert MODULE._payload("not json") == {}
    assert MODULE._payload("[1, 2]") == {}
    assert MODULE._payload({"a": 1}) == {"a": 1}
    assert MODULE._payload(None) == {}
    assert MODULE._payload(7) == {}
    assert MODULE._payload([{"a": 1}]) == {}


def test_shell_words_splits_and_strips_stderr_merge():
    assert MODULE._shell_words("python3 /x/calc.py --full") == ["python3", "/x/calc.py", "--full"]
    assert MODULE._shell_words("python3 /x/calc.py --full 2>&1") == ["python3", "/x/calc.py", "--full"]
    assert MODULE._shell_words("ls\t-la\t/x\t2>&1 ") == ["ls", "-la", "/x"]
    # A stderr merge only survives at the end of the command line.
    assert MODULE._shell_words("echo 2>&1 done") == []


@pytest.mark.parametrize("fragment", [
    "a; b", "a | b", "cat < f", "a > b", "echo `cmd`", "echo $HOME",
    "echo #tag", "echo (x)", "echo x)", "a\\b", "a\rb", "a\nb",
    'echo "unclosed',
])
def test_shell_words_rejects_shell_metacharacters_and_bad_quotes(fragment):
    assert MODULE._shell_words(fragment) == []


def test_same_path_matches_only_existing_absolute_paths():
    assert MODULE._same_path(str(CALCULATOR), CALCULATOR)
    assert not MODULE._same_path("tools/decision_calculator.py", CALCULATOR)
    assert not MODULE._same_path("/etc/passwd", CALCULATOR)
    # Strict resolution: a missing absolute path fails closed.
    assert not MODULE._same_path(str(CALCULATOR.parent / "missing.py"), CALCULATOR)
    # Hostile candidate types fail closed too.
    assert not MODULE._same_path(None, CALCULATOR)
    assert not MODULE._same_path({"path": str(CALCULATOR)}, CALCULATOR)
    assert not MODULE._same_path("x\0y", CALCULATOR)


def test_calculator_preamble_accepts_listing_then_separator():
    assert MODULE._is_calculator_preamble([f"ls -la {CALCULATOR.parent}", "echo ---"])
    # Bare echo, an empty echo and an === banner are tolerated as filler.
    assert MODULE._is_calculator_preamble([
        f"ls -la {CALCULATOR.parent}",
        "echo",
        "echo ''",
        'echo "=== 目录列表 ==="',
        "echo ---",
    ])


def test_calculator_preamble_rejects_wrong_sequence_or_paths():
    assert not MODULE._is_calculator_preamble([f"ls -la {CALCULATOR.parent}"])
    assert not MODULE._is_calculator_preamble(["echo ---", f"ls -la {CALCULATOR.parent}"])
    assert not MODULE._is_calculator_preamble(["ls -la /etc", "echo ---"])
    assert not MODULE._is_calculator_preamble([f"ls {CALCULATOR.parent}", "echo ---"])
    assert not MODULE._is_calculator_preamble(["rm -rf /tmp", "echo ---"])
    assert not MODULE._is_calculator_preamble(["echo"])
    assert not MODULE._is_calculator_preamble(['echo "==="', "echo ---"])


def test_full_calculator_commands_are_recognised():
    assert MODULE._ran_full_calculator({"command": calculator_command()})
    assert MODULE._ran_full_calculator({"command": f"python {CALCULATOR} --full"})
    assert MODULE._ran_full_calculator({"command": calculator_command(stderr_merge=True)})
    assert MODULE._ran_full_calculator({"command": preamble_command()})
    assert MODULE._ran_full_calculator({
        "command": f"cd {CALCULATOR.parent} && python3 decision_calculator.py --full",
    })
    assert MODULE._ran_full_calculator({
        "command": "python3 decision_calculator.py --full",
        "workdir": str(CALCULATOR.parent),
    })


def test_full_calculator_rejects_partial_or_hostile_invocations():
    assert not MODULE._ran_full_calculator({})
    assert not MODULE._ran_full_calculator({"command": 42})
    assert not MODULE._ran_full_calculator({"command": calculator_command(), "background": True})
    assert not MODULE._ran_full_calculator({"command": f"python3 {CALCULATOR} --quick"})
    assert not MODULE._ran_full_calculator({"command": f"node {CALCULATOR} --full"})
    assert not MODULE._ran_full_calculator({"command": f"{calculator_command()} &"})
    assert not MODULE._ran_full_calculator({"command": f"python3 {CALCULATOR.parent / 'other.py'} --full"})
    assert not MODULE._ran_full_calculator({"command": "python3 decision_calculator.py --full"})
    assert not MODULE._ran_full_calculator({
        "command": "python3 decision_calculator.py --full", "workdir": "tools",
    })
    assert not MODULE._ran_full_calculator({
        "command": f"cd {CALCULATOR.parent} && python3 ../decision_calculator.py --full",
    })
    assert not MODULE._ran_full_calculator({
        "command": f"cd {CALCULATOR.parent} python3 {CALCULATOR} --full",
    })
    # A hostile preamble fails closed before the calculator is even checked.
    hostile = f"rm -rf /tmp; echo ---; {calculator_command()}"
    assert not MODULE._ran_full_calculator({"command": hostile})
    # A dangling separator with no command behind it is not a calculator run.
    assert not MODULE._ran_full_calculator({"command": f"{preamble_command()};"})


# ---------------------------------------------------------------------------
# First-turn hypothetical detection


def test_fictional_rewrite_accepts_first_turn_hypotheticals():
    messages = good_fictional_messages()
    out = MODULE._fictional_final_messages(messages, "REPORT")
    assert out is not None
    assert len(out) == 1 and out[0]["role"] == "user"
    assert out[0]["content"][0] == {"type": "text", "text": FICTIONAL_QUESTION}
    instruction = out[0]["content"][1]
    assert instruction["type"] == "text"
    assert "REPORT" in instruction["text"]
    assert MODULE._ANSWER_INSTRUCTION in instruction["text"]

    # A plain-string first message is normalised into text blocks.
    assert MODULE._fictional_final_messages([
        {"role": "user", "content": [{"type": "text", "text": FICTIONAL_QUESTION}]},
    ] + good_fictional_messages()[1:], "REPORT") is not None

    # 虚构 / 纯假设 need no extra confirmation markers.
    for prefix in ("虚构", "纯假设"):
        messages = good_fictional_messages()
        messages[0] = {"role": "user", "content": f"{prefix}一笔交易的盈亏。"}
        assert MODULE._fictional_final_messages(messages, "REPORT") is not None
    # 假设 / 假如 / 设想 need both 已确认 and 直接分析.
    for prefix in ("假设", "假如", "设想"):
        messages = good_fictional_messages()
        messages[0] = {"role": "user", "content": f"{prefix}一笔交易，已确认前提，请直接分析。"}
        assert MODULE._fictional_final_messages(messages, "REPORT") is not None


def test_fictional_rewrite_rejects_real_questions_and_bad_shapes():
    # A real (non-hypothetical) question is never rewritten.
    messages = good_fictional_messages()
    messages[0] = {"role": "user", "content": "请直接分析这笔真实交易。"}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    # 假设 without both markers stays a real question.
    messages = good_fictional_messages()
    messages[0] = {"role": "user", "content": "假设某笔交易胜率四成，请直接分析。"}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    # Structural guards.
    assert MODULE._fictional_final_messages(None, "REPORT") is None
    assert MODULE._fictional_final_messages("not a list", "REPORT") is None
    assert MODULE._fictional_final_messages([], "REPORT") is None
    assert MODULE._fictional_final_messages(good_fictional_messages()[:2], "REPORT") is None

    messages = good_fictional_messages()
    messages[0] = {"role": "assistant", "content": FICTIONAL_QUESTION}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[0]["content"] = {"type": "text", "text": FICTIONAL_QUESTION}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[0]["content"] = []
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[0]["content"] = [{"type": "text", "text": 123}]
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[1] = {"role": "assistant", "content": "plain text"}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[1] = {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[1] = {"role": "assistant", "content": [tool_call("browser", {})]}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[1] = {"role": "assistant", "content": [tool_call("skill_view", {"name": "other-skill"})]}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[1] = {"role": "assistant", "content": [tool_call("skills_list", {"name": "x"})]}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[2] = {"role": "user", "content": [{"type": "text", "text": "再问一句"}]}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages[2] = {"role": "system", "content": [tool_result("call-skill_view")]}
    assert MODULE._fictional_final_messages(messages, "REPORT") is None

    messages = good_fictional_messages()
    messages.append({"role": "user", "content": [{"type": "text", "text": "hi"}]})
    assert MODULE._fictional_final_messages(messages, "REPORT") is None


# ---------------------------------------------------------------------------
# observe (post_tool_call): guard branches and transitions


def test_observe_requires_ok_status_and_valid_ids(ctx):
    seed_turn(ctx)
    observe_skill_view(ctx, status="error")
    observe_calculator(ctx, status="error")
    observe_skill_view(ctx, session="")
    observe_calculator(ctx, turn="")
    observe_skill_view(ctx, turn="")
    assert annotate_calculator(ctx) is None  # never loaded

    observe_skill_view(ctx)  # a real call still loads the turn
    assert annotate_calculator(ctx) is not None


def test_observe_skill_view_requires_skill_overview_payload(ctx):
    seed_turn(ctx)
    # Viewing a file inside the skill is not the skill overview.
    observe_skill_view(ctx, args={"file_path": "SKILL.md"})
    assert annotate_calculator(ctx) is None

    observe_skill_view(ctx, result={"success": False, "name": MODULE._SKILL_NAME, "skill_dir": str(SKILL_ROOT)})
    observe_skill_view(ctx, result={"name": MODULE._SKILL_NAME, "skill_dir": str(SKILL_ROOT)})
    observe_skill_view(ctx, result={"success": True, "name": "other-skill", "skill_dir": str(SKILL_ROOT)})
    observe_skill_view(ctx, result={"success": True, "name": MODULE._SKILL_NAME, "skill_dir": str(SKILL_ROOT.parent)})
    observe_skill_view(ctx, result={"success": True, "name": MODULE._SKILL_NAME, "skill_dir": "skills/decision-algorithm"})
    observe_skill_view(ctx, result={"success": True, "name": MODULE._SKILL_NAME, "skill_dir": {"dir": SKILL_ROOT}})
    assert annotate_calculator(ctx) is None

    observe_skill_view(ctx)
    assert annotate_calculator(ctx) is not None

    # A repeated overview while loaded is a no-op.
    observe_skill_view(ctx)
    assert annotate_calculator(ctx) is not None


def test_observe_terminal_requires_successful_full_calculator_report(ctx):
    seed_turn(ctx)
    observe_skill_view(ctx)

    # Not the full calculator.
    observe_calculator(ctx, args={"command": f"python3 {CALCULATOR}"})
    observe_calculator(ctx, args={"command": calculator_command(), "background": True})
    # Failing payloads.
    observe_calculator(ctx, result={"exit_code": 1, "output": REPORT_BODY})
    observe_calculator(ctx, result={"exit_code": 0, "output": REPORT_BODY, "error": "boom"})
    observe_calculator(ctx, result={"exit_code": 0, "output": "hello world"})
    observe_calculator(ctx, result={"exit_code": 0, "output": ["报告"]})
    observe_calculator(ctx, result="not json")
    observe_calculator(ctx, result=None)
    # None of those moved the machine out of loaded.
    assert annotate_calculator(ctx) is not None

    observe_calculator(ctx)  # a proper run reaches calculated
    assert annotate_calculator(ctx) is None
    assert block_late_tool(ctx) == {"action": "block", "message": MODULE._ANSWER_INSTRUCTION}


def test_report_trims_to_ev_line_for_preambled_commands(ctx, monkeypatch):
    monkeypatch.setenv("HERMES_IGNORE_RULES", "1")
    seed_turn(ctx)
    observe_skill_view(ctx)
    observe_calculator(ctx, args={"command": preamble_command()},
                       output=REPORT_NOISE + REPORT_BODY)

    final = finalize_request(ctx, request={"messages": good_fictional_messages()}, platform="cli")
    text = final["request"]["messages"][0]["content"][-1]["text"]
    # The stored report starts at the EV line: preamble noise is gone.
    assert text.startswith("\n本回合已核验的配套计算器报告\n期望值 (EV): 0.55\n")
    assert "total 24" not in text
    assert "决策分析报告" not in text
    assert MODULE._ANSWER_INSTRUCTION in text


def test_report_stays_whole_without_ev_line(ctx, monkeypatch):
    monkeypatch.setenv("HERMES_IGNORE_RULES", "1")
    seed_turn(ctx)
    observe_skill_view(ctx)
    observe_calculator(ctx, args={"command": preamble_command()}, output="决策分析报告\n无期望值行")

    final = finalize_request(ctx, request={"messages": good_fictional_messages()}, platform="cli")
    text = final["request"]["messages"][0]["content"][-1]["text"]
    assert "无期望值行" in text
    assert "期望值 (EV):" not in text


def test_calculator_run_requires_loaded_phase(ctx):
    seed_turn(ctx)
    # Without the skill view, calculator evidence alone changes nothing.
    observe_calculator(ctx, args={"command": preamble_command()},
                       output=REPORT_NOISE + REPORT_BODY)
    assert block_late_tool(ctx) is None
    assert annotate_calculator(ctx) is None

    # Once loaded, the same run reaches calculated...
    observe_skill_view(ctx)
    observe_calculator(ctx, args={"command": preamble_command()},
                       output=REPORT_NOISE + REPORT_BODY)
    assert block_late_tool(ctx) is not None

    # ...and a repeated run while calculated is a no-op.
    observe_calculator(ctx, args={"command": preamble_command()},
                       output=REPORT_NOISE + REPORT_BODY)
    assert block_late_tool(ctx) is not None
    assert annotate_calculator(ctx) is None


# ---------------------------------------------------------------------------
# finalize (llm_request middleware)


def test_finalize_seeds_fresh_turns_as_eligible(ctx):
    # A fresh turn is recorded as eligible; no request rewrite happens yet.
    assert finalize_request(ctx) is None
    # observe needs exactly that seeded eligible state to load the turn.
    observe_skill_view(ctx)
    assert annotate_calculator(ctx) is not None


def test_finalize_needs_calculated_phase(ctx):
    seed_turn(ctx)
    observe_skill_view(ctx)
    assert finalize_request(ctx) is None  # loaded is not enough
    observe_calculator(ctx)
    assert finalize_request(ctx) is not None


def test_finalize_returns_tool_free_request_with_source_marker(ctx):
    drive_to_calculated(ctx)
    request = {
        "messages": [{"role": "user", "content": "hi"}],
        "system": "sys",
        "tools": [{"name": "terminal"}],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
    }
    final = finalize_request(ctx, request=request)

    assert set(final) == {"request", "source", "reason"}
    assert final["source"] == "decision-finalizer"
    assert final["reason"] == "Bundled decision calculator completed"
    stripped = final["request"]
    assert stripped["messages"] == request["messages"]
    assert stripped["system"] == "sys"
    for gone in ("tools", "tool_choice", "parallel_tool_calls"):
        assert gone not in stripped
    # The caller's request dict is left untouched.
    assert request["tools"] == [{"name": "terminal"}]
    assert request["tool_choice"] == "auto"


def test_finalize_resets_turn_for_foreign_provider_or_api_mode(ctx):
    drive_to_calculated(ctx)
    assert finalize_request(ctx, provider="openai") is None
    # The mismatch removed the turn: the machine forgot everything about it.
    assert block_late_tool(ctx) is None
    assert annotate_calculator(ctx) is None

    seed_turn(ctx)  # rebuilding from scratch works
    observe_skill_view(ctx)
    assert annotate_calculator(ctx) is not None
    observe_calculator(ctx)

    assert finalize_request(ctx, api_mode="chat_completions") is None
    assert block_late_tool(ctx) is None


def test_finalize_requires_session_and_turn_ids(ctx):
    drive_to_calculated(ctx)
    assert finalize_request(ctx, session=None) is None
    assert finalize_request(ctx, turn="") is None
    # Missing ids return early without disturbing the recorded turn.
    assert block_late_tool(ctx) is not None


def test_finalize_text_rewrite_requires_cli_and_env_flag(ctx, monkeypatch):
    request = {"messages": good_fictional_messages(), "system": "orig"}
    drive_to_calculated(ctx)

    # cli plus the flag rewrites messages and system...
    monkeypatch.setenv("HERMES_IGNORE_RULES", "1")
    rewritten = finalize_request(ctx, request=request, platform="cli")
    assert rewritten["request"]["system"] == MODULE._TEXT_FINAL_SYSTEM
    rewritten_messages = rewritten["request"]["messages"]
    assert len(rewritten_messages) == 1 and rewritten_messages[0]["role"] == "user"
    assert rewritten_messages[0]["content"][0] == {"type": "text", "text": FICTIONAL_QUESTION}
    assert REPORT_BODY in rewritten_messages[0]["content"][1]["text"]
    assert "tools" not in rewritten["request"]

    # ...a foreign platform keeps the request untouched...
    drive_to_calculated(ctx, session="session-2", turn="turn-2")
    foreign_request = {"messages": good_fictional_messages(), "system": "orig"}
    untouched = finalize_request(
        ctx, session="session-2", turn="turn-2",
        request=foreign_request,
        platform="web",
    )
    assert untouched["request"]["messages"] == foreign_request["messages"]
    assert untouched["request"]["system"] == "orig"

    # ...and so does cli without the flag.
    drive_to_calculated(ctx, session="session-3", turn="turn-3")
    monkeypatch.delenv("HERMES_IGNORE_RULES", raising=False)
    flagless_request = {"messages": good_fictional_messages(), "system": "orig"}
    no_flag = finalize_request(
        ctx, session="session-3", turn="turn-3",
        request=flagless_request,
        platform="cli",
    )
    assert no_flag["request"]["messages"] == flagless_request["messages"]
    assert no_flag["request"]["system"] == "orig"


def test_finalize_keeps_real_requests_untouched_under_cli_flag(ctx, monkeypatch):
    monkeypatch.setenv("HERMES_IGNORE_RULES", "1")
    request = {"messages": good_fictional_messages(), "system": "orig"}
    request["messages"][0] = {"role": "user", "content": "真实交易，请直接分析。"}
    drive_to_calculated(ctx)

    # cli plus the flag only rewrites first-turn hypotheticals, never real turns.
    out = finalize_request(ctx, request=request, platform="cli")
    assert out["request"]["messages"] == request["messages"]
    assert out["request"]["system"] == "orig"


# ---------------------------------------------------------------------------
# annotate_result (transform_tool_result)


def test_annotate_requires_full_calculator_success(ctx):
    seed_turn(ctx)
    observe_skill_view(ctx)

    assert ctx.hooks["transform_tool_result"](
        session_id=SESSION, turn_id=TURN, tool_name="skill_view",
        args={"command": calculator_command()}, result={"exit_code": 0, "output": REPORT_BODY},
        status="ok",
    ) is None
    assert annotate_calculator(ctx, status="error") is None
    assert annotate_calculator(ctx, args={"command": "ls -la /"}) is None
    assert annotate_calculator(ctx, args={"command": calculator_command(), "background": True}) is None
    assert annotate_calculator(ctx, result={"exit_code": 3, "output": REPORT_BODY}) is None
    assert annotate_calculator(ctx, result={"exit_code": 0, "output": REPORT_BODY, "error": "boom"}) is None
    assert annotate_calculator(ctx, result={"exit_code": 0, "output": "no report"}) is None
    assert annotate_calculator(ctx, result=None) is None

    # A JSON-string payload is parsed before annotation.
    annotated = annotate_calculator(
        ctx, result=json.dumps({"exit_code": 0, "output": REPORT_BODY}, ensure_ascii=False),
    )
    assert annotated is not None
    assert json.loads(annotated)["final_response_instruction"] == MODULE._ANSWER_INSTRUCTION


# ---------------------------------------------------------------------------
# block_late_tool (pre_tool_call)


def test_block_late_tool_only_fires_after_calculator(ctx):
    assert block_late_tool(ctx) is None  # absent
    assert finalize_request(ctx) is None  # seeds eligible
    assert block_late_tool(ctx) is None  # eligible
    observe_skill_view(ctx)
    assert block_late_tool(ctx) is None  # loaded
    observe_calculator(ctx)
    assert block_late_tool(ctx) == {"action": "block", "message": MODULE._ANSWER_INSTRUCTION}


# ---------------------------------------------------------------------------
# cleanup (post_llm_call / on_session_end) and isolation


def test_cleanup_clears_one_turn_or_whole_session(ctx):
    drive_to_calculated(ctx, turn="t1")
    drive_to_calculated(ctx, session="s2", turn="t2")
    drive_to_calculated(ctx, session="s2", turn="t3")

    # A session-wide cleanup clears that session's turns...
    observe_session_end(ctx, session="s2")
    assert block_late_tool(ctx, session="s2", turn="t2") is None
    assert block_late_tool(ctx, session="s2", turn="t3") is None
    # ...and leaves turns of other sessions alone.
    assert block_late_tool(ctx, turn="t1") is not None

    # A single-turn cleanup removes exactly that turn.
    observe_session_end(ctx, turn="t1")
    assert block_late_tool(ctx, turn="t1") is None

    # An empty turn id behaves like a session-wide cleanup.
    drive_to_calculated(ctx, turn="t4")
    observe_session_end(ctx, turn="")
    assert block_late_tool(ctx, turn="t4") is None

    # Cleaning an unknown session is a no-op.
    observe_session_end(ctx, session="missing")


def test_turns_are_isolated_per_session_and_turn(ctx):
    seed_turn(ctx, session="s1", turn="t1")
    observe_skill_view(ctx, session="s1", turn="t1")
    assert annotate_calculator(ctx, session="s1", turn="t2") is None
    assert annotate_calculator(ctx, session="s2", turn="t1") is None
    assert annotate_calculator(ctx, session="s1", turn="t1") is not None

    observe_calculator(ctx, session="s1", turn="t1")
    assert block_late_tool(ctx, session="s1", turn="t1") is not None
    assert block_late_tool(ctx, session="s1", turn="t2") is None
    assert block_late_tool(ctx, session="s2", turn="t1") is None


def test_full_state_machine_flow_and_terminal_cleanup(ctx):
    # eligible: a fresh turn annotates and finalizes nothing.
    assert annotate_calculator(ctx) is None
    assert finalize_request(ctx) is None
    assert block_late_tool(ctx) is None

    # loaded: the skill overview was observed.
    observe_skill_view(ctx)
    annotated = annotate_calculator(ctx)
    assert annotated is not None
    assert json.loads(annotated)["final_response_instruction"] == MODULE._ANSWER_INSTRUCTION

    # calculated: the bundled calculator ran in full.
    observe_calculator(ctx)
    assert annotate_calculator(ctx) is None  # annotation fires exactly once
    assert block_late_tool(ctx) == {"action": "block", "message": MODULE._ANSWER_INSTRUCTION}

    # finalizing: the middleware answers with a tool-free request...
    request = {
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{"name": "terminal"}],
        "tool_choice": "auto",
    }
    final = finalize_request(ctx, request=request)
    assert final["source"] == "decision-finalizer"
    assert "tools" not in final["request"]
    # ...keeps blocking sibling tools and stays finalizable while finalizing.
    assert block_late_tool(ctx) == {"action": "block", "message": MODULE._ANSWER_INSTRUCTION}
    assert finalize_request(ctx, request=request) is not None

    # Terminal state: cleanup removes the turn entirely.
    ctx.hooks["post_llm_call"](session_id=SESSION, turn_id=TURN)
    assert block_late_tool(ctx) is None
    assert annotate_calculator(ctx) is None
    assert finalize_request(ctx, request=request) is None
