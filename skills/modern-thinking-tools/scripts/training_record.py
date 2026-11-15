#!/usr/bin/env python3
"""Small private, append-only training ledger shared by Codex, Claude and OpenClaw."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


DEFAULT_DB = Path.home() / ".local/share/modern-thinking-tools/training.sqlite3"
TOOL_ID = re.compile(r"T(?:00[1-9]|0[1-9]\d|100)\Z")
SAFE_REF = re.compile(r"[A-Za-z0-9_.:-]{1,120}\Z")
SUMMARY_CODES = {"unattempted", "attempt_pending_review", "mechanism_clear", "boundary_missing", "needs_example", "insufficient_information", "other_reasoning_gap"}
PROVENANCE = {"observed_practice", "user_report", "ai_inference"}
RUBRIC = {"supported", "needs_work", "unknown"}
INTERVALS = (1, 3, 7, 14)


def ident(value: str, label: str) -> str:
    if not SAFE_REF.fullmatch(value):
        raise ValueError(f"{label} must be a non-sensitive token of 1-120 characters")
    return value


def ids(values: list[str]) -> list[str]:
    result = list(dict.fromkeys(value.upper() for value in values))
    if not 1 <= len(result) <= 3 or any(not TOOL_ID.fullmatch(value) for value in result):
        raise ValueError("provide 1-3 unique canonical Txxx IDs")
    return result


def connect(path: Path, *, create: bool) -> sqlite3.Connection | None:
    if not create and not path.is_file():
        return None
    if create:
        if path.exists() and path.is_symlink():
            raise ValueError("database must not be a symlink")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.parent.stat().st_mode & 0o077:
            raise ValueError("database parent must be private (0700)")
    connection = sqlite3.connect(path, timeout=20)
    if create:
        os.chmod(path, 0o600)
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL,
                tool_ids TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'active'
            );
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
                recorded_at TEXT NOT NULL, kind TEXT NOT NULL, tool_id TEXT NOT NULL,
                question_ref TEXT, summary_code TEXT NOT NULL, hint_level INTEGER NOT NULL,
                rubric_json TEXT NOT NULL, evidence_ref TEXT, next_review TEXT,
                decision_code TEXT, counterevidence_code TEXT, result_code TEXT,
                provenance TEXT NOT NULL
            );
        """)
    return connection


def due_date(tool_id: str, connection: sqlite3.Connection, hint_level: int, rubric: dict[str, str]) -> str:
    if hint_level or rubric.get("boundary") != "supported":
        days = INTERVALS[0]
    else:
        rows = connection.execute(
            "SELECT hint_level, rubric_json FROM events WHERE tool_id=? AND kind='feedback' ORDER BY recorded_at DESC LIMIT 4",
            (tool_id,),
        ).fetchall()
        streak = 0
        for previous_hint, previous_rubric in rows:
            if previous_hint or json.loads(previous_rubric).get("boundary") != "supported":
                break
            streak += 1
        days = INTERVALS[min(streak, len(INTERVALS) - 1)]
    return (date.today() + timedelta(days=days)).isoformat()


def start(connection: sqlite3.Connection, args: argparse.Namespace) -> dict:
    session_id = ident(args.session_id or str(uuid.uuid4()), "session_id")
    selected = ids(args.tool_id)
    with connection:
        if connection.execute("SELECT value FROM settings WHERE key='recording'").fetchone() == ("off",):
            return {"saved": False, "reason": "recording_paused", "session_id": session_id}
        connection.execute(
            "INSERT OR IGNORE INTO sessions(session_id,started_at,tool_ids) VALUES (?,?,?)",
            (session_id, datetime.now(timezone.utc).isoformat(), json.dumps(selected)),
        )
        actual = json.loads(connection.execute("SELECT tool_ids FROM sessions WHERE session_id=?", (session_id,)).fetchone()[0])
        if actual != selected:
            raise ValueError("session_id already belongs to different tools")
    return {"saved": True, "session_id": session_id, "tool_ids": selected}


