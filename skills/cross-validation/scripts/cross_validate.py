#!/usr/bin/env python3
"""Coordinate one AGY/MMX summary review per round and keep local receipts."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from install_guard import verify_install
from review_protocol import build_prompt, model_family, parse_review, strict_json


SKILL = Path(__file__).resolve().parents[1]
STATE = Path("/Volumes/WorkSSD/Archives/gstack-cross-validation")
PROVIDERS = ("agy", "mmx")
CACHE_AGE = 86400
FORMAT = 1
MMX_DEFAULT_QUEUE_TIMEOUT = 1260
MMX_MAX_QUEUE_TIMEOUT = 86400
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SAFE_MODEL_LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._()+:-]{0,127}")
SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    owner INTEGER NOT NULL,
    started REAL NOT NULL,
    finished REAL,
    cacheable INTEGER NOT NULL DEFAULT 0,
    receipt TEXT
);
CREATE INDEX IF NOT EXISTS runs_fingerprint ON runs(fingerprint, started);
CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    reused INTEGER NOT NULL DEFAULT 0,
    joined INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blocks (
    provider TEXT NOT NULL,
    profile TEXT NOT NULL,
    reason TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created REAL NOT NULL,
    cleared REAL,
    clear_reason TEXT,
    PRIMARY KEY (provider, profile)
);
CREATE TABLE IF NOT EXISTS dispositions (
    run_id TEXT NOT NULL REFERENCES runs(id),
    provider TEXT NOT NULL,
    finding INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL,
    updated REAL NOT NULL,
    PRIMARY KEY (run_id, provider, finding)
);
"""


class NotReady(ValueError):
    def __init__(self, reason, provider=None):
        self.reason = reason
        self.provider = provider
        super().__init__(reason)


def canonical(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(obj):
    return hashlib.sha256(canonical(obj).encode()).hexdigest()


def read_json(path, limit=128 * 1024):
    with Path(path).open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("JSON file exceeds its local size limit")
    return strict_json(data.decode("utf-8"))


def file_digest(path):
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("manifest contains a nonregular file")
        if hasattr(hashlib, "file_digest"):
            content = hashlib.file_digest(stream, "sha256").hexdigest()
        else:
            # 兼容无 hashlib.file_digest 的环境（如 macOS 系统自带 Python 3.9）
            hasher = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
            content = hasher.hexdigest()
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
        after.st_size, after.st_mtime_ns, after.st_ctime_ns
    ):
        raise ValueError("material changed while being fingerprinted")
    return content


def snapshot(workspace, materials):
    result = {}
    for name in materials:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("material paths must be relative to the workspace")
        path = (workspace / relative).resolve(strict=True)
        if not path.is_relative_to(workspace) or not path.is_file():
            raise ValueError("manifest contains a file outside the workspace")
        result[name] = [str(path.relative_to(workspace)), file_digest(path)]
    return result


