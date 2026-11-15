from __future__ import annotations

import importlib.util
import json
import multiprocessing
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "training_record.py"
SPEC = importlib.util.spec_from_file_location("training_record", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def run(db: Path, *args: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--db", str(db), *args],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _write(db: str, event_id: str) -> None:
    subprocess.run(
        [sys.executable, str(SCRIPT), "--db", db, "record", "--session-id", "s1",
         "--event-id", event_id, "--tool-id", "T025", "--kind", "answer",
         "--summary-code", "attempt_pending_review"],
        check=True, capture_output=True, text=True,
    )


def test_private_record_retry_pause_resume_and_markdown(tmp_path: Path) -> None:
    db = tmp_path / "private" / "training.sqlite3"
    started = run(db, "start", "--session-id", "s1", "--tool-id", "T025")
    assert started["saved"] is True
    assert db.stat().st_mode & 0o077 == 0
    run(db, "record", "--session-id", "s1", "--event-id", "answer1", "--tool-id", "T025",
        "--kind", "answer", "--question-ref", "case_01", "--summary-code", "attempt_pending_review")
    args = ("record", "--session-id", "s1", "--event-id", "evt1", "--tool-id", "T025",
            "--kind", "feedback", "--question-ref", "case_01", "--summary-code", "mechanism_clear", "--boundary", "supported")
    assert run(db, *args)["next_review"] is not None
    assert run(db, *args)["duplicate"] is True
    assert run(db, "resume")["sessions"][0]["event_counts"] == {"answer": 1, "feedback": 1}
    assert run(db, "set-recording", "--enabled", "off")["recording"] == "off"
    assert run(db, "record", "--session-id", "s1", "--event-id", "evt2", "--tool-id", "T025", "--kind", "answer")["saved"] is False
    assert run(db, "resume")["sessions"][0]["event_counts"] == {"answer": 1, "feedback": 1}


def test_precommit_is_immutable_and_rejects_raw_private_text(tmp_path: Path) -> None:
    db = tmp_path / "private" / "training.sqlite3"
    run(db, "start", "--session-id", "s1", "--tool-id", "T025")
    precommit = ("record", "--session-id", "s1", "--event-id", "pre1", "--tool-id", "T025",
                 "--kind", "precommit", "--question-ref", "case_01",
                 "--decision-code", "small_test", "--counterevidence-code", "no_feedback")
    assert run(db, *precommit)["saved"]
    assert run(db, "record", "--session-id", "s1", "--event-id", "out1", "--tool-id", "T025",
               "--kind", "outcome", "--question-ref", "case_01",
               "--result-code", "observed_no_feedback")["saved"]
    assert run(db, *precommit)["duplicate"] is True
    different = subprocess.run(
        [sys.executable, str(SCRIPT), "--db", str(db), "record", "--session-id", "s1",
         "--event-id", "pre1", "--tool-id", "T025", "--kind", "precommit", "--question-ref", "case_01",
         "--decision-code", "different_test", "--counterevidence-code", "no_feedback"],
        capture_output=True, text=True,
    )
    assert different.returncode == 2
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--db", str(db), "record", "--session-id", "s1",
         "--event-id", "raw", "--tool-id", "T025", "--kind", "answer", "--question-ref", "私密姓名"],
        text=True, capture_output=True,
    )
    assert result.returncode == 2
    assert "私密姓名" not in db.read_bytes().decode("latin-1", errors="ignore")


def test_concurrent_hosts_keep_all_events(tmp_path: Path) -> None:
    db = tmp_path / "private" / "training.sqlite3"
    run(db, "start", "--session-id", "s1", "--tool-id", "T025")
    workers = [multiprocessing.Process(target=_write, args=(str(db), f"host{i}")) for i in range(6)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=15)
        assert worker.exitcode == 0
    assert run(db, "resume", "--session-id", "s1")["sessions"][0]["event_counts"] == {"answer": 6}


def test_missing_or_damaged_database_is_reported(tmp_path: Path) -> None:
    db = tmp_path / "private" / "training.sqlite3"
    assert run(db, "resume")["sessions"] == []
    db.parent.mkdir(mode=0o700)
    db.write_text("not a database", encoding="utf-8")
    result = subprocess.run([sys.executable, str(SCRIPT), "--db", str(db), "start", "--session-id", "s1", "--tool-id", "T025"], capture_output=True, text=True)
    assert result.returncode == 2
    assert "saved" in result.stderr