def record(connection: sqlite3.Connection, args: argparse.Namespace) -> dict:
    session_id = ident(args.session_id, "session_id")
    event_id = ident(args.event_id, "event_id")
    tool_id = ids([args.tool_id])[0]
    rubric = {key: getattr(args, key) for key in ("mechanism", "recognition", "boundary", "action", "updating")}
    existing = connection.execute(
        "SELECT session_id,kind,tool_id,question_ref,summary_code,hint_level,rubric_json,evidence_ref,decision_code,counterevidence_code,result_code,provenance FROM events WHERE event_id=?",
        (event_id,),
    ).fetchone()
    if existing:
        provenance = "user_report" if args.kind in {"precommit", "outcome"} and args.provenance == "observed_practice" else args.provenance
        same = existing == (
            session_id, args.kind, tool_id, args.question_ref, args.summary_code,
            args.hint_level, json.dumps(rubric), args.evidence_ref,
            args.decision_code, args.counterevidence_code, args.result_code, provenance,
        )
        if not same:
            raise ValueError("event_id already exists with different data")
        return {"saved": True, "event_id": event_id, "duplicate": True}
    session = connection.execute("SELECT tool_ids FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    if not session or tool_id not in json.loads(session[0]):
        raise ValueError("session and tool_id must already exist")
    if args.kind == "feedback" and args.summary_code == "unattempted":
        raise ValueError("unattempted response cannot count as feedback")
    if args.kind == "feedback" and (not args.question_ref or not connection.execute(
        "SELECT 1 FROM events WHERE session_id=? AND tool_id=? AND kind='answer' AND question_ref=?",
        (session_id, tool_id, args.question_ref),
    ).fetchone()):
        raise ValueError("feedback requires a prior answer to this question")
    if args.kind == "outcome" and not args.result_code:
        raise ValueError("outcome requires a result code")
    if args.kind == "precommit" and not (args.decision_code and args.counterevidence_code):
        raise ValueError("precommit requires decision and counterevidence codes")
    if args.kind == "outcome" and (not args.question_ref or not connection.execute(
        "SELECT 1 FROM events WHERE session_id=? AND tool_id=? AND kind='precommit' AND question_ref=?",
        (session_id, tool_id, args.question_ref),
    ).fetchone()):
        raise ValueError("outcome requires a previously recorded precommit")
    for label in ("question_ref", "evidence_ref", "decision_code", "counterevidence_code", "result_code"):
        value = getattr(args, label)
        if value:
            ident(value, label)
    next_review = args.next_review
    if next_review:
        date.fromisoformat(next_review)
    if args.kind == "feedback" and not next_review:
        next_review = due_date(tool_id, connection, args.hint_level, rubric)
    with connection:
        if connection.execute("SELECT value FROM settings WHERE key='recording'").fetchone() == ("off",):
            return {"saved": False, "reason": "recording_paused", "event_id": event_id}
        provenance = "user_report" if args.kind in {"precommit", "outcome"} and args.provenance == "observed_practice" else args.provenance
        connection.execute(
            """INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (event_id, session_id, datetime.now(timezone.utc).isoformat(), args.kind, tool_id,
             args.question_ref, args.summary_code, args.hint_level, json.dumps(rubric),
             args.evidence_ref, next_review, args.decision_code, args.counterevidence_code,
             args.result_code, provenance),
        )
    return {"saved": True, "event_id": event_id, "duplicate": False, "next_review": next_review}


def read_summary(connection: sqlite3.Connection | None, session_id: str | None) -> dict:
    if connection is None:
        return {"sessions": [], "due_tools": []}
    if session_id:
        rows = connection.execute("SELECT session_id,started_at,tool_ids,phase FROM sessions WHERE session_id=?", (ident(session_id, "session_id"),)).fetchall()
    else:
        rows = connection.execute("SELECT session_id,started_at,tool_ids,phase FROM sessions ORDER BY started_at DESC LIMIT 10").fetchall()
    sessions = []
    for sid, started, tool_ids, phase in rows:
        counts = connection.execute("SELECT kind,COUNT(*) FROM events WHERE session_id=? GROUP BY kind", (sid,)).fetchall()
        recent = connection.execute(
            "SELECT kind,tool_id,question_ref,hint_level,evidence_ref FROM events WHERE session_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT 1",
            (sid,),
        ).fetchone()
        sessions.append({"session_id": sid, "started_at": started, "tool_ids": json.loads(tool_ids),
                         "phase": phase, "event_counts": dict(counts),
                         "last_event": dict(zip(("kind", "tool_id", "question_ref", "hint_level", "evidence_ref"), recent)) if recent else None})
    reviews = connection.execute(
        """SELECT tool_id,next_review FROM events WHERE kind='feedback' AND next_review IS NOT NULL ORDER BY recorded_at DESC"""
    ).fetchall()
    latest = {}
    for tool_id, when in reviews:
        latest.setdefault(tool_id, when)
    return {"sessions": sessions, "due_tools": [tool for tool, when in latest.items() if when <= date.today().isoformat()]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="command", required=True)
    start_parser = sub.add_parser("start")
    start_parser.add_argument("--session-id", default="")
    start_parser.add_argument("--tool-id", action="append", required=True)
    record_parser = sub.add_parser("record")
    record_parser.add_argument("--session-id", required=True)
    record_parser.add_argument("--event-id", required=True)
    record_parser.add_argument("--tool-id", required=True)
    record_parser.add_argument("--kind", choices=("prompt", "answer", "feedback", "precommit", "outcome"), required=True)
    record_parser.add_argument("--question-ref")
    record_parser.add_argument("--summary-code", choices=sorted(SUMMARY_CODES), default="unattempted")
    record_parser.add_argument("--hint-level", type=int, choices=range(4), default=0)
    for key in ("mechanism", "recognition", "boundary", "action", "updating"):
        record_parser.add_argument(f"--{key}", choices=sorted(RUBRIC), default="unknown")
    record_parser.add_argument("--evidence-ref")
    record_parser.add_argument("--next-review")
    record_parser.add_argument("--decision-code")
    record_parser.add_argument("--counterevidence-code")
    record_parser.add_argument("--result-code")
    record_parser.add_argument("--provenance", choices=sorted(PROVENANCE), default="observed_practice")
    resume_parser = sub.add_parser("resume")
    resume_parser.add_argument("--session-id")
    summary_parser = sub.add_parser("summary")
    summary_parser.add_argument("--session-id")
    summary_parser.add_argument("--markdown", action="store_true")
    recording_parser = sub.add_parser("set-recording")
    recording_parser.add_argument("--enabled", choices=("on", "off"), required=True)
    args = parser.parse_args()
    connection = None
    try:
        connection = connect(args.db, create=args.command in {"start", "record", "set-recording"})
        if args.command == "start":
            result = start(connection, args)
        elif args.command == "record":
            result = record(connection, args)
        elif args.command == "set-recording":
            with connection:
                connection.execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('recording',?)", (args.enabled,))
            result = {"recording": args.enabled}
        else:
            result = read_summary(connection, args.session_id)
            if args.command == "resume":
                result["sessions"] = result["sessions"][:1]
        if args.command == "summary" and args.markdown:
            print("# 思维工具训练摘要\n")
            for session in result["sessions"]:
                print(f"- {session['started_at']}: {', '.join(session['tool_ids'])}；记录 {sum(session['event_counts'].values())} 条")
            print(f"\n到期复习：{', '.join(result['due_tools']) or '无'}")
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(json.dumps({"saved": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