def load_request(path):
    request = read_json(path)
    required = {"workspace", "stage", "scope", "packet", "round_id"}
    optional = {
        "materials", "materials_complete", "thread_id", "host_model",
        "models", "external_summary_approved", "policy_version",
    }
    if not isinstance(request, dict) or not required <= request.keys() or request.keys() - required - optional:
        raise ValueError("invalid request fields")
    if not isinstance(request["workspace"], str) or not Path(request["workspace"]).is_absolute():
        raise ValueError("workspace must be an absolute directory path")
    workspace = Path(request["workspace"]).resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("workspace is not a directory")
    if request["scope"] not in ("static", "live", "deploy", "destructive"):
        raise ValueError("invalid scope")
    if not isinstance(request["stage"], str) or not request["stage"].strip() or len(request["stage"]) > 128:
        raise ValueError("invalid stage")
    for name in ("round_id", "thread_id", "policy_version"):
        if name in request and (
            not isinstance(request[name], str) or not SAFE_ID.fullmatch(request[name])
        ):
            raise ValueError(f"invalid {name}")
    for name in ("materials_complete", "external_summary_approved"):
        if name in request and type(request[name]) is not bool:
            raise ValueError(f"{name} must be boolean")
    materials = request.setdefault("materials", [])
    if (
        not isinstance(materials, list) or len(materials) > 512
        or any(not isinstance(name, str) or not name or len(name) > 4096 for name in materials)
        or len(set(materials)) != len(materials)
    ):
        raise ValueError("invalid materials list")
    models = request.setdefault("models", {})
    if not isinstance(models, dict) or models.keys() - set(PROVIDERS):
        raise ValueError("invalid models map")
    for name in PROVIDERS:
        model = models.setdefault(name, None)
        if model is not None and (not isinstance(model, str) or not MODEL_ID.fullmatch(model)):
            raise ValueError("invalid requested model")
    host_model = request.get("host_model")
    if host_model is not None and (not isinstance(host_model, str) or not SAFE_MODEL_LABEL.fullmatch(host_model)):
        raise ValueError("invalid host model")
    # Build from the explicitly selected external packet only. Workspace, file
    # paths and their digests never enter either prompt.
    prompts = {name: build_prompt(request["packet"], agy=name == "agy") for name in PROVIDERS}
    if any(len(prompt.encode()) > 32768 for prompt in prompts.values()):
        raise ValueError("summary review prompt exceeds 32 KiB")
    return request, workspace, snapshot(workspace, materials), prompts


def private_directory(path, *, create=False):
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    mode = path.lstat()
    if not stat.S_ISDIR(mode.st_mode) or stat.S_IMODE(mode.st_mode) != 0o700 or mode.st_uid != os.getuid():
        raise ValueError("review directory must be owned by the current user and mode 0700")


def private_file(path):
    mode = path.lstat()
    if (
        not stat.S_ISREG(mode.st_mode) or stat.S_IMODE(mode.st_mode) != 0o600
        or mode.st_uid != os.getuid() or mode.st_nlink != 1
    ):
        raise ValueError("review file must be a private regular file with mode 0600")


def open_private(path):
    return os.fdopen(
        os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600),
        "w", encoding="utf-8",
    )


