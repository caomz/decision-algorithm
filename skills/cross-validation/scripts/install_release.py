"""Prepare and apply a file-by-file release against a before-edit snapshot."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path

from install_guard import MARKER, REQUIRED, SKILLS, checked_path, digest, release_id, verify_install


SOURCE = Path(__file__).resolve().parents[2]


def file_hash(path: Path) -> str | None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f"unsafe target: {path}")
    return digest(path.read_bytes()) if path.is_file() else None


def write_atomic(path: Path, data: bytes, mode: int, expected: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".gstack-stage-", delete=False) as pending:
        os.fchmod(pending.fileno(), mode)
        pending.write(data)
        pending.flush()
        os.fsync(pending.fileno())
    if file_hash(path) != expected:
        raise ValueError(f"concurrent change before replacement: {path}")
    os.replace(pending.name, path)


def write_json(path: Path, data: dict, expected: str | None) -> None:
    write_atomic(path, (json.dumps(data, indent=2, sort_keys=True) + "\n").encode(), 0o600, expected)


def source_files() -> dict[str, str]:
    files = {}
    for name in sorted(SKILLS):
        skill = SOURCE / name
        for path in sorted(skill.rglob("*")):
            if path.suffix not in {".md", ".py", ".js", ".json", ".yaml"} or not path.is_file():
                continue
            relative = path.relative_to(SOURCE).as_posix()
            files[relative] = digest(checked_path(SOURCE, relative).read_bytes())
    if not REQUIRED.issubset(files):
        raise ValueError("candidate is missing a required release file")
    return files


def plan(root: Path, backup: Path, manifest: dict) -> dict:
    baseline = json.loads((backup / "before.json").read_text())
    entries = []
    for relative, new_hash in sorted(manifest["files"].items()):
        dest = checked_path(root, relative)
        original = baseline.get(str(dest))
        old_hash = original["sha256"] if original else None
        if original:
            stored = Path(original["backup"]).resolve()
            stored.relative_to(backup)
            if file_hash(stored) != old_hash:
                raise ValueError(f"snapshot mismatch: {relative}")
        if file_hash(dest) not in (old_hash, new_hash):
            raise ValueError(f"target changed since backup: {relative}")
        entries.append({
            "relative": relative, "before": old_hash, "after": new_hash,
            "backup": original["backup"] if original else None,
        })
    return {"install_root": str(root), "release_id": manifest["release_id"], "entries": entries}


def current_marker(path: Path) -> tuple[str | None, dict]:
    current_hash = file_hash(path)
    if current_hash is None:
        return None, {}
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get("format") != 1:
        raise ValueError("unknown existing release marker")
    return current_hash, value


def apply(root: Path, backup: Path, manifest: dict) -> None:
    record_path = backup / "release-plan.json"
    marker = root / MARKER
    marker_hash, previous = current_marker(marker)
    if previous and previous.get("release_id") != manifest["release_id"] and previous.get("state") != "active":
        raise ValueError("another release is incomplete")
    record = plan(root, backup, manifest)
    if record_path.exists():
        stored = json.loads(record_path.read_text())
        if any(stored[key] != record[key] for key in record):
            raise ValueError("saved release plan differs from current candidate")
    else:
        if previous and previous.get("state") != "active":
            raise ValueError("incomplete release has no matching snapshot")
        record["previous_manifest"] = previous
        write_json(record_path, record, None)
    if previous.get("state") == "active" and previous.get("release_id") == manifest["release_id"]:
        verify_install(root / "cross-validation", required=True)
        return
    write_json(marker, {**manifest, "state": "installing"}, marker_hash)
    installing_hash = file_hash(marker)
    for item in record["entries"]:
        relative = item["relative"]
        dest = checked_path(root, relative)
        observed = file_hash(dest)
        if observed == item["after"]:
            continue
        if observed != item["before"]:
            raise ValueError(f"concurrent change during installation: {relative}")
        source = checked_path(SOURCE, relative)
        data = source.read_bytes()
        if digest(data) != item["after"]:
            raise ValueError(f"candidate changed during installation: {relative}")
        write_atomic(dest, data, source.stat().st_mode & 0o777, observed)
    for relative, expected in manifest["files"].items():
        if file_hash(checked_path(root, relative)) != expected:
            raise ValueError(f"installed file verification failed: {relative}")
    write_json(marker, manifest, installing_hash)
    verify_install(root / "cross-validation", required=True)


def restore(root: Path, backup: Path) -> None:
    record = json.loads((backup / "release-plan.json").read_text())
    marker = root / MARKER
    marker_hash, current = current_marker(marker)
    if str(root) != record["install_root"] or current.get("release_id") != record["release_id"]:
        raise ValueError("snapshot does not match the installed release")
    for item in record["entries"]:
        target = checked_path(root, item["relative"])
        if file_hash(target) not in (item["before"], item["after"]):
            raise ValueError(f"target changed since install: {item['relative']}")
        if item["before"]:
            stored = Path(item["backup"]).resolve()
            stored.relative_to(backup)
            if file_hash(stored) != item["before"]:
                raise ValueError(f"snapshot mismatch: {item['relative']}")
    write_json(marker, {**current, "state": "restoring"}, marker_hash)
    restoring_hash = file_hash(marker)
    for item in record["entries"]:
        if item["before"] is None:
            continue
        target = checked_path(root, item["relative"])
        observed = file_hash(target)
        if observed == item["after"] and observed != item["before"]:
            stored = Path(item["backup"])
            write_atomic(target, stored.read_bytes(), stored.stat().st_mode & 0o777, observed)
        elif observed != item["before"]:
            raise ValueError(f"target changed during restoration: {item['relative']}")
    previous = record["previous_manifest"]
    write_json(marker, previous or {**current, "state": "restored"}, restoring_hash)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-root", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    try:
        root = args.install_root.resolve(strict=True)
        backup = args.snapshot.resolve(strict=True)
        if not root.is_dir() or not backup.is_dir() or root == SOURCE:
            raise ValueError("expected separate existing installation and snapshot directories")
        files = {} if args.restore else source_files()
        manifest = {"format": 1, "state": "active", "release_id": release_id(files), "files": files}
        if args.dry_run:
            print(json.dumps(plan(root, backup, manifest), indent=2))
            return 0
        lock_path = root / ".gstack-cross-validation-install.lock"
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.restore:
                restore(root, backup)
            else:
                apply(root, backup, manifest)
        print(json.dumps({"state": "restored" if args.restore else "active",
                          "release_id": None if args.restore else manifest["release_id"]}))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"release operation stopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
