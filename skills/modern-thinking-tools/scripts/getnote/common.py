#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for GetNote scripts."""

from __future__ import annotations

import atexit
import argparse
import gzip
import http.client
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

BASE_URL = "https://openapi.biji.com/open/api/v1"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TIMEOUT = 30
DEFAULT_REQUEST_INTERVAL_MS = 250
DEFAULT_SHARED_BUCKET_NAME = "default"
DEFAULT_FIXED_PAGE_SIZE = 20
MAX_RATE_LIMIT_RETRY_SLEEP_SECONDS = 60.0
DEFAULT_ADMISSION_BUDGET_SECONDS = 60.0
MAX_BATCH_RESPONSE_BYTES = 32 * 1024 * 1024
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
INVALID_BUCKET_NAME_CHARS = re.compile(r"[^A-Za-z0-9._-]+")
SHARED_BUCKET_STATE_ROOT = REPO_ROOT / "state" / "getnote"
SHARED_BUCKET_LOCK_TIMEOUT_SECONDS = 60.0
SHARED_BUCKET_LOCK_STALE_SECONDS = 120.0
SHARED_BUCKET_LEASE_TTL_SECONDS = 30.0
PROCESS_ID = str(os.getpid())

_LAST_REQUEST_AT_BY_KEY: dict[tuple[str | None, int], float] = {}
_REGISTERED_CLEANUP_BUCKETS: set[str] = set()

# GetNote 是国内端点：urllib 默认直连，不走 HTTP(S)_PROXY；每次直连网络错误由 curl fallback（沿用环境代理）兜底，
# 连续 GETNOTE_DIRECT_FAILURE_LIMIT 次后本进程改回环境代理。设 GETNOTE_USE_ENV_PROXY=1 可恢复旧行为。
GETNOTE_USE_ENV_PROXY_ENV = "GETNOTE_USE_ENV_PROXY"
GETNOTE_DIRECT_FAILURE_LIMIT = 3
_GETNOTE_HOST = urllib.parse.urlsplit(BASE_URL).hostname
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_BATCH_DIRECT_OPENER: ContextVar[Any | None] = ContextVar("getnote_batch_direct_opener", default=None)
_DIRECT_FAILURES = 0
_DIRECT_DISABLED = False


class GetNoteConfigError(RuntimeError):
    """Raised when GetNote credentials are missing."""


class GetNoteSchemaError(RuntimeError):
    """Raised when a successful response no longer matches the expected schema."""


def _load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def get_env_value(name: str, *, required: bool = True) -> str:
    value = _load_dotenv(REPO_ROOT / ".env").get(name, "")
    if value:
        return value

    value = os.environ.get(name)
    if value:
        return value

    if required:
        raise GetNoteConfigError(
            f"Missing required GetNote config: {name}. "
            "Set it in environment variables or repo .env."
        )
    return ""


def load_getnote_credentials() -> tuple[str, str]:
    api_key = get_env_value("GETNOTE_API_KEY")
    client_id = get_env_value("GETNOTE_CLIENT_ID")
    return api_key, client_id


API_KEY, CLIENT_ID = load_getnote_credentials()


def build_headers(*, content_type: str | None = None, bearer: bool = False) -> dict[str, str]:
    authorization = f"Bearer {API_KEY}" if bearer else API_KEY
    headers = {
        "Authorization": authorization,
        "X-Client-ID": CLIENT_ID,
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def safe_filename(value: str, *, max_length: int = 120) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("_", value or "").strip().rstrip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        cleaned = "untitled"
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].rstrip()
    return cleaned


def extract_topic_id(topic: Any, *, default: str = "") -> str:
    if not isinstance(topic, dict):
        return default
    for key in ("topic_id", "topic_id_alias", "id"):
        value = topic.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return default


def parse_optional_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def get_response_items(data: dict[str, Any], item_key: str) -> list[Any]:
    items = data.get(item_key)
    return items if isinstance(items, list) else []


def require_list_field(
    data: dict[str, Any],
    item_key: str,
    *,
    context: str,
) -> list[dict[str, Any]]:
    """Return a required list field without hiding response-schema drift."""
    if item_key not in data:
        raise GetNoteSchemaError(
            f"GetNote response schema mismatch for {context}: missing '{item_key}'"
        )
    items = data[item_key]
    if not isinstance(items, list):
        raise GetNoteSchemaError(
            f"GetNote response schema mismatch for {context}: "
            f"'{item_key}' must be a list, got {type(items).__name__}"
        )
    if any(not isinstance(item, dict) for item in items):
        raise GetNoteSchemaError(
            f"GetNote response schema mismatch for {context}: "
            f"'{item_key}' contains a non-object item"
        )
    return items


def clamp_top_k(value: int, *, maximum: int = 10) -> int:
    """Normalize recall top_k to the currently verified API contract."""
    return min(maximum, max(1, int(value)))