def connect(state, *, create=False):
    if create:
        private_directory(state, create=True)
    elif not state.exists() and not state.is_symlink():
        return None
    else:
        private_directory(state)
    path = state / "reviews.sqlite3"
    if create:
        try:
            with open_private(path):
                pass
        except FileExistsError:
            pass
    elif not path.exists() and not path.is_symlink():
        return None
    private_file(path)
    connection = sqlite3.connect(
        path.as_uri() + ("?mode=rw" if create else "?mode=ro"), uri=True, timeout=10,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    if create:
        connection.executescript(SCHEMA)
    return connection


def local_probe(argv):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None, ""
    return result.returncode, result.stdout.strip()


def mmx_runtime(profile):
    if (
        not isinstance(profile, dict)
        or set(profile) != {"format", "model", "max_tokens", "request_timeout_seconds", "wrapper_timeout_seconds"}
        or type(profile["format"]) is not int or profile["format"] != 1
    ):
        raise ValueError("invalid MMX profile")
    for key in ("max_tokens", "request_timeout_seconds", "wrapper_timeout_seconds"):
        if type(profile[key]) is not int or not 0 < profile[key] <= 2**53 - 1:
            raise ValueError("invalid MMX profile number")
    timeout = {}
    for kind in ("request", "wrapper"):
        setting = os.environ.get("MMX_CHAT_" + ("REQ" if kind == "request" else "WRAP") + "_TIMEOUT")
        if setting is not None and not re.fullmatch(r"[0-9]+", setting):
            raise ValueError("invalid MMX timeout override")
        timeout[kind] = int(setting) if setting is not None else profile[kind + "_timeout_seconds"]
    if not 0 < timeout["request"] < timeout["wrapper"] <= 2147483:
        raise ValueError("invalid MMX timeout ordering")
    queue = os.environ.get("MMX_CHAT_QUEUE_TIMEOUT", str(MMX_DEFAULT_QUEUE_TIMEOUT))
    if not re.fullmatch(r"[0-9]+", queue) or not 0 < int(queue) <= MMX_MAX_QUEUE_TIMEOUT:
        raise ValueError("invalid MMX queue timeout")
    timeout["queue"] = int(queue)
    return timeout


def preflight(attestation, models):
    """Resolve the managed release and run only local, non-model probes."""
    try:
        release_id = verify_install(SKILL, required=True)
    except (ValueError, OSError):
        raise NotReady("INSTALL_INVALID") from None
    agy_root, mmx_root = (SKILL.parent / name for name in PROVIDERS)
    agy_runner = agy_root / "scripts/agy_runner.py"
    mmx_runner = mmx_root / "scripts/mmx-chat.js"
    node = shutil.which("node")
    mmx_cli = shutil.which("mmx")
    if not node or not mmx_cli:
        raise NotReady("CLI_MISSING", "mmx")
    agy_base = [sys.executable, "-B", str(agy_runner)]
    code, output = local_probe([*agy_base, "--check-summary", "--safety-attestation", str(attestation)])
    try:
        agy = json.loads(output)
    except (TypeError, ValueError):
        agy = None
    if (
        code != 0 or not isinstance(agy, dict) or agy.get("ok") is not True
        or not agy.get("safety_fingerprint") or not agy.get("cli_version")
    ):
        raise NotReady("SAFETY_NOT_VERIFIED", "agy")
    mmx_code, mmx_version = local_probe([mmx_cli, "--version"])
    if mmx_code != 0 or not re.fullmatch(r"(?:mmx )?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", mmx_version):
        raise NotReady("CLI_VERSION_UNAVAILABLE", "mmx")
    try:
        mmx_profile = read_json(mmx_root / "profiles/local.json")
        mmx_timeouts = mmx_runtime(mmx_profile)
    except (OSError, TypeError, ValueError, KeyError):
        raise NotReady("PROFILE_INVALID", "mmx") from None
    resolved_models = {**models, "mmx": models["mmx"] or mmx_profile.get("model")}
    commands = {
        "agy": [*agy_base, "--summary-only", "--schema", "review-v1.schema.json",
                "--safety-attestation", str(attestation)],
        "mmx": [node, str(mmx_runner)],
    }
    for name, model in resolved_models.items():
        if model is not None:
            if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
                raise NotReady("PROFILE_INVALID", name)
            commands[name].extend(["--model", model])
    profiles = {
        "agy": {
            "cli_version": agy["cli_version"],
            "safety_fingerprint": agy["safety_fingerprint"],
        },
        "mmx": {
            "cli_version": mmx_version,
            "cli_digest": file_digest(Path(mmx_cli).resolve(strict=True)),
            "max_tokens": mmx_profile["max_tokens"],
            "timeouts": {kind: mmx_timeouts[kind] for kind in ("request", "wrapper")},
        },
    }
    return {
        name: {
            "command": commands[name],
            "model": resolved_models[name],
            "release": release_id,
            "timeout": 620 if name == "agy" else mmx_timeouts["queue"] + mmx_timeouts["wrapper"] + 20,
            "profile": digest([release_id, name, profiles[name], resolved_models[name]]),
            "cli_version": profiles[name]["cli_version"],
        }
        for name in PROVIDERS
    }


def new_receipt(run_id, fingerprint, **fields):
    return {
        "version": FORMAT,
        "run_id": run_id,
        "fingerprint": fingerprint,
        "cross_validation": "NOT_EVALUATED",
        "review_gate": "NOT_EVALUATED",
        **fields,
    }


def owner_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def row_receipt(db, row):
    if row["receipt"]:
        return json.loads(row["receipt"])
    if not owner_alive(row["owner"]):
        receipt = new_receipt(row["id"], row["fingerprint"], status="unknown", reason="OWNER_EXITED")
        db.execute(
            "UPDATE runs SET status='unknown',finished=?,receipt=? WHERE id=?",
            (time.time(), canonical(receipt), row["id"]),
        )
        return receipt
    return new_receipt(row["id"], row["fingerprint"], status="in_flight")


def claim(db, fingerprint, round_id, *, reuse):
    """Return (owned, receipt), committing the claim before any dispatch."""
    db.execute("BEGIN IMMEDIATE")
    with db:
        row = db.execute(
            """SELECT runs.*, rounds.reused, rounds.joined
               FROM rounds JOIN runs ON runs.id=rounds.run_id WHERE rounds.id=?""",
            (round_id,),
        ).fetchone()
        if row:
            if row["fingerprint"] != fingerprint:
                return False, new_receipt(
                    row["id"], fingerprint, status="blocked", reason="ROUND_ALREADY_USED",
                )
            return False, {
                **row_receipt(db, row), "reused": bool(row["reused"]), "joined": bool(row["joined"]),
            }
        now = time.time()
        row = db.execute(
            """SELECT * FROM runs WHERE fingerprint=? AND
               (status IN ('in_flight', 'unknown')
                OR (? AND status='finished' AND cacheable=1 AND finished BETWEEN ? AND ?))
               ORDER BY CASE status WHEN 'in_flight' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END,
               started DESC LIMIT 1""",
            (fingerprint, reuse, now - CACHE_AGE, now),
        ).fetchone()
        if row:
            cached = row["status"] == "finished"
            joined = row["status"] == "in_flight"
            db.execute("INSERT INTO rounds VALUES (?,?,?,?)", (round_id, row["id"], cached, joined))
            return False, {**row_receipt(db, row), "reused": cached, "joined": joined}
        run_id = uuid.uuid4().hex
        db.execute(
            "INSERT INTO runs (id,fingerprint,status,owner,started) VALUES (?,?,'in_flight',?,?)",
            (run_id, fingerprint, os.getpid(), now),
        )
        db.execute("INSERT INTO rounds (id,run_id) VALUES (?,?)", (round_id, run_id))
        return True, new_receipt(run_id, fingerprint, status="in_flight")


def failure_reason(provider, envelope):
    if provider == "agy":
        kind = envelope.get("error_kind")
        if not isinstance(kind, str):
            return "PROTOCOL"
        return {
            "AUTH_ERROR": "AUTH",
            "QUOTA_ERROR": "QUOTA",
            "PROTOCOL_ERROR": "PROTOCOL",
            "POLICY_VIOLATION": "POLICY_VIOLATION",
            "TIMEOUT": "TIMEOUT",
            "SAFETY_NOT_VERIFIED": "SAFETY_NOT_VERIFIED",
            "MODEL_ERROR": "MODEL_UNAVAILABLE",
        }.get(kind, "CALL_FAILED")
    status = envelope.get("status")
    if status == "queue_timeout":
        return "LOCAL_QUEUE_TIMEOUT"
    if status == "usage_error":
        return "LOCAL_USAGE_ERROR"
    if status == "local_slot_error":
        return "LOCAL_SLOT_ERROR"
    if status == "auth_error":
        return "AUTH"
    if status in ("quota_error", "rate_limit") or (
        status == "api_error" and envelope.get("code") == 429
    ):
        return "QUOTA"
    if status in ("schema_mismatch", "invalid_json", "empty_stdout", "unsupported_stop_reason"):
        return "PROTOCOL"
    if status == "timeout":
        return "TIMEOUT"
    return "CALL_FAILED"


def usage_values(envelope):
    usage = envelope.get("usage") if isinstance(envelope.get("usage"), dict) else envelope
    return {
        name: usage.get(name) if type(usage.get(name)) is int and usage[name] >= 0 else None
        for name in ("input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens")
    }


def invoke(provider, spec, prompt, directory, evidence_ids):
    started = time.monotonic()
    result = {
        "provider": provider, "requested_model": spec["model"], "observed_model": None,
        "identity_source": None, "family": None, "gate": "NOT_EVALUATED", "valid": False,
        "complete": False, "call_attempted": False, "cli_invoked": None,
        "exit_code": None, "cli_exit_code": None, "cli_version": spec["cli_version"],
        "usage": usage_values({}),
    }
    env = {**os.environ, "TMP_ROOT": str(directory), "TMPDIR": str(directory)}
    argv = list(spec["command"])
    prompt_file = None
    try:
        if provider == "mmx":
            with open_private(directory / "mmx-prompt.txt") as stream:
                prompt_file = directory / "mmx-prompt.txt"
                stream.write(prompt)
            argv.extend(["--prompt-file", str(prompt_file)])
        # Keep the wrapper envelope in a private transient spool. Durable
        # receipts keep only the model's body and selected normalized metadata.
        with tempfile.TemporaryFile(dir=directory, mode="w+b") as output:
            proc = subprocess.Popen(
                argv, cwd=directory, env=env,
                stdin=subprocess.PIPE if provider == "agy" else subprocess.DEVNULL,
                stdout=output, stderr=subprocess.DEVNULL,
            )
            result["call_attempted"] = True
            try:
                proc.communicate(prompt.encode() if provider == "agy" else None, timeout=spec["timeout"])
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                result["reason"] = "TIMEOUT"
                return result
            result["exit_code"] = proc.returncode
            output.seek(0)
            try:
                envelope = strict_json(output.read().decode("utf-8"))
            except (ValueError, UnicodeError):
                result["reason"] = "PROTOCOL"
                return result
    except OSError:
        result["reason"] = "EXECUTION_ERROR"
        return result
    finally:
        if prompt_file is not None:
            prompt_file.unlink(missing_ok=True)
        result["duration_seconds"] = round(time.monotonic() - started, 3)
    if not isinstance(envelope, dict):
        result["reason"] = "PROTOCOL"
        return result
    if type(envelope.get("cli_invoked")) is bool:
        result["cli_invoked"] = envelope["cli_invoked"]
    if provider == "mmx":
        for field in ("queue_wait_ms", "max_concurrency"):
            if type(envelope.get(field)) is int and envelope[field] >= 0:
                result[field] = envelope[field]
    cli_exit = envelope.get("cli_exit_code" if provider == "agy" else "exit_code")
    if type(cli_exit) is int:
        result["cli_exit_code"] = cli_exit
        if provider == "agy" and result["cli_invoked"] is None:
            result["cli_invoked"] = True
    model = envelope.get("observed_model" if provider == "agy" else "model")
    identity_source = envelope.get("model_identity_source")
    if isinstance(model, str) and SAFE_MODEL_LABEL.fullmatch(model) and identity_source in (
        "init.model", "result.model", "result.model_id", "response.model", "response.model_id",
        "init.model_id", "upstream.model", "init.modelName", "result.modelName", "runtime.cli_log",
    ):
        result.update(
            observed_model=model, identity_source=identity_source, family=model_family(model),
        )
    result["usage"] = usage_values(envelope)
    transport_ok = (
        envelope.get("ok") is True and envelope.get("status") == "SUCCESS"
        and not envelope.get("policy_violations")
        if provider == "agy" else envelope.get("status") == "ok"
    ) and result["exit_code"] == 0
    if not transport_ok:
        result["reason"] = failure_reason(provider, envelope)
        return result
    raw = envelope.get("response" if provider == "agy" else "text")
    if isinstance(raw, str) and raw.strip():
        path = directory / f"{provider}.txt"
        with open_private(path) as stream:
            stream.write(raw)
        result["raw_response"] = str(path)
    elif provider == "agy" and isinstance(envelope.get("raw_stdout_path"), str):
        # Some AGY terminal events carry only structured output. The original
        # private NDJSON remains the lossless artifact for those responses.
        path = Path(envelope["raw_stdout_path"])
        if path.is_absolute() and path.parent.resolve() == directory.resolve():
            try:
                private_file(path)
            except (OSError, ValueError):
                pass
            else:
                result["raw_response"] = str(path)
    if envelope.get("truncated") is True:
        result["reason"] = "TRUNCATED"
        return result
    try:
        review, gate = parse_review(envelope, evidence_ids)
    except ValueError:
        result["reason"] = "PROTOCOL"
        return result
    result.update(valid=True, complete=True, review=review, gate=gate)
    return result


def result_verdict(results, coverage, host_model):
    family = [model_family(host_model), *(results[name]["family"] for name in PROVIDERS)]
    if any(item is None for item in family):
        independence = "UNKNOWN"
    elif len(set(family)) == len(family):
        independence = "INDEPENDENT"
    else:
        independence = "SAME_FAMILY"
    complete = (
        coverage == "current" and independence == "INDEPENDENT"
        and all(result["valid"] and result["complete"] for result in results.values())
    )
    gates = {result["gate"] for result in results.values()}
    gate = "NOT_EVALUATED"
    if coverage != "stale" and "FAIL" in gates:
        gate = "FAIL"
    elif complete and gates == {"PASS"}:
        gate = "PASS"
    return independence, "COMPLETED" if complete else "NOT_EVALUATED", gate


def release_current(specs):
    try:
        return verify_install(SKILL, required=True) == specs["agy"]["release"]
    except (OSError, ValueError):
        return False


@contextmanager
def installed_read_lock():
    path = SKILL.parent / ".gstack-cross-validation-install.lock"
    try:
        private_file(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except (OSError, ValueError):
        raise NotReady("INSTALL_INVALID") from None
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            raise NotReady("INSTALL_IN_PROGRESS") from None
        yield
    finally:
        os.close(descriptor)


def run_review(request, workspace, baseline, prompts, state, specs, *, runner=invoke, guard=release_current):
    # Fingerprint the effective prompts and both provider profiles. A newer
    # installed release, runtime attestation or CLI version starts a new key.
    fingerprint = digest({
        "format": FORMAT,
        "workspace": str(workspace),
        "stage": request["stage"],
        "scope": request["scope"],
        "policy_version": request.get("policy_version"),
        "materials": baseline,
        "materials_complete": request.get("materials_complete", False),
        "host_model": request.get("host_model"),
        "prompts": prompts,
        "profiles": {name: specs[name]["profile"] for name in PROVIDERS},
    })
    reuse = bool(
        request["scope"] == "static" and request.get("materials_complete") and baseline
        and request.get("policy_version")
        and all(spec["model"] for spec in specs.values())
    )
    if not guard(specs):
        raise NotReady("INSTALL_INVALID")
    with closing(connect(state, create=True)) as db:
        owned, receipt = claim(db, fingerprint, request["round_id"], reuse=reuse)
        if not owned:
            return receipt
        run_id = receipt["run_id"]
        results = {}
        # Run the providers independently. Neither receives the other result.
        try:
            private_directory(state / "runs", create=True)
            directory = state / "runs" / run_id
            directory.mkdir(mode=0o700)
            private_directory(directory)
            blockers = {
                name: db.execute(
                    "SELECT reason,run_id FROM blocks WHERE provider=? AND profile=? AND cleared IS NULL",
                    (name, specs[name]["profile"]),
                ).fetchone()
                for name in PROVIDERS
            }
            if any(blockers.values()):
                receipt.update(status="blocked", reason="PROVIDER_BLOCKED", blockers={
                    name: dict(blocker) for name, blocker in blockers.items() if blocker is not None
                })
            elif not guard(specs):
                receipt.update(status="blocked", reason="INSTALL_INVALID")
            elif snapshot(workspace, request["materials"]) != baseline:
                receipt.update(status="blocked", reason="MATERIAL_CHANGED", coverage="stale")
            else:
                evidence_ids = {fact["id"] for fact in request["packet"]["facts"]}
                with ThreadPoolExecutor(max_workers=2) as executor:
                    jobs = {
                        name: executor.submit(runner, name, specs[name], prompts[name], directory, evidence_ids)
                        for name in PROVIDERS
                    }
                    for name, job in jobs.items():
                        results[name] = job.result()
                try:
                    stable = snapshot(workspace, request["materials"]) == baseline
                except (OSError, ValueError):
                    stable = False
                coverage = "stale" if not stable or not guard(specs) else (
                    "current" if request.get("materials_complete") else "partial"
                )
                independence, status, gate = result_verdict(results, coverage, request.get("host_model"))
                receipt.update(
                    status="finished", coverage=coverage, independence=independence,
                    cross_validation=status, review_gate=gate, providers=results,
                    reason=None if status == "COMPLETED" else "INCOMPLETE_REVIEW",
                )
        except (OSError, ValueError, sqlite3.Error):
            receipt.update(status="unknown", reason="LOCAL_EXECUTION_ERROR")
        if "thread_id" in request:
            receipt["thread_id"] = request["thread_id"]
        receipt["stage"] = request["stage"]
        cacheable = (
            reuse and receipt["cross_validation"] == "COMPLETED"
            and receipt["review_gate"] in ("PASS", "FAIL")
            and all(
                spec["model"].casefold() == (results[name]["observed_model"] or "").casefold()
                for name, spec in specs.items()
            )
        )
        with db:
            db.execute(
                "UPDATE runs SET status=?,finished=?,cacheable=?,receipt=? WHERE id=?",
                (receipt["status"], time.time(), cacheable, canonical(receipt), run_id),
            )
            for name, result in results.items():
                reason = result.get("reason")
                if reason in ("AUTH", "QUOTA", "PROTOCOL"):
                    db.execute(
                        """INSERT INTO blocks VALUES (?,?,?,?,?,NULL,NULL)
                           ON CONFLICT(provider,profile) DO UPDATE SET
                           reason=excluded.reason, run_id=excluded.run_id, created=excluded.created,
                           cleared=NULL, clear_reason=NULL""",
                        (name, specs[name]["profile"], reason, run_id, time.time()),
                    )
        return receipt


def show(db, run_id):
    if db is None:
        return None
    row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        return None
    receipt = json.loads(row["receipt"]) if row["receipt"] else new_receipt(
        run_id, row["fingerprint"], status="in_flight" if owner_alive(row["owner"]) else "unknown",
    )
    receipt["dispositions"] = [
        dict(item) for item in db.execute(
            """SELECT provider,finding,outcome,reason,updated FROM dispositions
               WHERE run_id=? ORDER BY provider,finding""", (run_id,),
        )
    ]
    return receipt


def stats(db):
    output = {
        "runs": 0, "reused": 0, "joined": 0, "adopted_findings": 0, "active_blocks": [],
        "providers": {
            name: {
                "dispatch_attempts": 0, "cli_invoked": 0, "unknown_cli_invocation": 0,
                "elapsed_seconds": 0.0, "failures": {}, "usage": {
                    key: None for key in usage_values({})
                },
            } for name in PROVIDERS
        },
    }
    if db is None:
        return output
    output["reused"], output["joined"] = db.execute(
        "SELECT COALESCE(SUM(reused),0),COALESCE(SUM(joined),0) FROM rounds",
    ).fetchone()
    output["adopted_findings"] = db.execute(
        "SELECT COUNT(*) FROM dispositions WHERE outcome='adopted'",
    ).fetchone()[0]
    output["active_blocks"] = [
        dict(row) for row in db.execute(
            """SELECT provider,profile,reason,run_id,created FROM blocks
               WHERE cleared IS NULL ORDER BY created""",
        )
    ]
    for row in db.execute("SELECT receipt FROM runs"):
        output["runs"] += 1
        if not row["receipt"]:
            continue
        for name, result in json.loads(row["receipt"]).get("providers", {}).items():
            aggregate = output["providers"][name]
            if result["call_attempted"]:
                aggregate["dispatch_attempts"] += 1
                if result["cli_invoked"] is True:
                    aggregate["cli_invoked"] += 1
                elif result["cli_invoked"] is None:
                    aggregate["unknown_cli_invocation"] += 1
                aggregate["elapsed_seconds"] += result["duration_seconds"]
            if reason := result.get("reason"):
                aggregate["failures"][reason] = aggregate["failures"].get(reason, 0) + 1
            for key, value in result["usage"].items():
                if value is not None:
                    aggregate["usage"][key] = (aggregate["usage"][key] or 0) + value
    return output


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE)
    actions = parser.add_subparsers(dest="action", required=True)
    doctor = actions.add_parser("doctor")
    doctor.add_argument("--safety-attestation", type=Path)
    run = actions.add_parser("run")
    run.add_argument("--request-file", type=Path, required=True)
    run.add_argument("--safety-attestation", type=Path)
    run.add_argument("--dry-run", action="store_true")
    actions.add_parser("show").add_argument("run_id")
    actions.add_parser("stats")
    clear = actions.add_parser("clear-block")
    clear.add_argument("--provider", choices=PROVIDERS, required=True)
    clear.add_argument("--profile", required=True)
    clear.add_argument("--reason", required=True)
    record = actions.add_parser("record-disposition")
    record.add_argument("run_id")
    record.add_argument("--provider", choices=PROVIDERS, required=True)
    record.add_argument("--finding", type=int, required=True, help="One-based finding index")
    record.add_argument("--outcome", choices=("adopted", "rejected", "pending"), required=True)
    record.add_argument("--reason", required=True)
    actions.add_parser("validate-review").add_argument("--input-file", type=Path, required=True)
    return parser.parse_args(argv)


def command(args):
    state = args.state_dir.expanduser().absolute()
    action = args.action
    if action in ("run", "doctor"):
        attestation = (args.safety_attestation or state / "agy-safety.json").expanduser().absolute()
    if action == "doctor":
        specs = preflight(attestation, dict.fromkeys(PROVIDERS))
        return {
            "ok": True, "status": "ready",
            "providers": {name: spec["cli_version"] for name, spec in specs.items()},
        }
    if action == "run":
        request, workspace, baseline, prompts = load_request(args.request_file)
        if args.dry_run:
            return {
                "status": "dry_run", "providers": list(PROVIDERS),
                "scope": request["scope"], "material_count": len(baseline),
                "materials_complete": request.get("materials_complete", False),
                "approved_summary": request.get("external_summary_approved", False),
                "prompt_bytes": {name: len(prompt.encode()) for name, prompt in prompts.items()},
            }
        if request.get("external_summary_approved") is not True:
            raise NotReady("SUMMARY_APPROVAL_REQUIRED")
        with installed_read_lock():
            specs = preflight(attestation, request["models"])
            return run_review(request, workspace, baseline, prompts, state, specs)
    if action == "validate-review":
        envelope = read_json(args.input_file, limit=32 * 1024 * 1024)
        review, gate = parse_review(envelope)
        return {"ok": True, "review": review, "gate": gate}
    write = action in ("clear-block", "record-disposition")
    if write and (not args.reason.strip() or len(args.reason) > 2048):
        raise ValueError("a local reason is required")
    if write and not (state / "reviews.sqlite3").exists():
        raise NotReady("LEDGER_MISSING")
    db = connect(state, create=write)
    try:
        if action == "show":
            receipt = show(db, args.run_id)
            if receipt is None:
                raise NotReady("RUN_NOT_FOUND")
            return receipt
        if action == "stats":
            return stats(db)
        with db:
            if action == "clear-block":
                changed = db.execute(
                    """UPDATE blocks SET cleared=?,clear_reason=?
                       WHERE provider=? AND profile=? AND cleared IS NULL""",
                    (time.time(), args.reason, args.provider, args.profile),
                ).rowcount
                if not changed:
                    raise NotReady("BLOCK_NOT_FOUND")
                return {"ok": True, "status": "cleared"}
            receipt = show(db, args.run_id)
            findings = (receipt or {}).get("providers", {}).get(args.provider, {}).get("review", {}).get("findings", [])
            if not 1 <= args.finding <= len(findings):
                raise NotReady("FINDING_NOT_FOUND")
            db.execute(
                """INSERT INTO dispositions VALUES (?,?,?,?,?,?)
                   ON CONFLICT(run_id,provider,finding) DO UPDATE SET
                   outcome=excluded.outcome,reason=excluded.reason,updated=excluded.updated""",
                (args.run_id, args.provider, args.finding, args.outcome, args.reason, time.time()),
            )
            return {"ok": True, "status": "recorded"}
    finally:
        if db is not None:
            db.close()


def main(argv=None):
    args = parse_args(argv)
    try:
        response = command(args)
    except NotReady as exc:
        response = new_receipt(None, None, status="blocked", reason=exc.reason, provider=exc.provider)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        response = new_receipt(None, None, status="error", reason="INVALID_INPUT_OR_LOCAL_STATE")
    print(canonical(response))
    if response.get("status") in ("blocked", "error", "unknown"):
        return 2
    if args.action == "run" and not args.dry_run and response.get("cross_validation") != "COMPLETED":
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
