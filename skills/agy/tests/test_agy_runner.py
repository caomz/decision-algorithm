#!/usr/bin/env python3
"""Offline behavioral tests for agy_runner.py. No live model calls are made."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
RUNNER = SKILL_ROOT / "scripts" / "agy_runner.py"
REVIEW_SCHEMA = SKILL_ROOT / "references" / "review.schema.json"
TUTORIAL_SCHEMA = SKILL_ROOT / "references" / "tutorial.schema.json"
BOUNDARY_PROMPT = "AGY_READ_ONLY_BOUNDARY_V1\nRead-only test prompt.\n"


MOCK_SOURCE = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

for stream in (sys.stdin, sys.stdout, sys.stderr):
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure:
        reconfigure(encoding="utf-8", errors="replace")

if "--version" in sys.argv:
    print("1.1.26")
    raise SystemExit(0)

scenario = os.environ.get("MOCK_SCENARIO", "success")
payload = sys.stdin.read()
marker = os.environ.get("MOCK_LAUNCH_MARKER")
if marker:
    Path(marker).write_text("launched")
env_dump = os.environ.get("MOCK_ENV_DUMP")
if env_dump:
    Path(env_dump).write_text(json.dumps({
        "cwd": os.getcwd(),
        "cmux_disabled": os.environ.get("CMUX_ANTIGRAVITY_HOOKS_DISABLED"),
    }), encoding="utf-8")
if "--log-file" in sys.argv:
    cli_log = Path(sys.argv[sys.argv.index("--log-file") + 1])
    if scenario == "cli_log_model":
        cli_log.write_text(
            "I1117 17:10:00.000001 10 model_resolver.go:30] Resolving model MODEL_PLACEHOLDER_M18\n"
            "I1117 17:10:00.000002 10 model_config_manager.go:215] "
            'Propagating selected model override to backend: label="Gemini 4 Carbon (High)"\n'
            "I1117 17:10:00.000003 10 llm_monitor.go:88] background check tier=MODEL_TIER_FLASH_LITE\n",
            encoding="utf-8",
        )
    elif scenario == "cli_log_resolver":
        cli_log.write_text(
            "I1117 17:10:00.000001 10 model_resolver.go:77] Resolving model gemini-3.1-pro-low\n"
            "I1117 17:10:00.000002 10 llm_monitor.go:88] background check tier=MODEL_TIER_FLASH_LITE\n",
            encoding="utf-8",
        )
conversation = "11111111-1111-4111-8111-111111111111"
resumed = "--conversation" in sys.argv

def emit(value):
    print(json.dumps(value), flush=True)

if scenario == "timeout":
    time.sleep(3)
    raise SystemExit(0)

permission_mode = {"always_proceed": "always-proceed", "always_proceed_policy": "always-proceed", "strict_permission": "strict", "unknown_permission": "future-permissive", "missing_permission": None}.get(scenario, "request-review")
canary_steps = []
if "--settings" in sys.argv:
    settings = json.loads(Path(sys.argv[sys.argv.index("--settings") + 1]).read_text())
    assert settings["permissions"]["deny"] == [
        "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "command(*)", "mcp(*)",
    ]
    permission_mode = settings["toolPermission"]
    hooks = json.loads(Path(".agents/hooks.json").read_text())
    pre = hooks["gstack-summary-only"]["PreToolUse"][0]
    assert pre["matcher"] == "*"
    if scenario.startswith("canary") or scenario == "summary_tool":
        names = ["read_file", "write_file", "run_command", "invoke_subagent"]
        if scenario == "canary_old_aliases":
            names[:2] = ["view_file", "write_to_file"]
        if scenario in {"canary_partial", "summary_tool"}:
            names = names[:1]
        for index, tool in enumerate(names, 1):
            hook_conversation = "22222222-2222-4222-8222-222222222222" if scenario == "canary_wrong_conversation" else conversation
            hook_tool = "view_file" if scenario == "canary_wrong_tool" and index == 1 else tool
            call = subprocess.run(shlex.split(pre["hooks"][0]["command"]), text=True,
                input=json.dumps({"conversationId": hook_conversation, "toolCall": {"name": hook_tool, "args": {}}}),
                capture_output=True, check=True)
            verdict = json.loads(call.stdout)
            assert verdict["decision"] == "deny"
            if scenario == "canary_missing_frames":
                continue
            attempted = {
                "conversation_id": conversation, "step_index": index, "state": "ACTIVE",
                "step_type": "tool", "tool_name": tool,
                "tool_info": {"name": tool, "parameters": {}},
            }
            rejected = dict(attempted, state="ERROR")
            if tool == "invoke_subagent":
                rejected["step_type"] = "subagent"
                del rejected["tool_info"]
                rejected["subagent_info"] = {"subagents": []}
                if scenario == "canary_started_child":
                    rejected["subagent_info"]["subagents"].append({"conversation_id": "synthetic-child"})
                if scenario == "canary_unmatched_child":
                    rejected["step_index"] += 1
                if scenario.startswith("canary_v156"):
                    proposal = {"type_name": "research", "role": "Synthetic responder", "initial_prompt": "Reply SYNTHETIC"}
                    attempted["step_type"] = "subagent"
                    del attempted["tool_info"]
                    attempted["subagent_info"] = {"subagents": [proposal]}
                    rejected["duration_seconds"] = 0.5
                    if scenario == "canary_v156_child_id":
                        proposal["conversation_id"] = "synthetic-child"
                    if scenario == "canary_v156_status":
                        proposal["status"] = "running"
                    if scenario == "canary_v156_long_prompt":
                        proposal["initial_prompt"] = " " * 4096 + "Synthetic"
                    if scenario == "canary_v156_output":
                        attempted["output"] = "synthetic output"
                    if scenario == "canary_v156_child_in_error":
                        rejected["subagent_info"]["subagents"].append(proposal)
                    if scenario == "canary_v156_completed":
                        rejected["state"] = "DONE"
            else:
                error = {"type": "TOOL_ERROR", "message": "tool call denied by pre-tool hook: " + verdict["reason"]}
                rejected["tool_info"] = dict(attempted["tool_info"], error=error)
                if scenario == "canary_completed":
                    rejected["state"] = "DONE"
                if scenario == "canary_produced_output":
                    rejected["tool_info"]["output"] = "synthetic tool result"
                if scenario == "canary_other_error":
                    error["message"] = "synthetic tool failure"
            canary_steps.extend([attempted, rejected])
        call = subprocess.run(shlex.split(pre["hooks"][0]["command"]), text=True,
            input=json.dumps({"conversationId": conversation, "toolCall": {"name": "finish", "args": {}}}),
            capture_output=True, check=True)
        assert json.loads(call.stdout)["decision"] == "allow"
if scenario != "missing_init":
    init_event = {"event": "init", "conversation_id": conversation, "init": {"permission_mode": permission_mode}}
    if scenario in {"observed_model", "conflicting_model"}:
        init_event["init"]["model"] = "gemini-test-observed"
    emit(init_event)
    if scenario == "duplicate_init":
        emit(init_event)
emit({"event": "step_update", "step_update": {
    "conversation_id": conversation, "step_index": 0, "state": "DONE", "step_type": "user_input"
}})
for step in canary_steps:
    emit({"event": "step_update", "step_update": step})

review = {
    "summary": "No critical issue.",
    "findings": [],
    "recommendation": "Proceed.",
    "confidence": "high"
}
tutorial = {
    "verdict": "WARN",
    "summary": "One claim remains unverified.",
    "evidence_summary": {"OFFICIAL": 1, "LOCAL_HELP": 1, "RUNTIME": 0, "MODEL_INFERENCE": 0, "UNVERIFIED": 1},
    "findings": [],
    "test_plan": [],
    "corrected_steps": [],
    "recommendation": "Verify the remaining claim."
}
structured = tutorial if any("tutorial.schema.json" in arg for arg in sys.argv) else review

if scenario == "p1":
    structured["findings"] = [{
        "severity": "P1", "title": "Critical", "location": "a.py:1",
        "evidence": "Reproduces", "impact": "Data loss", "recommendation": "Fix it"
    }]
elif scenario == "bad_schema":
    structured = {"summary": "missing required fields"}
elif scenario in {"policy", "always_proceed_policy"}:
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "DONE",
        "step_type": "tool", "tool_name": "run_command",
        "tool_info": {"name": "run_command", "parameters": {"CommandLine": "git status"}, "output": ""}
    }})
elif scenario == "skill_path":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "DONE",
        "step_type": "tool", "tool_name": "view_file",
        "tool_info": {"name": "view_file", "parameters": {"path": "/tmp/skills/x/SKILL.md"}, "output": ""}
    }})
elif scenario == "outside_path":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "DONE",
        "step_type": "tool", "tool_name": "view_file",
        "tool_info": {"name": "view_file", "parameters": {"path": "/etc/passwd"}, "output": ""}
    }})
elif scenario == "windows_path":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "DONE",
        "step_type": "tool", "tool_name": "view_file",
        "tool_info": {"name": "view_file", "parameters": {"path": "C:/workspace/test.py"}, "output": ""}
    }})
elif scenario == "subagent":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "DONE",
        "step_type": "agent_response", "subagent_info": {"subagents": [{"role": "reviewer"}]}
    }})
elif scenario == "unknown_step":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "DONE", "step_type": "terminal"
    }})
elif scenario == "finish_step":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "ACTIVE",
        "step_type": "tool", "tool_name": "finish",
        "tool_info": {"name": "finish", "parameters": dict(structured, summary="Reviewed skills/demo/SKILL.md text and /etc/hosts as quoted data."), "output": ""}
    }})
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 3, "state": "DONE", "step_type": "finish"
    }})
elif scenario == "finish_bad_params":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 1, "state": "ACTIVE",
        "step_type": "tool", "tool_name": "finish",
        "tool_info": {"name": "finish", "parameters": "not-an-object", "output": ""}
    }})
elif scenario == "malformed":
    print("not-json", flush=True)
elif scenario == "bad_tool_info":
    emit({"event": "step_update", "step_update": {"step_type": "tool", "tool_info": "malformed"}})
elif scenario == "read_path":
    emit({"event": "step_update", "step_update": {
        "step_type": "tool", "tool_name": "view_file",
        "tool_info": {"parameters": {"AbsolutePath": os.environ["READ_FIXTURE"]}}
    }})
elif scenario == "read_unknown_parameter":
    emit({"event": "step_update", "step_update": {
        "step_type": "tool", "tool_name": "view_file",
        "tool_info": {"parameters": {"AbsolutePath": os.environ["READ_FIXTURE"], "nested": {"path": "/elsewhere"}}}
    }})
elif scenario == "missing_result":
    raise SystemExit(0)

status = "MYSTERY" if scenario == "unknown_status" else "SUCCESS"
response = "" if scenario == "empty" else json.dumps(structured)
if scenario == "args":
    response = json.dumps({"argv": sys.argv[1:], "payload": payload}, ensure_ascii=False)
result = {
    "conversation_id": conversation,
    "status": status,
    "response": response,
    "usage": {"input_tokens": 10, "output_tokens": 5, "thinking_tokens": 2, "cache_read_tokens": 1, "total_tokens": 17}
}
if scenario == "conflicting_model":
    result["model"] = "other-test"
if scenario == "bad_response":
    result["response"] = {"not": "text"}
if scenario == "bad_status":
    result["status"] = []
if "--json-schema" in sys.argv and scenario != "empty":
    result["structured_output"] = structured
if resumed:
    result["usage"]["total_tokens"] = 99

if scenario == "auth":
    result["status"] = "ERROR"
    result["error"] = "authentication required; run agy login; Bearer synthetic-secret; echo synthetic-input"
    emit({"event": "result", "result": result})
    print("authentication required", file=sys.stderr)
    raise SystemExit(1)
if scenario == "api_error":
    emit({"event": "step_update", "step_update": {
        "conversation_id": conversation, "step_index": 3, "state": "DONE", "step_type": "error_message"
    }})
    result["status"] = "ERROR"
    result["error"] = "API error (attempt 2): request failed: Post \"https://example.invalid/v1internal:streamGenerateContent?alt=sse\": EOF"
    emit({"event": "result", "result": result})
    raise SystemExit(1)
if scenario == "quota":
    result["status"] = "ERROR"
    result["error"] = "quota exceeded"
    emit({"event": "result", "result": result})
    raise SystemExit(1)
if scenario == "model":
    result["status"] = "ERROR"
    result["error"] = "invalid model selection: model is not recognized as a known model"
    emit({"event": "result", "result": result})
    raise SystemExit(1)
if scenario == "cli_crash_stderr":
    result["status"] = "ERROR"
    result["error"] = "transport closed unexpectedly"
    emit({"event": "result", "result": result})
    print(
        "flag provided but not defined: -bad-flag\n"
        "fatal: dial tcp 127.0.0.1:443: connection refused; Bearer secret-tok-999",
        file=sys.stderr,
    )
    raise SystemExit(2)
if scenario == "permission_notice":
    print("tool request soft-denied because it requires user approval", file=sys.stderr)

emit({"event": "step_update", "step_update": {
    "conversation_id": conversation, "step_index": 2, "state": "DONE", "step_type": "checkpoint"
}})
emit({"event": "result", "result": result})
if scenario == "duplicate_result":
    emit({"event": "result", "result": result})
if scenario == "false_success":
    raise SystemExit(9)
'''


class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.scratch = Path(tempfile.mkdtemp(prefix="agy-runner-tests-"))
        cls.mock = cls.scratch / "agy-mock"
        cls.mock.write_text(MOCK_SOURCE, encoding="utf-8")
        cls.mock.chmod(0o755)
        cls.state_root = cls.scratch / "state"
        cls.workspace = cls.scratch / "work"
        cls.workspace.mkdir()

    def invoke(
        self,
        scenario: str,
        *,
        schema: Path | str | None = REVIEW_SCHEMA,
        prompt: str = BOUNDARY_PROMPT,
        extra: list[str] | None = None,
        timeout: int = 10,
        env_overrides: dict[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict]:
        command = [
            sys.executable,
            str(RUNNER),
            "--agy-bin",
            str(self.mock),
            "--timeout-seconds",
            str(timeout),
            "--cwd",
            str(self.workspace),
        ]
        if schema:
            command.extend(["--schema", str(schema)])
        if extra:
            command.extend(extra)
        env = os.environ.copy()
        env["MOCK_SCENARIO"] = scenario
        env["XDG_STATE_HOME"] = str(self.state_root)
        env["TMP_ROOT"] = str(self.scratch)
        if env_overrides:
            env.update(env_overrides)
        completed = subprocess.run(command, input=prompt, text=True, capture_output=True, env=env, check=False)
        return completed, json.loads(completed.stdout)

    def test_success_and_p1_are_preserved(self) -> None:
        success, body = self.invoke("success")
        self.assertEqual(success.returncode, 0)
        self.assertTrue(body["ok"])
        self.assertEqual(body["status"], "SUCCESS")
        self.assertEqual(body["structured_output"]["findings"], [])

        p1, body = self.invoke("p1")
        self.assertEqual(p1.returncode, 0)
        self.assertEqual(body["structured_output"]["findings"][0]["severity"], "P1")

    def test_tutorial_warn_schema(self) -> None:
        completed, body = self.invoke("success", schema=TUTORIAL_SCHEMA)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(body["structured_output"]["verdict"], "WARN")

    def test_known_authorized_permission_modes_are_accepted(self) -> None:
        for scenario, mode in [("always_proceed", "always-proceed"), ("strict_permission", "strict"), ("success", "request-review")]:
            with self.subTest(mode=mode):
                completed, body = self.invoke(scenario)
                self.assertEqual(completed.returncode, 0)
                self.assertTrue(body["ok"])
                self.assertEqual(body["permission_mode"], mode)

    def test_always_proceed_does_not_bypass_read_only_tool_audit(self) -> None:
        completed, body = self.invoke("always_proceed_policy")
        self.assertEqual(completed.returncode, 4)
        self.assertEqual(body["permission_mode"], "always-proceed")
        self.assertEqual(body["error_kind"], "POLICY_VIOLATION")
        self.assertTrue(body["policy_violations"])

    def test_empty_and_bad_schema_fail(self) -> None:
        completed, body = self.invoke("empty", schema=None)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "PROTOCOL_ERROR")

        completed, body = self.invoke("bad_schema")
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "PROTOCOL_ERROR")
        self.assertIn("missing required property", body["error"])

    def test_cli_error_classification(self) -> None:
        completed, body = self.invoke("auth")
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "AUTH_ERROR")
        self.assertNotIn("synthetic-secret", json.dumps(body))
        self.assertNotIn("synthetic-input", Path(body["raw_stderr_path"]).read_text())

        completed, body = self.invoke("quota")
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "QUOTA_ERROR")

        completed, body = self.invoke("model")
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "MODEL_ERROR")

        completed, body = self.invoke("api_error")
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "CLI_ERROR")
        self.assertEqual(body["policy_violations"], [])
        self.assertIn("API error", body["error"])

    def test_protocol_failures(self) -> None:
        for scenario in (
            "malformed",
            "missing_init",
            "duplicate_init",
            "missing_result",
            "unknown_status",
            "duplicate_result",
            "bad_tool_info",
            "bad_response",
            "bad_status",
        ):
            with self.subTest(scenario=scenario):
                completed, body = self.invoke(scenario)
                self.assertEqual(completed.returncode, 3)
                self.assertEqual(body["error_kind"], "PROTOCOL_ERROR")

    def test_policy_violations(self) -> None:
        for scenario in (
            "policy",
            "skill_path",
            "outside_path",
            "windows_path",
            "subagent",
            "unknown_step",
            "unknown_permission",
            "missing_permission",
            "permission_notice",
        ):
            with self.subTest(scenario=scenario):
                completed, body = self.invoke(scenario)
                self.assertEqual(completed.returncode, 4)
                self.assertEqual(body["error_kind"], "POLICY_VIOLATION")
                self.assertTrue(body["policy_violations"])

        completed, body = self.invoke("windows_path")
        self.assertNotIn("external URI rejected", body["error"])
        self.assertIn("foreign Windows path", body["error"])

    def test_agy_1_4_finish_step_carries_output_not_access(self) -> None:
        completed, body = self.invoke("finish_step")
        self.assertEqual(completed.returncode, 0, body.get("error"))
        self.assertTrue(body["ok"])
        self.assertEqual(body["policy_violations"], [])
        self.assertEqual([call["tool_name"] for call in body["tool_calls"]], ["finish"])

        completed, body = self.invoke("finish_bad_params")
        self.assertEqual(completed.returncode, 4)
        self.assertEqual(body["error_kind"], "POLICY_VIOLATION")
        self.assertIn("finish step parameters are not an object", body["error"])

    def test_missing_binary(self) -> None:
        command = [
            sys.executable,
            str(RUNNER),
            "--agy-bin",
            str(self.scratch / "does-not-exist"),
        ]
        completed = subprocess.run(command, input=BOUNDARY_PROMPT, text=True, capture_output=True, check=False)
        body = json.loads(completed.stdout)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(body["error_kind"], "BINARY_NOT_FOUND")

    def test_boundary_is_required(self) -> None:
        completed, body = self.invoke("success", prompt="no boundary\n")
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(body["error_kind"], "BOUNDARY_ERROR")

    def test_timeout(self) -> None:
        completed, body = self.invoke("timeout", timeout=1)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "TIMEOUT")

    def test_utf8_and_cli_argument_assembly(self) -> None:
        conversation = "22222222-2222-4222-8222-222222222222"
        prompt = BOUNDARY_PROMPT + "中文 Emoji 🚀 café\n"
        completed, body = self.invoke(
            "args",
            schema=None,
            prompt=prompt,
            timeout=60,
            extra=["--model", "gemini-test", "--effort", "high", "--conversation", conversation],
            env_overrides={"LC_ALL": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"},
        )
        self.assertEqual(completed.returncode, 0)
        echoed = json.loads(body["response"])
        self.assertIn("中文 Emoji 🚀 café", echoed["payload"])
        argv = echoed["argv"]
        self.assertEqual(argv[argv.index("--model") + 1], "gemini-test")
        self.assertEqual(argv[argv.index("--effort") + 1], "high")
        self.assertEqual(argv[argv.index("--conversation") + 1], conversation)
        self.assertEqual(argv[argv.index("--print-timeout") + 1], "50s")
        self.assertTrue(body["cumulative_usage"])

    def test_schema_resolution_and_boundary(self) -> None:
        completed, body = self.invoke("success", schema="references/review.schema.json")
        self.assertEqual(completed.returncode, 0)
        self.assertTrue(body["ok"])

        outside_schema = self.scratch / "outside.schema.json"
        outside_schema.write_text('{"type":"object"}\n', encoding="utf-8")
        completed, body = self.invoke("success", schema=outside_schema)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(body["error_kind"], "INPUT_ERROR")
        self.assertIn("inside", body["error"])

    def test_state_save_and_exact_resume(self) -> None:
        state_file = self.state_root / "agy-skill" / "workspace-consult.json"
        first, body = self.invoke("success", schema=None, extra=["--save-state", str(state_file)])
        self.assertEqual(first.returncode, 0)
        self.assertTrue(state_file.is_file())
        self.assertEqual(json.loads(state_file.read_text())["conversation_id"], body["conversation_id"])

        second, body = self.invoke("success", schema=None, extra=["--resume-state", str(state_file)])
        self.assertEqual(second.returncode, 0)
        self.assertTrue(body["cumulative_usage"])
        self.assertEqual(body["usage"]["total_tokens"], 99)

    def test_state_isolated_by_host_session(self) -> None:
        one, _ = self.invoke("success", schema=None, extra=["--session-key", "chat-one"])
        two, _ = self.invoke("success", schema=None, extra=["--session-key", "chat-two"])
        self.assertEqual((one.returncode, two.returncode), (0, 0))
        self.assertGreaterEqual(len(list((self.state_root / "agy-skill").glob("*-consult.json"))), 2)
        for key in ("chat-one", "chat-two"):
            run, body = self.invoke("success", schema=None, extra=["--session-key", key, "--resume-session"])
            self.assertEqual(run.returncode, 0, body.get("error"))
            self.assertTrue(body["cumulative_usage"])
        run, body = self.invoke("success", schema=None, extra=["--session-key", "chat-three", "--resume-session"])
        self.assertEqual(run.returncode, 2)
        self.assertEqual(body["error_kind"], "INPUT_ERROR")

    def test_explicit_read_path_and_parameter_schema(self) -> None:
        fixture = self.workspace / "data.txt"
        fixture.write_text("synthetic", encoding="utf-8")
        env = {"READ_FIXTURE": str(fixture)}
        run, body = self.invoke("read_path", env_overrides=env)
        self.assertEqual(run.returncode, 4)
        self.assertIn("allowlist", body["error"])
        run, body = self.invoke("read_path", extra=["--allow-read", "data.txt"], env_overrides=env)
        self.assertEqual(run.returncode, 0, body.get("error"))
        run, body = self.invoke("read_unknown_parameter", extra=["--allow-read", "data.txt"], env_overrides=env)
        self.assertEqual(run.returncode, 4)
        self.assertIn("parameters", body["error"])

    def test_runtime_identity_and_false_success(self) -> None:
        for scenario, expected in (("observed_model", "gemini-test-observed"), ("conflicting_model", None)):
            run, body = self.invoke(scenario, extra=["--model", "gemini-test-requested"])
            self.assertEqual(run.returncode, 0)
            self.assertEqual(body["requested_model"], "gemini-test-requested")
            self.assertEqual(body["observed_model"], expected)
            self.assertEqual(body["model_identity_source"], "init.model" if expected else None)
        run, body = self.invoke("false_success")
        self.assertEqual((run.returncode, body["cli_exit_code"]), (3, 9))
        self.assertFalse(body["ok"])
        self.assertEqual(body["status"], "SUCCESS")

    def test_summary_uses_verified_workspace_and_real_hook_program(self) -> None:
        launch_marker = self.scratch / "agy-launch-marker"
        env = {"MOCK_LAUNCH_MARKER": str(launch_marker)}
        run, body = self.invoke("success", extra=["--summary-only"], env_overrides=env)
        self.assertEqual(run.returncode, 2)
        self.assertEqual(body["error_kind"], "SAFETY_NOT_VERIFIED")
        self.assertFalse(launch_marker.exists())
        prepared, body = self.invoke("success", extra=["--prepare-summary-canary"], env_overrides=env)
        self.assertEqual(prepared.returncode, 0, body.get("error"))
        self.assertFalse(launch_marker.exists())
        canary = body["canary"]
        attestation = self.scratch / "test-attestation.json"
        self.run_canary(canary, "canary")
        run, body = self.invoke("success", extra=[
            "--verify-summary-canary", canary["cwd"], "--safety-attestation", str(attestation),
        ])
        self.assertEqual(run.returncode, 0, body.get("error"))
        run, body = self.invoke("success", extra=["--check-summary", "--safety-attestation", str(attestation)])
        self.assertEqual(run.returncode, 0, body.get("error"))
        self.assertEqual(body["status"], "READY")
        env_dump = self.scratch / "summary-env-dump.json"
        run, body = self.invoke(
            "success",
            extra=["--summary-only", "--safety-attestation", str(attestation)],
            env_overrides={"MOCK_ENV_DUMP": str(env_dump)},
        )
        self.assertEqual(run.returncode, 0, body.get("error"))
        self.assertEqual(body["permission_mode"], "strict")
        summary_info = json.loads(env_dump.read_text(encoding="utf-8"))
        self.assertEqual(summary_info["cmux_disabled"], "1")
        # 正常结束且无策略违规时，summary-only 受控临时目录应已被安全清理
        self.assertFalse(Path(summary_info["cwd"]).exists())

        violation_dump = self.scratch / "summary-violation-dump.json"
        run, body = self.invoke(
            "summary_tool",
            extra=["--summary-only", "--safety-attestation", str(attestation)],
            env_overrides={"MOCK_ENV_DUMP": str(violation_dump)},
        )
        self.assertEqual(run.returncode, 4)
        self.assertEqual(body["error_kind"], "POLICY_VIOLATION")
        violation_cwd = Path(json.loads(violation_dump.read_text(encoding="utf-8"))["cwd"])
        self.assertTrue((violation_cwd / ".agents" / "deny.ndjson").is_file())

    def run_canary(self, canary: dict, scenario: str) -> None:
        with Path(canary["stdout_file"]).open("xb") as out:
            subprocess.run(
                canary["argv"], cwd=canary["cwd"],
                input=Path(canary["stdin_file"]).read_bytes(), stdout=out, stderr=subprocess.PIPE,
                check=True, env={**os.environ, "MOCK_SCENARIO": scenario},
            )

    def test_canary_requires_correlated_pre_execution_denials(self) -> None:
        scenarios = (
            "canary_partial", "canary_missing_frames", "canary_wrong_conversation", "canary_wrong_tool",
            "canary_completed", "canary_produced_output", "canary_other_error", "canary_started_child",
            "canary_unmatched_child", "canary_old_aliases", "canary_v156", "canary_v156_child_id",
            "canary_v156_status", "canary_v156_long_prompt", "canary_v156_output",
            "canary_v156_child_in_error", "canary_v156_completed",
        )
        for scenario in scenarios:
            with self.subTest(scenario=scenario):
                run, body = self.invoke("success", extra=["--prepare-summary-canary"])
                self.assertEqual(run.returncode, 0, body.get("error"))
                canary = body["canary"]
                attestation = Path(canary["cwd"]) / "attestation.json"
                self.run_canary(canary, scenario)
                run, body = self.invoke("success", extra=[
                    "--verify-summary-canary", canary["cwd"], "--safety-attestation", str(attestation),
                ])
                accepted = scenario in {"canary_old_aliases", "canary_v156"}
                self.assertEqual(run.returncode, 0 if accepted else 2, body.get("error"))
                self.assertEqual(attestation.exists(), accepted)
                if not accepted:
                    self.assertEqual(body["error_kind"], "SAFETY_NOT_VERIFIED")

    def test_nonzero_exit_preserves_real_stderr_and_stdout_with_redaction(self) -> None:
        completed, body = self.invoke("cli_crash_stderr")
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(body["error_kind"], "CLI_ERROR")
        stderr_text = Path(body["raw_stderr_path"]).read_text(encoding="utf-8")
        self.assertIn("flag provided but not defined: -bad-flag", stderr_text)
        self.assertIn("fatal: dial tcp 127.0.0.1:443: connection refused", stderr_text)
        self.assertNotIn("AGY API error or CLI failure", stderr_text)
        self.assertNotIn("secret-tok-999", stderr_text)
        self.assertIn("Bearer [REDACTED]", stderr_text)
        stdout_text = Path(body["raw_stdout_path"]).read_text(encoding="utf-8")
        self.assertIn("transport closed unexpectedly", stdout_text)

        # 子进程未产生任何 stderr 时，仍写入标准兜底错误说明
        completed_empty_err, quota_body = self.invoke("quota")
        self.assertEqual(completed_empty_err.returncode, 3)
        self.assertIn("AGY API error or CLI failure", Path(quota_body["raw_stderr_path"]).read_text(encoding="utf-8"))

    def test_cli_log_runtime_identity_and_cleanup(self) -> None:
        for scenario, expected in (
            ("cli_log_model", "Gemini 4 Carbon (High)"),
            ("cli_log_resolver", "gemini-3.1-pro-low"),
        ):
            with self.subTest(scenario=scenario):
                completed, body = self.invoke(scenario)
                self.assertEqual(completed.returncode, 0, body.get("error"))
                self.assertTrue(body["ok"])
                self.assertEqual(body["observed_model"], expected)
                self.assertEqual(body["model_identity_source"], "runtime.cli_log")
        self.assertEqual(list(self.scratch.glob("agy-cli-log-*")), [])

    def test_cmux_path_avoidance_and_preferred_home_binary(self) -> None:
        import importlib.util
        from unittest.mock import patch

        spec = importlib.util.spec_from_file_location("agy_runner_mod", RUNNER)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        fake_home = self.scratch / "fake-home"
        cmux_bin_dir = self.scratch / "Applications" / "cmux.app" / "Contents" / "Resources" / "bin"
        real_bin_dir = self.scratch / "usr-bin"
        cmux_bin_dir.mkdir(parents=True, exist_ok=True)
        real_bin_dir.mkdir(parents=True, exist_ok=True)

        cmux_agy = cmux_bin_dir / "agy"
        cmux_agy.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        cmux_agy.chmod(0o755)
        real_agy = real_bin_dir / "agy"
        real_agy.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        real_agy.chmod(0o755)

        fake_path = f"{cmux_bin_dir}{os.pathsep}{real_bin_dir}"
        with patch.object(mod.Path, "home", return_value=fake_home), patch.dict(os.environ, {"PATH": fake_path}):
            # 无 ~/.local/bin/agy 时，PATH 查找跳过 cmux.app wrapper 选中后续真实入口
            self.assertEqual(mod.resolve_binary("agy"), str(real_agy.resolve()))

            # 存在 ~/.local/bin/agy 时，优先选中受管本地入口
            local_bin = fake_home / ".local" / "bin"
            local_bin.mkdir(parents=True, exist_ok=True)
            home_agy = local_bin / "agy"
            home_agy.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            home_agy.chmod(0o755)
            self.assertEqual(mod.resolve_binary("agy"), str(home_agy.resolve()))

    @classmethod
    def tearDownClass(cls) -> None:
        print(f"Offline test artifacts retained at: {cls.scratch}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
