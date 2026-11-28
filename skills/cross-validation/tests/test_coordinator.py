from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import cross_validate as cv


MODEL = {"agy": "gemini-3-pro", "mmx": "MiniMax-M3.1-Flash"}
FAMILY = {"agy": "gemini", "mmx": "minimax"}
FINDING = {
    "kind": "advisory", "severity": "P2", "title": "Clarify the transition",
    "evidence_refs": ["E1"], "condition": "If the transition is concurrent",
    "impact": "The operator can misread its status", "recommendation": "Add a state label",
}
BODY = {"version": 1, "summary": "Review complete", "findings": [FINDING]}


class CoordinatorTest(unittest.TestCase):
    def setUp(self):
        # Keep the isolated fixture for inspection. No recursive cleanup.
        self.root = Path(tempfile.mkdtemp(prefix="cross-validation-test-"))
        self.workspace = self.root / "work"
        self.workspace.mkdir()
        self.material = self.workspace / "design.md"
        self.material.write_text("private design bytes", encoding="utf-8")
        self.state = self.root / "state"
        self.request_path = self.root / "request.json"
        self.calls = []
        self.call_lock = threading.Lock()
        self.request = {
            "workspace": str(self.workspace), "stage": "design", "scope": "static",
            "materials": ["design.md"], "materials_complete": True,
            "round_id": "turn-1", "thread_id": "chat-1", "policy_version": "rules-1",
            "host_model": "gpt-6.1-sol", "models": dict(MODEL),
            "external_summary_approved": True,
            "packet": {
                "constraints": ["Do not change published rules"],
                "facts": [{"id": "E1", "text": "A peer check is required"}],
                "assumptions": [], "uncovered": [],
            },
        }
        self.specs = {
            name: {"model": model, "profile": name + "-profile", "release": "fake-release",
                   "cli_version": "synthetic", "timeout": 5}
            for name, model in MODEL.items()
        }

    def load(self, **changes):
        self.request_path.write_text(json.dumps({**self.request, **changes}), encoding="utf-8")
        return cv.load_request(self.request_path)

    def fake(self, name, spec, prompt, directory, evidence_ids):
        with self.call_lock:
            self.calls.append(name)
        self.assertNotIn(str(self.workspace), prompt)
        self.assertNotIn("design.md", prompt)
        self.assertNotIn("private design bytes", prompt)
        self.assertEqual(evidence_ids, {"E1"})
        return {
            "family": FAMILY[name], "observed_model": MODEL[name], "valid": True,
            "complete": True, "gate": "PASS", "review": BODY, "call_attempted": True,
            "cli_invoked": True, "duration_seconds": 0.1, "usage": cv.usage_values({}),
        }

    def execute(self, loaded=None, *, runner=None, guard=None, specs=None):
        return cv.run_review(
            *(loaded or self.load()), self.state, specs or self.specs,
            runner=runner or self.fake, guard=guard or (lambda _: True),
        )

    def test_dry_run_creates_no_state_and_never_dispatches(self):
        self.load()
        args = cv.parse_args(["--state-dir", str(self.state), "run", "--request-file",
                              str(self.request_path), "--dry-run"])
        with patch.object(cv, "preflight", side_effect=AssertionError("unexpected preflight")):
            result = cv.command(args)
        self.assertEqual(result["status"], "dry_run")
        self.assertFalse(self.state.exists())
        self.assertNotIn(str(self.workspace), json.dumps(result))

    def test_sensitive_packet_and_outside_manifest_are_rejected(self):
        packet = {**self.request["packet"], "constraints": ["Authorization: Bearer synthetic_secret"]}
        with self.assertRaises(ValueError):
            self.load(packet=packet)
        (self.workspace / "escape").symlink_to(self.root / "request.json")
        with self.assertRaises(ValueError):
            self.load(materials=["escape"])

    def test_static_matching_fingerprints_reuse_and_changed_inputs_fork(self):
        first = self.execute()
        self.assertEqual(first["cross_validation"], "COMPLETED")
        reused = self.execute(self.load(round_id="turn-2", thread_id="chat-2"))
        self.assertEqual(reused["run_id"], first["run_id"])
        self.assertTrue(reused["reused"])
        rules_changed = self.execute(self.load(round_id="turn-3", policy_version="rules-2"))
        self.assertNotEqual(rules_changed["run_id"], first["run_id"])
        self.material.write_text("changed design", encoding="utf-8")
        changed = self.execute(self.load(round_id="turn-4"))
        self.assertNotEqual(changed["run_id"], first["run_id"])
        self.assertEqual(len(self.calls), 6)

    def test_completed_cache_expires(self):
        first = self.execute()
        with closing(cv.connect(self.state, create=True)) as db, db:
            db.execute("UPDATE runs SET finished=? WHERE id=?", (cv.time.time() - cv.CACHE_AGE - 5, first["run_id"]))
        second = self.execute(self.load(round_id="turn-2"))
        self.assertNotEqual(first["run_id"], second["run_id"])

    def test_dynamic_scope_uses_fresh_round_but_never_replays_same_round(self):
        first = self.execute(self.load(scope="deploy"))
        same_round = self.execute(self.load(scope="deploy"))
        self.assertEqual(first["run_id"], same_round["run_id"])
        fresh = self.execute(self.load(scope="deploy", round_id="turn-2"))
        self.assertNotEqual(first["run_id"], fresh["run_id"])
        changed_same_round = self.execute(self.load(scope="destructive"))
        self.assertEqual(changed_same_round["reason"], "ROUND_ALREADY_USED")
        self.assertEqual(len(self.calls), 4)

    def test_concurrent_chats_join_one_provider_pair(self):
        first_input = self.load()
        other_input = self.load(round_id="turn-2", thread_id="chat-2")
        started, release = threading.Event(), threading.Event()

        def delayed(*args):
            started.set()
            self.assertTrue(release.wait(5))
            return self.fake(*args)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.execute, first_input, runner=delayed)
            try:
                self.assertTrue(started.wait(5))
                joined = self.execute(other_input)
                self.assertEqual(joined["status"], "in_flight")
                self.assertTrue(joined["joined"])
            finally:
                release.set()
            done = first.result(timeout=5)
        self.assertEqual(done["run_id"], joined["run_id"])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.execute(other_input)["run_id"], done["run_id"])

    def test_dead_owner_is_not_replayed(self):
        with closing(cv.connect(self.state, create=True)) as db:
            owned, first = cv.claim(db, "digest", "turn-1", reuse=True)
            self.assertTrue(owned)
            with patch.object(cv, "owner_alive", return_value=False):
                owned, unknown = cv.claim(db, "digest", "turn-2", reuse=True)
            self.assertFalse(owned)
            self.assertEqual(unknown["run_id"], first["run_id"])
            self.assertEqual(unknown["status"], "unknown")
            owned, unknown = cv.claim(db, "digest", "turn-3", reuse=True)
            self.assertFalse(owned)
            self.assertEqual(unknown["reason"], "OWNER_EXITED")

    def test_material_changes_during_dispatch_are_stale(self):
        def change(name, *args):
            if name == "agy":
                self.material.write_text("new material", encoding="utf-8")
            return self.fake(name, *args)

        result = self.execute(runner=change)
        self.assertEqual(result["coverage"], "stale")
        self.assertEqual(result["cross_validation"], "NOT_EVALUATED")
        self.assertEqual(result["review_gate"], "NOT_EVALUATED")

    def test_missing_material_completeness_never_produces_pass(self):
        result = self.execute(self.load(materials_complete=False))
        self.assertEqual(result["coverage"], "partial")
        self.assertEqual(result["review_gate"], "NOT_EVALUATED")

    def test_model_independence_and_fallback_limit_reuse(self):
        def fallback(name, *args):
            result = self.fake(name, *args)
            if name == "mmx":
                result["observed_model"] = "MiniMax-M2.7"
            return result

        one = self.execute(runner=fallback)
        self.assertEqual(one["independence"], "INDEPENDENT")
        another = self.execute(self.load(round_id="turn-2"), runner=fallback)
        self.assertNotEqual(one["run_id"], another["run_id"])
        same = self.execute(self.load(round_id="turn-3", host_model="gemini-3-pro"))
        self.assertEqual(same["independence"], "SAME_FAMILY")
        self.assertEqual(same["review_gate"], "NOT_EVALUATED")
        unknown = self.execute(self.load(round_id="turn-4", host_model=None))
        self.assertEqual(unknown["independence"], "UNKNOWN")
        self.assertEqual(unknown["review_gate"], "NOT_EVALUATED")

    def test_provider_block_is_local_to_profile_and_explicitly_cleared(self):
        def quota(name, *args):
            result = self.fake(name, *args)
            if name == "mmx":
                result.update(valid=False, complete=False, gate="NOT_EVALUATED", reason="QUOTA")
            return result

        first = self.execute(runner=quota)
        self.assertEqual(first["cross_validation"], "NOT_EVALUATED")
        stopped = self.execute(self.load(round_id="turn-2"))
        self.assertEqual(stopped["reason"], "PROVIDER_BLOCKED")
        self.assertEqual(len(self.calls), 2)
        args = cv.parse_args(["--state-dir", str(self.state), "clear-block", "--provider",
                              "mmx", "--profile", "mmx-profile", "--reason", "quota recovered"])
        self.assertEqual(cv.command(args)["status"], "cleared")
        fresh = self.execute(self.load(round_id="turn-3"))
        self.assertEqual(fresh["cross_validation"], "COMPLETED")
        self.assertEqual(len(self.calls), 4)

    def test_install_drift_blocks_before_start_and_invalidates_after(self):
        with self.assertRaises(cv.NotReady):
            self.execute(guard=lambda _: False)
        self.assertFalse(self.state.exists())
        result = self.execute(guard=lambda _: len(self.calls) < 2)
        self.assertEqual(result["coverage"], "stale")
        self.assertEqual(result["review_gate"], "NOT_EVALUATED")

    def test_unverified_safety_stops_before_mmx_probe(self):
        with patch.object(cv, "verify_install", return_value="release"), patch.object(
            cv, "local_probe", return_value=(2, '{"error_kind":"SAFETY_NOT_VERIFIED"}'),
        ) as probe:
            with self.assertRaises(cv.NotReady) as error:
                cv.preflight(self.root / "not-verified.json", dict(MODEL))
        self.assertEqual(error.exception.reason, "SAFETY_NOT_VERIFIED")
        self.assertEqual(probe.call_count, 1)
        self.assertIn("--check-summary", probe.call_args.args[0])

    def test_mmx_preflight_includes_local_queue_time_without_rotating_provider_blocks(self):
        fake_mmx = self.root / "mmx"
        fake_mmx.write_text("fixture only", encoding="utf-8")
        profile = {"format": 1, "model": None, "max_tokens": 65536,
                   "request_timeout_seconds": 40, "wrapper_timeout_seconds": 50}
        attestation = self.root / "fixture-attestation.json"
        release = "fixture-release"
        probe_response = (0, '{"ok":true,"safety_fingerprint":"fixture","cli_version":"fixture"}')
        with patch.object(cv, "verify_install", return_value=release), patch.object(
            cv.shutil, "which", side_effect=lambda name: str(fake_mmx) if name == "mmx" else "node",
        ), patch.object(cv, "local_probe", side_effect=[probe_response, (0, "mmx 1.0.29")] * 2), patch.object(
            cv, "read_json", return_value=profile,
        ), patch.dict(cv.os.environ, {}, clear=True):
            default = cv.preflight(attestation, MODEL)
            cv.os.environ["MMX_CHAT_QUEUE_TIMEOUT"] = "12"
            overridden = cv.preflight(attestation, MODEL)
        self.assertEqual(default["mmx"]["timeout"], 1260 + 50 + 20)
        self.assertEqual(overridden["mmx"]["timeout"], 12 + 50 + 20)
        self.assertEqual(default["mmx"]["profile"], overridden["mmx"]["profile"])
        self.assertEqual(default["agy"]["timeout"], overridden["agy"]["timeout"])

    def test_mmx_local_rejections_do_not_create_provider_blocks(self):
        for index, (status, reason) in enumerate((
            ("usage_error", "LOCAL_USAGE_ERROR"),
            ("queue_timeout", "LOCAL_QUEUE_TIMEOUT"),
            ("local_slot_error", "LOCAL_SLOT_ERROR"),
        )):
            envelope = {"status": status, "reason": "budget_below_profile", "cli_invoked": False,
                        "queue_wait_ms": 123, "max_concurrency": 2, "code": 429}
            fixture = [sys.executable, "-c", f"print({json.dumps(envelope)!r}); raise SystemExit(1)"]
            specs = {**self.specs, "mmx": {**self.specs["mmx"], "command": fixture}}

            def runner(provider, spec, prompt, directory, evidence_ids):
                if provider == "mmx":
                    return cv.invoke(provider, spec, prompt, directory, evidence_ids)
                return self.fake(provider, spec, prompt, directory, evidence_ids)

            receipt = self.execute(self.load(round_id=f"local-{index}"), runner=runner, specs=specs)
            mmx = receipt["providers"]["mmx"]
            self.assertEqual(mmx["reason"], reason)
            self.assertEqual(mmx["gate"], "NOT_EVALUATED")
            self.assertFalse(mmx["cli_invoked"])
            self.assertEqual(mmx["queue_wait_ms"], 123)
            self.assertEqual(mmx["max_concurrency"], 2)
            with closing(cv.connect(self.state)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM blocks").fetchone()[0], 0)
        self.assertEqual(self.execute(self.load(round_id="recovered"))["cross_validation"], "COMPLETED")

    def test_release_lock_prevents_calling_during_install(self):
        skill = self.root / "cross-validation"
        lock = self.root / ".gstack-cross-validation-install.lock"
        with cv.open_private(lock):
            pass
        with lock.open() as stream, patch.object(cv, "SKILL", skill):
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(cv.NotReady) as error, cv.installed_read_lock():
                self.fail("lock allowed concurrent install")
            self.assertEqual(error.exception.reason, "INSTALL_IN_PROGRESS")

    def test_stats_count_adopted_findings_and_preserve_unknown_usage(self):
        receipt = self.execute()
        args = cv.parse_args([
            "--state-dir", str(self.state), "record-disposition", receipt["run_id"],
            "--provider", "agy", "--finding", "1", "--outcome", "adopted", "--reason", "verified locally",
        ])
        self.assertEqual(cv.command(args)["status"], "recorded")
        with closing(cv.connect(self.state)) as db:
            summary = cv.stats(db)
            stored = cv.show(db, receipt["run_id"])
        self.assertEqual(summary["adopted_findings"], 1)
        self.assertEqual(summary["providers"]["agy"]["cli_invoked"], 1)
        self.assertIsNone(summary["providers"]["agy"]["usage"]["input_tokens"])
        self.assertEqual(stored["dispositions"][0]["reason"], "verified locally")
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.state / "reviews.sqlite3").stat().st_mode & 0o777, 0o600)

    def test_provider_output_is_archived_verbatim_and_private(self):
        result = {
            "status": "ok", "exit_code": 0, "cli_invoked": True, "truncated": False,
            "stop_reason": "end_turn", "model": MODEL["mmx"], "model_identity_source": "response.model",
            "text": json.dumps(BODY, indent=2),
        }
        script = self.root / "stub_mmx.py"
        script.write_text(
            "import pathlib,sys\nassert pathlib.Path(sys.argv[-1]).read_text() == 'review packet'\n"
            f"print({json.dumps(result)!r})\n", encoding="utf-8",
        )
        spec = {**self.specs["mmx"], "command": [sys.executable, str(script)]}
        receipt = cv.invoke("mmx", spec, "review packet", self.root, {"E1"})
        self.assertEqual(receipt["gate"], "PASS")
        output = Path(receipt["raw_response"])
        self.assertEqual(output.read_text(encoding="utf-8"), result["text"])
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / "mmx-prompt.txt").exists())

    def test_protocol_failure_and_nonzero_child_cannot_be_valid(self):
        payload = {"status": "ok", "model": MODEL["mmx"], "text": json.dumps(BODY)}
        for code in (0, 2):
            directory = self.root / f"bad-{code}"
            directory.mkdir(mode=0o700)
            command = [sys.executable, "-c", f"print({json.dumps(payload)!r}); raise SystemExit({code})"]
            receipt = cv.invoke("mmx", {**self.specs["mmx"], "command": command}, "review", directory, {"E1"})
            self.assertFalse(receipt["valid"])
            self.assertEqual(receipt["gate"], "NOT_EVALUATED")
            self.assertEqual(receipt["exit_code"], code)

    def test_file_digest_falls_back_without_hashlib_file_digest(self):
        # 模拟 Python 3.9 无 hashlib.file_digest 的运行环境
        compat_hashlib = types.SimpleNamespace(sha256=cv.hashlib.sha256)
        self.assertFalse(hasattr(compat_hashlib, "file_digest"))
        expected = cv.hashlib.sha256(self.material.read_bytes()).hexdigest()
        with patch.object(cv, "hashlib", compat_hashlib):
            self.assertEqual(cv.file_digest(self.material), expected)

    def test_agy_cli_log_runtime_identity_completes_cross_validation_end_to_end(self):
        # 端到端验证 agy_runner.py 从 --log-file 提取 Gemini 4 Carbon (High) 并被协调器识别为 gemini 家族达成 COMPLETED
        agy_runner = Path(__file__).resolve().parents[2] / "agy" / "scripts" / "agy_runner.py"
        fake_agy = self.root / "fake-agy-1510"
        fake_agy.write_text(
            "#!/usr/bin/env python3\n"
            "import json, pathlib, sys\n"
            "if '--version' in sys.argv:\n"
            "    print('1.5.10')\n"
            "    raise SystemExit(0)\n"
            "payload = sys.stdin.read()\n"
            "log_path = pathlib.Path(sys.argv[sys.argv.index('--log-file') + 1])\n"
            "log_path.write_text(\n"
            "    'I1117 17:00:01.000001 100 llm_monitor.go:42] tier=MODEL_TIER_FLASH_LITE\\n'\n"
            "    'I1117 17:00:01.000002 100 model_config_manager.go:218] '\n"
            "    'Propagating selected model override to backend: label=\"Gemini 4 Carbon (High)\"\\n'\n"
            "    'I1117 17:00:01.000003 100 llm_monitor.go:55] background check MODEL_TIER_FLASH_LITE\\n',\n"
            "    encoding='utf-8',\n"
            ")\n"
            "conv = '11111111-1111-4111-8111-111111111111'\n"
            f"body = json.loads({json.dumps(BODY)!r})\n"
            "print(json.dumps({'event': 'init', 'conversation_id': conv, 'init': {'permission_mode': 'strict'}}))\n"
            "print(json.dumps({'event': 'result', 'result': {\n"
            "    'conversation_id': conv, 'status': 'SUCCESS', 'response': json.dumps(body),\n"
            "    'structured_output': body, 'usage': {'input_tokens': 12, 'output_tokens': 6}\n"
            "}}))\n",
            encoding="utf-8",
        )
        fake_agy.chmod(0o755)
        fake_mmx = self.root / "fake-mmx.py"
        mmx_envelope = {
            "status": "ok", "exit_code": 0, "cli_invoked": True, "truncated": False,
            "stop_reason": "end_turn", "model": MODEL["mmx"],
            "model_identity_source": "response.model", "text": json.dumps(BODY),
        }
        fake_mmx.write_text(f"import json; print({json.dumps(mmx_envelope)!r})\n", encoding="utf-8")

        specs = {
            "agy": {
                "command": [
                    sys.executable, "-B", str(agy_runner),
                    "--agy-bin", str(fake_agy),
                    "--schema", "review-v1.schema.json",
                    "--cwd", str(self.workspace),
                ],
                "model": None,
                "release": "fake-release",
                "timeout": 20,
                "profile": "agy-profile",
                "cli_version": "1.5.10",
            },
            "mmx": {
                "command": [sys.executable, "-B", str(fake_mmx)],
                "model": MODEL["mmx"],
                "release": "fake-release",
                "timeout": 20,
                "profile": "mmx-profile",
                "cli_version": "2.4.0",
            },
        }
        loaded = self.load(models={"agy": None, "mmx": MODEL["mmx"]})
        receipt = cv.run_review(*loaded, self.state, specs, runner=cv.invoke, guard=lambda _: True)
        self.assertEqual(receipt["providers"]["agy"]["observed_model"], "Gemini 4 Carbon (High)")
        self.assertEqual(receipt["providers"]["agy"]["identity_source"], "runtime.cli_log")
        self.assertEqual(receipt["providers"]["agy"]["family"], "gemini")
        self.assertEqual(receipt["independence"], "INDEPENDENT")
        self.assertEqual(receipt["cross_validation"], "COMPLETED")
        self.assertEqual(receipt["review_gate"], "PASS")
        run_dir = self.state / "runs" / receipt["run_id"]
        self.assertEqual(list(run_dir.glob("agy-cli-log-*")), [])


if __name__ == "__main__":
    unittest.main()