def select_topic_by_name(
    topics: list[dict[str, Any]],
    name_query: str,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Prefer an exact KB name; expose ambiguous fuzzy candidates instead of guessing."""
    normalized = name_query.strip().casefold()
    exact = [
        topic
        for topic in topics
        if str(topic.get("name", "")).strip().casefold() == normalized
    ]
    if len(exact) == 1:
        return exact[0], exact
    fuzzy = [
        topic
        for topic in topics
        if normalized in str(topic.get("name", "")).casefold()
    ]
    if len(fuzzy) == 1:
        return fuzzy[0], fuzzy
    return None, exact or fuzzy


def extract_total_count(data: dict[str, Any]) -> int | None:
    total = parse_optional_int(data.get("total"))
    if total is None or total < 0:
        return None
    return total


def should_continue_fixed_page_pagination(
    data: dict[str, Any],
    *,
    item_key: str,
    fetched_count: int,
    page_size_hint: int = DEFAULT_FIXED_PAGE_SIZE,
) -> bool:
    items = get_response_items(data, item_key)
    if not items:
        return False

    total = extract_total_count(data)
    if total is not None and fetched_count < total:
        return True

    if bool(data.get("has_more")):
        return True

    return len(items) >= max(1, page_size_hint)


def fetch_all_fixed_pages(
    path: str,
    *,
    item_key: str,
    params: dict[str, Any] | None = None,
    page_limit: int = 0,
    retries: int = 4,
    page_size_hint: int = DEFAULT_FIXED_PAGE_SIZE,
    request_options: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1

    while True:
        page_params = dict(params or {})
        page_params["page"] = page
        data = request_json(
            "GET",
            path,
            params=page_params,
            retries=retries,
            **(request_options or {}),
        )
        batch = get_response_items(data, item_key)
        items.extend(batch)

        if page_limit > 0 and page >= page_limit:
            break
        if not should_continue_fixed_page_pagination(
            data,
            item_key=item_key,
            fetched_count=len(items),
            page_size_hint=page_size_hint,
        ):
            break
        page += 1

    return items


def get_fixed_page_total(
    path: str,
    *,
    item_key: str,
    params: dict[str, Any] | None = None,
    retries: int = 3,
    request_options: dict[str, Any] | None = None,
) -> int:
    page_params = dict(params or {})
    page_params["page"] = 1
    data = request_json(
        "GET",
        path,
        params=page_params,
        retries=retries,
        **(request_options or {}),
    )
    total = extract_total_count(data)
    if total is not None:
        return total
    return len(get_response_items(data, item_key))


def get_topic_runtime_stats(
    topic_id: str,
    *,
    request_options: dict[str, Any] | None = None,
) -> dict[str, int]:
    normalized_topic_id = str(topic_id).strip()
    if not normalized_topic_id:
        return {"blogger_count": 0, "live_count": 0}

    return {
        "blogger_count": get_fixed_page_total(
            "/resource/knowledge/bloggers",
            item_key="bloggers",
            params={"topic_id": normalized_topic_id},
            request_options=request_options,
        ),
        "live_count": get_fixed_page_total(
            "/resource/knowledge/lives",
            item_key="lives",
            params={"topic_id": normalized_topic_id},
            request_options=request_options,
        ),
    }


def merge_topic_runtime_stats(
    topic: dict[str, Any],
    *,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stats = dict(topic.get("stats") or {})
    topic_id = extract_topic_id(topic)
    if not topic_id:
        return stats
    runtime_stats = get_topic_runtime_stats(topic_id, request_options=request_options)
    stats.update(runtime_stats)
    return stats


def normalize_bucket_name(shared_bucket_name: str | None) -> str:
    raw = str(shared_bucket_name or DEFAULT_SHARED_BUCKET_NAME).strip()
    cleaned = INVALID_BUCKET_NAME_CHARS.sub("-", raw).strip("-.")
    return cleaned or DEFAULT_SHARED_BUCKET_NAME


def add_rate_limit_args(
    parser: argparse.ArgumentParser,
    *,
    default_request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
    default_shared_bucket_name: str = DEFAULT_SHARED_BUCKET_NAME,
) -> argparse.ArgumentParser:
    parser.add_argument(
        "--request-interval-ms",
        type=int,
        default=default_request_interval_ms,
        help=f"请求最小间隔毫秒数，默认 {default_request_interval_ms}",
    )
    parser.add_argument(
        "--shared-bucket-name",
        default=default_shared_bucket_name,
        help=f"共享 bucket 名称，默认 {default_shared_bucket_name}",
    )
    return parser


def request_options_from_args(args: Any) -> dict[str, Any]:
    request_interval_ms = int(
        getattr(args, "request_interval_ms", DEFAULT_REQUEST_INTERVAL_MS)
    )
    if request_interval_ms < 0:
        raise ValueError("--request-interval-ms 不能小于 0")
    shared_bucket_name = str(
        getattr(args, "shared_bucket_name", DEFAULT_SHARED_BUCKET_NAME) or DEFAULT_SHARED_BUCKET_NAME
    )
    return {
        "request_interval_ms": request_interval_ms,
        "shared_bucket_name": shared_bucket_name,
    }


def _shared_bucket_dir(shared_bucket_name: str | None) -> Path:
    return SHARED_BUCKET_STATE_ROOT / normalize_bucket_name(shared_bucket_name)


def _shared_bucket_state_path(shared_bucket_name: str | None) -> Path:
    return _shared_bucket_dir(shared_bucket_name) / "shared_rate_limit.json"


def _shared_bucket_lock_path(shared_bucket_name: str | None) -> Path:
    return _shared_bucket_dir(shared_bucket_name) / "shared_rate_limit.lock"


def _default_shared_bucket_state() -> dict[str, Any]:
    return {
        "version": 1,
        "updated_at": 0.0,
        "tokens": 1.0,
        "active_leases": {},
        "cooldown_until": 0.0,
    }


def _ensure_shared_bucket_dir(shared_bucket_name: str | None) -> None:
    _shared_bucket_dir(shared_bucket_name).mkdir(parents=True, exist_ok=True)


def _load_shared_bucket_state(shared_bucket_name: str | None) -> dict[str, Any]:
    _ensure_shared_bucket_dir(shared_bucket_name)
    state_path = _shared_bucket_state_path(shared_bucket_name)
    if not state_path.exists():
        return _default_shared_bucket_state()
    try:
        raw = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return _default_shared_bucket_state()

    state = _default_shared_bucket_state()
    updated_at = raw.get("updated_at")
    tokens = raw.get("tokens")
    state["updated_at"] = float(updated_at if updated_at is not None else 0.0)
    state["tokens"] = float(tokens if tokens is not None else 1.0)
    state["cooldown_until"] = float(raw.get("cooldown_until") or 0.0)
    active_leases = raw.get("active_leases")
    state["active_leases"] = active_leases if isinstance(active_leases, dict) else {}
    return state


def _write_shared_bucket_state(shared_bucket_name: str | None, state: dict[str, Any]) -> None:
    _ensure_shared_bucket_dir(shared_bucket_name)
    state_path = _shared_bucket_state_path(shared_bucket_name)
    temp_path = state_path.with_suffix(f".{PROCESS_ID}.tmp")
    temp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp_path, state_path)


@contextmanager
def _shared_bucket_lock(
    shared_bucket_name: str | None,
    timeout_seconds: float = SHARED_BUCKET_LOCK_TIMEOUT_SECONDS,
    *, request_deadline: float | None = None,
):
    _ensure_shared_bucket_dir(shared_bucket_name)
    lock_path = _shared_bucket_lock_path(shared_bucket_name)
    deadline = time.time() + timeout_seconds
    while True:
        if request_deadline is not None and time.monotonic() >= request_deadline:
            raise TimeoutError("GetNote request deadline exceeded")
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"pid": PROCESS_ID, "acquired_at": time.time()}, handle)
            break
        except (FileExistsError, PermissionError) as exc:
            if isinstance(exc, PermissionError) and not lock_path.exists():
                raise
            try:
                lock_age = time.time() - lock_path.stat().st_mtime
            except FileNotFoundError:
                continue
            if lock_age > SHARED_BUCKET_LOCK_STALE_SECONDS:
                try:
                    lock_path.unlink(missing_ok=True)
                except PermissionError:
                    pass
                continue
            if time.time() >= deadline:
                raise RuntimeError(
                    f"Timed out waiting for shared bucket lock: {normalize_bucket_name(shared_bucket_name)}"
                )
            time.sleep(0.05)
    try:
        yield
    finally:
        lock_path.unlink(missing_ok=True)


def _prune_active_leases(
    active_leases: dict[str, Any],
    now: float,
    *,
    fallback_interval_ms: int,
) -> dict[str, dict[str, float | int]]:
    cleaned: dict[str, dict[str, float | int]] = {}
    for raw_pid, raw_lease in (active_leases or {}).items():
        if not isinstance(raw_lease, dict):
            continue
        try:
            interval_ms = max(0, int(raw_lease.get("interval_ms", fallback_interval_ms)))
            last_seen = float(raw_lease.get("last_seen", 0.0))
        except (TypeError, ValueError):
            continue
        if now - last_seen <= SHARED_BUCKET_LEASE_TTL_SECONDS:
            cleaned[str(raw_pid)] = {"interval_ms": interval_ms, "last_seen": last_seen}
    return cleaned


def _effective_shared_interval_seconds(active_leases: dict[str, dict[str, float | int]]) -> float:
    if not active_leases:
        return 0.0
    interval_ms = max(int(lease["interval_ms"]) for lease in active_leases.values())
    if interval_ms <= 0:
        return 0.0
    return interval_ms / 1000.0


def _register_shared_bucket_cleanup(shared_bucket_name: str | None, *, deadline: float | None = None) -> None:
    bucket = normalize_bucket_name(shared_bucket_name)
    if bucket in _REGISTERED_CLEANUP_BUCKETS:
        return
    atexit.register(cleanup_shared_bucket_lease, shared_bucket_name, timeout_seconds=0.1 if deadline is not None else 5.0)
    _REGISTERED_CLEANUP_BUCKETS.add(bucket)


def inspect_shared_bucket(
    shared_bucket_name: str | None = DEFAULT_SHARED_BUCKET_NAME,
    *,
    fallback_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
) -> dict[str, Any]:
    bucket = normalize_bucket_name(shared_bucket_name)
    now = time.time()
    with _shared_bucket_lock(bucket, timeout_seconds=5.0):
        state = _load_shared_bucket_state(bucket)
        active_leases = _prune_active_leases(
            state.get("active_leases") or {},
            now,
            fallback_interval_ms=fallback_interval_ms,
        )
        if active_leases != (state.get("active_leases") or {}):
            state["active_leases"] = active_leases
            state["updated_at"] = now
            _write_shared_bucket_state(bucket, state)

    effective_interval_seconds = _effective_shared_interval_seconds(active_leases)
    updated_at = float(state.get("updated_at") or 0.0)
    return {
        "bucket_name": bucket,
        "state_path": str(_shared_bucket_state_path(bucket)),
        "lock_path": str(_shared_bucket_lock_path(bucket)),
        "tokens": float(state.get("tokens") or 0.0),
        "updated_at": updated_at,
        "cooldown_until": float(state.get("cooldown_until") or 0.0),
        "cooldown_remaining_seconds": max(0.0, float(state.get("cooldown_until") or 0.0) - now),
        "updated_at_iso": (
            datetime.fromtimestamp(updated_at, tz=timezone.utc).astimezone().isoformat()
            if updated_at > 0
            else ""
        ),
        "active_lease_count": len(active_leases),
        "effective_interval_ms": int(round(effective_interval_seconds * 1000)),
        "active_leases": [
            {
                "pid": pid,
                "interval_ms": int(lease["interval_ms"]),
                "last_seen": float(lease["last_seen"]),
                "last_seen_iso": datetime.fromtimestamp(
                    float(lease["last_seen"]), tz=timezone.utc
                ).astimezone().isoformat(),
                "age_ms": int(round(max(0.0, now - float(lease["last_seen"])) * 1000)),
            }
            for pid, lease in sorted(
                active_leases.items(),
                key=lambda item: float(item[1]["last_seen"]),
                reverse=True,
            )
        ],
    }


def cleanup_shared_bucket_lease(
    shared_bucket_name: str | None = DEFAULT_SHARED_BUCKET_NAME,
    request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
    *, timeout_seconds: float = 5.0,
) -> None:
    if request_interval_ms <= 0:
        return
    bucket = normalize_bucket_name(shared_bucket_name)
    try:
        with _shared_bucket_lock(bucket, timeout_seconds=timeout_seconds):
            now = time.time()
            state = _load_shared_bucket_state(bucket)
            active_leases = _prune_active_leases(
                state.get("active_leases") or {},
                now,
                fallback_interval_ms=request_interval_ms,
            )
            active_leases.pop(PROCESS_ID, None)
            state["active_leases"] = active_leases
            state["updated_at"] = now
            _write_shared_bucket_state(bucket, state)
    except Exception:
        return


def wait_for_local_request_slot(
    request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
    shared_bucket_name: str | None = DEFAULT_SHARED_BUCKET_NAME,
    *, deadline: float | None = None,
) -> None:
    if request_interval_ms <= 0:
        return
    key = (normalize_bucket_name(shared_bucket_name) if shared_bucket_name else None, request_interval_ms)
    last_request_at = _LAST_REQUEST_AT_BY_KEY.get(key, 0.0)
    request_interval_seconds = request_interval_ms / 1000.0
    now = time.monotonic()
    remaining = request_interval_seconds - (now - last_request_at)
    if remaining > 0:
        if deadline is not None and now + remaining >= deadline:
            raise TimeoutError("GetNote request deadline exceeded")
        time.sleep(remaining)
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError("GetNote request deadline exceeded")
    _LAST_REQUEST_AT_BY_KEY[key] = time.monotonic()


def wait_for_shared_request_slot(
    request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
    shared_bucket_name: str | None = DEFAULT_SHARED_BUCKET_NAME,
    *, deadline: float | None = None,
) -> None:
    if deadline is None:
        deadline = time.monotonic() + DEFAULT_ADMISSION_BUDGET_SECONDS
    if request_interval_ms <= 0 or not shared_bucket_name:
        # Disabling client token pacing never disables a server QPS cooldown.
        while True:
            with _shared_bucket_lock(DEFAULT_SHARED_BUCKET_NAME, request_deadline=deadline):
                state = _load_shared_bucket_state(DEFAULT_SHARED_BUCKET_NAME)
                remaining = max(0.0, float(state.get("cooldown_until") or 0.0) - time.time())
            if remaining <= 0:
                return
            if time.monotonic() + remaining >= deadline:
                raise TimeoutError("GetNote shared QPS cooldown exceeds admission budget; no request sent")
            time.sleep(remaining)
    bucket = normalize_bucket_name(shared_bucket_name)
    _register_shared_bucket_cleanup(bucket, deadline=deadline)
    while True:
        global_cooldown_until = 0.0
        if bucket != DEFAULT_SHARED_BUCKET_NAME:
            # The default bucket also carries workspace-wide QPS cooldown.
            # Locks are acquired separately; custom names cannot bypass it.
            with _shared_bucket_lock(DEFAULT_SHARED_BUCKET_NAME, request_deadline=deadline):
                global_state = _load_shared_bucket_state(DEFAULT_SHARED_BUCKET_NAME)
                global_cooldown_until = float(global_state.get("cooldown_until") or 0.0)
        with _shared_bucket_lock(bucket, request_deadline=deadline):
            now = time.time()
            state = _load_shared_bucket_state(bucket)
            active_leases = _prune_active_leases(
                state.get("active_leases") or {},
                now,
                fallback_interval_ms=request_interval_ms,
            )
            active_leases[PROCESS_ID] = {
                "interval_ms": int(request_interval_ms),
                "last_seen": now,
            }
            effective_interval = _effective_shared_interval_seconds(active_leases)
            if effective_interval <= 0:
                state["active_leases"] = active_leases
                state["updated_at"] = now
                state["tokens"] = 1.0
                _write_shared_bucket_state(bucket, state)
                return

            refill_rate = 1.0 / effective_interval
            capacity = 1.0
            last_updated_at = float(state.get("updated_at") if state.get("updated_at") is not None else 0.0)
            tokens = float(state.get("tokens") if state.get("tokens") is not None else capacity)
            if last_updated_at > 0:
                tokens = min(capacity, tokens + max(0.0, now - last_updated_at) * refill_rate)
            else:
                tokens = capacity
            cooldown_remaining = max(
                0.0, max(float(state.get("cooldown_until") or 0.0), global_cooldown_until) - now,
            )
            if cooldown_remaining > 0:
                tokens = 0.0

            if tokens >= 1.0:
                tokens -= 1.0
                state["active_leases"] = active_leases
                state["updated_at"] = now
                state["tokens"] = tokens
                _write_shared_bucket_state(bucket, state)
                return

            wait_seconds = max((1.0 - tokens) / refill_rate, 0.05, cooldown_remaining)
            state["active_leases"] = active_leases
            state["updated_at"] = now
            state["tokens"] = tokens
            _write_shared_bucket_state(bucket, state)
        if deadline is not None and time.monotonic() + wait_seconds >= deadline:
            raise TimeoutError("GetNote shared QPS/token wait exceeds admission budget; no request sent")
        time.sleep(wait_seconds)


def wait_for_request_slot(
    request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
    shared_bucket_name: str | None = DEFAULT_SHARED_BUCKET_NAME,
    *, deadline: float | None = None,
) -> None:
    if deadline is None:
        deadline = time.monotonic() + DEFAULT_ADMISSION_BUDGET_SECONDS
    wait_for_local_request_slot(
        request_interval_ms=request_interval_ms,
        shared_bucket_name=shared_bucket_name,
        deadline=deadline,
    )
    wait_for_shared_request_slot(
        request_interval_ms=request_interval_ms,
        shared_bucket_name=shared_bucket_name,
        deadline=deadline,
    )
    if time.monotonic() >= deadline:
        raise TimeoutError("GetNote admission budget exhausted before transport; no request sent")


def retry_sleep_seconds(
    attempt: int,
    *,
    is_rate_limited: bool,
    request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
) -> float:
    request_interval_seconds = max(request_interval_ms, 0) / 1000.0
    if is_rate_limited:
        return min(20.0, max(request_interval_seconds * 4, float(2 ** (attempt + 1))))
    return float(min(12, 2**attempt))


def _record_shared_cooldown(
    shared_bucket_name: str | None, delay_seconds: float, *, request_interval_ms: int,
    deadline: float | None = None,
) -> None:
    """Publish workspace QPS cooldown, retaining existing per-bucket metadata."""
    buckets = [DEFAULT_SHARED_BUCKET_NAME]
    bucket = normalize_bucket_name(shared_bucket_name) if shared_bucket_name else DEFAULT_SHARED_BUCKET_NAME
    if bucket != DEFAULT_SHARED_BUCKET_NAME:
        buckets.append(bucket)
    for bucket in buckets:
        with _shared_bucket_lock(bucket, request_deadline=deadline):
            now = time.time()
            state = _load_shared_bucket_state(bucket)
            state["cooldown_until"] = max(float(state.get("cooldown_until") or 0.0), now + delay_seconds)
            state["updated_at"] = now
            state["tokens"] = 0.0
            _write_shared_bucket_state(bucket, state)


def _rate_limit_delay(attempt: int, request_interval_ms: int, *, headers=None, result=None) -> float:
    """Honor provider retry hints without inferring a fixed service QPS."""
    delays = [retry_sleep_seconds(attempt, is_rate_limited=True, request_interval_ms=request_interval_ms)]
    retry_after = (headers or {}).get("Retry-After")
    if retry_after:
        try:
            delays.append(float(retry_after))
        except (TypeError, ValueError):
            try:
                retry_at = parsedate_to_datetime(str(retry_after))
                if retry_at.tzinfo is not None:
                    delays.append(retry_at.timestamp() - time.time())
            except (TypeError, ValueError, OverflowError):
                pass
    if isinstance(result, dict):
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        for source in (result, error, result.get("rate_limit"), error.get("rate_limit")):
            if not isinstance(source, dict):
                continue
            for key in ("retry_after_seconds", "retry_after"):
                try:
                    delays.append(float(source.get(key)))
                except (TypeError, ValueError):
                    pass
    return max(1.0, *(delay for delay in delays if math.isfinite(delay) and delay >= 0))


def _rate_limit_pause(
    delay: float, *, attempt: int, retries: int, shared_bucket_name: str | None,
    request_interval_ms: int, retryable: bool = True, deadline: float | None = None,
) -> bool:
    try:
        _record_shared_cooldown(
            shared_bucket_name, delay, request_interval_ms=request_interval_ms, deadline=deadline,
        )
    except TimeoutError:
        return False  # Preserve the original provider error when its budget expires.
    if not retryable or attempt >= retries:
        return False
    if delay > MAX_RATE_LIMIT_RETRY_SLEEP_SECONDS or (
        deadline is not None and time.monotonic() + delay >= deadline
    ):
        return False
    time.sleep(delay)
    return True


def _curl_config_quote(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _request_json_via_curl(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    payload: bytes | None,
    timeout: int,
) -> dict[str, Any]:
    """Fallback for local Python SSL/proxy issues without printing secrets."""
    config_lines = [
        f'url = "{_curl_config_quote(url)}"',
        f'request = "{_curl_config_quote(method.upper())}"',
        f"connect-timeout = {max(1, int(timeout))}",
        f"max-time = {max(1, int(timeout) + 5)}",
        "silent",
        "show-error",
        "include",
    ]
    for key, value in headers.items():
        config_lines.append(f'header = "{_curl_config_quote(f"{key}: {value}")}"')
    if payload is not None:
        config_lines.append(f'data = "{_curl_config_quote(payload.decode("utf-8"))}"')

    completed = subprocess.run(
        ["curl", "--config", "-"],
        input="\n".join(config_lines) + "\n",
        text=True,
        capture_output=True,
        check=False,
        timeout=max(1, int(timeout) + 10),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"curl fallback failed: exit={completed.returncode} stderr={completed.stderr.strip()}")
    body = completed.stdout
    status, reason, response_headers = 200, "", {}
    # curl may emit a proxy CONNECT response before the actual API headers.
    while body.startswith("HTTP/"):
        header_block, separator, remainder = body.replace("\r\n", "\n").partition("\n\n")
        if not separator:
            raise GetNoteSchemaError("curl fallback returned incomplete HTTP headers")
        status_line, _, header_lines = header_block.partition("\n")
        match = re.match(r"HTTP/\S+\s+(\d{3})(?:\s+(.*))?$", status_line)
        if not match:
            raise GetNoteSchemaError("curl fallback returned an invalid HTTP status")
        status, reason = int(match.group(1)), match.group(2) or ""
        response_headers = http.client.parse_headers(io.BytesIO(header_lines.encode("utf-8") + b"\n\n"))
        body = remainder
    if status >= 300:
        raise urllib.error.HTTPError(url, status, reason, response_headers, io.BytesIO(body.encode("utf-8")))
    return json.loads(body)


@contextmanager
def persistent_getnote_requests():
    """Reuse direct HTTPS connections only within the current batch context."""
    original = _DIRECT_OPENER
    connections: dict[tuple[str, int | None], http.client.HTTPSConnection] = {}

    class BatchOpener:
        def open(self, request, timeout):
            url = urllib.parse.urlsplit(request.full_url)
            if url.scheme != "https" or url.hostname != _GETNOTE_HOST:
                return original.open(request, timeout=timeout)
            key = (url.hostname, url.port)
            connection = connections.get(key)
            if connection is None:
                connection = http.client.HTTPSConnection(*key, timeout=timeout)
                connections[key] = connection
            connection.timeout = timeout
            if connection.sock is not None:
                connection.sock.settimeout(timeout)
            headers = dict(request.header_items())
            headers["Accept-Encoding"] = "gzip"
            target = urllib.parse.urlunsplit(("", "", url.path or "/", url.query, ""))
            try:
                connection.request(request.get_method(), target, body=request.data, headers=headers)
                response = connection.getresponse()
                body = response.read(MAX_BATCH_RESPONSE_BYTES + 1)
                if len(body) > MAX_BATCH_RESPONSE_BYTES:
                    raise GetNoteSchemaError("GetNote batch response exceeds compressed body limit")
                if response.headers.get("Content-Encoding", "").lower() == "gzip":
                    try:
                        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
                            body = compressed.read(MAX_BATCH_RESPONSE_BYTES + 1)
                    except (OSError, EOFError, zlib.error) as exc:
                        raise GetNoteSchemaError("GetNote batch response has invalid gzip") from exc
                    if len(body) > MAX_BATCH_RESPONSE_BYTES:
                        raise GetNoteSchemaError("GetNote batch response exceeds decoded body limit")
            except GetNoteSchemaError:
                connections.pop(key, None)
                connection.close()
                raise
            except (OSError, http.client.HTTPException) as exc:
                connections.pop(key, None)
                connection.close()
                raise urllib.error.URLError(exc) from exc
            if response.status >= 300:
                raise urllib.error.HTTPError(request.full_url, response.status, response.reason, response.headers, io.BytesIO(body))
            return io.BytesIO(body)

    token = _BATCH_DIRECT_OPENER.set(BatchOpener())
    try:
        yield
    finally:
        _BATCH_DIRECT_OPENER.reset(token)
        for connection in connections.values():
            connection.close()


def _open_getnote_url(request: urllib.request.Request, *, timeout: int):
    """GetNote API 默认直连；连续直连网络错误达到上限后本进程改回环境代理（成功或 HTTP 错误清零）。"""
    global _DIRECT_FAILURES, _DIRECT_DISABLED
    if (
        _DIRECT_DISABLED
        or os.environ.get(GETNOTE_USE_ENV_PROXY_ENV) == "1"
        or urllib.parse.urlsplit(request.full_url).hostname != _GETNOTE_HOST
    ):
        return urllib.request.urlopen(request, timeout=timeout)
    try:
        response = (_BATCH_DIRECT_OPENER.get() or _DIRECT_OPENER).open(request, timeout=timeout)
    except urllib.error.HTTPError:
        _DIRECT_FAILURES = 0
        raise
    except OSError as exc:
        _DIRECT_FAILURES += 1
        _DIRECT_DISABLED = _DIRECT_FAILURES >= GETNOTE_DIRECT_FAILURE_LIMIT
        print(
            f"[getnote] {datetime.now().isoformat(timespec='seconds')} direct connection failed "
            f"({type(exc).__name__}: {str(exc)[:160]}); consecutive={_DIRECT_FAILURES}"
            + ("; using env proxy for this process" if _DIRECT_DISABLED else "; curl fallback via env proxy"),
            file=sys.stderr,
        )
        raise
    _DIRECT_FAILURES = 0
    return response


def request_json(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | list[Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    retries: int = 4,
    bearer: bool = False,
    request_interval_ms: int = DEFAULT_REQUEST_INTERVAL_MS,
    shared_bucket_name: str | None = DEFAULT_SHARED_BUCKET_NAME,
    admission_budget_seconds: float = DEFAULT_ADMISSION_BUDGET_SECONDS,
) -> dict[str, Any]:
    """Bound slot/retry admission from entry; timeout remains per transport.

    An already admitted transport may finish after this admission window.
    This is not a wall-clock deadline for the complete HTTP body read.
    """
    if not math.isfinite(admission_budget_seconds) or admission_budget_seconds <= 0:
        raise ValueError("admission_budget_seconds must be a finite positive number")
    admission_deadline = time.monotonic() + admission_budget_seconds
    url = path if path.startswith("http") else f"{BASE_URL}{path}"
    if params:
        query = urllib.parse.urlencode(
            {key: value for key, value in params.items() if value is not None}
        )
        url = f"{url}?{query}"

    headers = build_headers(
        content_type="application/json" if body is not None else None,
        bearer=bearer,
    )
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        result: dict[str, Any] | None = None
        try:
            wait_for_request_slot(
                request_interval_ms=request_interval_ms,
                shared_bucket_name=shared_bucket_name,
                deadline=admission_deadline,
            )
        except TimeoutError as exc:
            if last_error is not None:
                raise last_error from exc
            raise
        request = urllib.request.Request(url, data=payload, headers=headers, method=method.upper())
        try:
            try:
                with _open_getnote_url(request, timeout=timeout) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except (urllib.error.HTTPError, GetNoteSchemaError):
                raise
            except Exception:
                # A transport fallback is another physical HTTP request and
                # consumes a new slot in the same local/shared bucket.
                wait_for_request_slot(
                    request_interval_ms=request_interval_ms,
                    shared_bucket_name=shared_bucket_name,
                    deadline=admission_deadline,
                )
                result = _request_json_via_curl(
                    method, url, headers=headers, payload=payload, timeout=timeout,
                )
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="ignore")
            except Exception:
                detail = ""
            try:
                error_result = json.loads(detail)
            except (TypeError, ValueError):
                error_result = {}
            error = error_result.get("error") if isinstance(error_result, dict) else {}
            error = error if isinstance(error, dict) else {}
            failure = RuntimeError(f"GetNote request failed: HTTP {exc.code} {exc.reason}. {detail}".strip())
            last_error = failure
            qps_error = str(error.get("code")) == "10202" or error.get("reason") == "qps_global_exceeded"
            # A 429 carrying a different explicit API error can be a quota or
            # permission failure. Only retry QPS errors or an unqualified 429.
            if exc.code == 429 and (qps_error or not error):
                delay = _rate_limit_delay(attempt, request_interval_ms, headers=exc.headers, result=error_result)
                if _rate_limit_pause(
                    delay, attempt=attempt, retries=retries, shared_bucket_name=shared_bucket_name,
                    request_interval_ms=request_interval_ms, retryable=error.get("retryable") is not False,
                    deadline=admission_deadline,
                ):
                    continue
            raise failure from exc
        except GetNoteSchemaError:
            raise
        except Exception as exc:  # pragma: no cover - network errors
            last_error = exc
            if attempt < retries:
                delay = retry_sleep_seconds(
                    attempt, is_rate_limited=False, request_interval_ms=request_interval_ms,
                )
                if time.monotonic() + delay < admission_deadline:
                    time.sleep(delay)
                    continue
            raise last_error

        if result.get("success") is False:
            error = result.get("error") or {}
            reason = str(error.get("reason", "unknown"))
            code = str(error.get("code", "unknown"))
            failure = RuntimeError(
                "GetNote API returned error: "
                f"code={code} reason={reason} message={error.get('message', 'unknown')}"
            )
            last_error = failure
            if reason == "qps_global_exceeded" or code == "10202":
                delay = _rate_limit_delay(attempt, request_interval_ms, result=result)
                if _rate_limit_pause(
                    delay, attempt=attempt, retries=retries, shared_bucket_name=shared_bucket_name,
                    request_interval_ms=request_interval_ms, retryable=error.get("retryable") is not False,
                    deadline=admission_deadline,
                ):
                    continue
            raise failure
        return result.get("data", {})

    raise RuntimeError(f"GetNote request failed after retries: {last_error}")


def list_notes(
    since_id: str | int = 0,
    *,
    limit: int | None = None,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"since_id": str(since_id)}
    if limit is not None:
        params["limit"] = int(limit)
    return request_json(
        "GET",
        "/resource/note/list",
        params=params,
        **(request_options or {}),
    )


def get_note_detail(
    note_id: str | int,
    *,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return request_json(
        "GET",
        "/resource/note/detail",
        params={"id": str(note_id)},
        **(request_options or {}),
    )


def save_note(
    title: str,
    content: str,
    *,
    note_type: str = "plain_text",
    tags: list[str] | None = None,
    extra_body: dict[str, Any] | None = None,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "title": title,
        "content": content,
        "note_type": note_type,
    }
    if tags:
        body["tags"] = list(tags)
    if extra_body:
        body.update(extra_body)
    return request_json(
        "POST",
        "/resource/note/save",
        body=body,
        **(request_options or {}),
    )


def add_notes_to_knowledge(
    topic_id: str,
    note_ids: list[str] | tuple[str, ...],
    *,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return request_json(
        "POST",
        "/resource/knowledge/note/batch-add",
        body={
            "topic_id": str(topic_id),
            "note_ids": [str(note_id) for note_id in note_ids],
        },
        **(request_options or {}),
    )


def recall_notes(
    query: str,
    *,
    top_k: int = 3,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return request_json(
        "POST",
        "/resource/recall",
        body={"query": query, "top_k": int(top_k)},
        **(request_options or {}),
    )


def recall_knowledge(
    topic_id: str,
    query: str,
    *,
    top_k: int = 3,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return request_json(
        "POST",
        "/resource/recall/knowledge",
        body={
            "topic_id": str(topic_id),
            "query": query,
            "top_k": int(top_k),
        },
        **(request_options or {}),
    )


def get_knowledge_notes(
    topic_id: str,
    *,
    page: int = 1,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return request_json(
        "GET",
        "/resource/knowledge/notes",
        params={"topic_id": str(topic_id), "page": int(page)},
        **(request_options or {}),
    )
