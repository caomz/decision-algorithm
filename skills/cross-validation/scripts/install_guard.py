"""Verify the local AGY/MMX release shared by the installed skills."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath


MARKER = ".gstack-cross-validation-release.json"
MMX_MARKER = ".mmx-release.json"
SKILLS = {"agy", "mmx", "cross-validation"}
MMX_REQUIRED = {
    "SKILL.md",
    "scripts/mmx-chat.js",
    "scripts/mmx-run.js",
    "scripts/mmx-slots.js",
    "scripts/local-process.js",
    "scripts/review.js",
    "scripts/fetch-timeout-guard.js",
    "profiles/local.json",
    "profiles/review-long.json",
    "references/review-v1.schema.json",
}
AGY_REQUIRED = {
    "agy/SKILL.md",
    "agy/scripts/agy_runner.py",
    "agy/references/review-v1.schema.json",
    "cross-validation/scripts/install_guard.py",
}
SHARED_REQUIRED = AGY_REQUIRED | {
    "cross-validation/SKILL.md",
    "cross-validation/scripts/cross_validate.py",
    "cross-validation/scripts/review_protocol.py",
}
REQUIRED = SHARED_REQUIRED | {
    f"mmx/{MMX_MARKER}",
    *(f"mmx/{name}" for name in MMX_REQUIRED),
}
MAC_REQUIRED = SHARED_REQUIRED | {
    "mmx/SKILL.md",
    "mmx/scripts/mmx-chat.js",
    "mmx/scripts/mmx-batch.js",
    "mmx/scripts/mmx-job.js",
    "mmx/scripts/mmx-provider-slot.js",
    "mmx/scripts/mmx-native-budget.js",
    "mmx/scripts/fetch-timeout-guard.js",
    "mmx/profiles/local.json",
    "mmx/references/review-v1.schema.json",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def release_id(files: dict[str, str]) -> str:
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode("ascii"))


def checked_path(root: Path, relative: str) -> Path:
    path = PurePosixPath(relative)
    if (path.is_absolute() or len(path.parts) < 2 or path.parts[0] not in SKILLS
            or ".." in path.parts or path.as_posix() != relative
            or not re.fullmatch(r"[a-zA-Z0-9_./-]+", relative)):
        raise ValueError("unsafe managed file path")
    target = root
    for part in path.parts:
        target /= part
        if target.is_symlink():
            raise ValueError("managed release contains a symbolic link")
    return target


def verify_mmx_release(root: Path) -> str:
    """当联合清单中的 mmx 条目因独立升级漂移时，按严格规则校验 mmx/.mmx-release.json。"""
    marker = checked_path(root, f"mmx/{MMX_MARKER}")
    if marker.is_symlink() or not marker.is_file():
        raise ValueError("mmx release marker missing or unsafe")
    snapshot = marker.read_bytes()
    manifest = json.loads(snapshot)
    if (not isinstance(manifest, dict) or type(manifest.get("format")) is not int
            or manifest["format"] != 1
            or ("state" in manifest and manifest.get("state") != "active")):
        raise ValueError("mmx release is not active")
    files = manifest.get("files")
    if not isinstance(files, dict) or not MMX_REQUIRED.issubset(files):
        raise ValueError("mmx release manifest is incomplete")
    for relative, expected in files.items():
        if not isinstance(relative, str) or not relative or relative.startswith("/"):
            raise ValueError("unsafe mmx managed file path")
        target = checked_path(root, f"mmx/{relative}")
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError("invalid mmx release fingerprint")
        if not target.is_file() or digest(target.read_bytes()) != expected:
            raise ValueError(f"mmx managed file mismatch: {relative}")
    if marker.read_bytes() != snapshot:
        raise ValueError("mmx release marker changed during verification")
    return release_id(files)


def verify_install(skill_root: Path, *, required: bool = False, agy_only: bool = False) -> str | None:
    root = skill_root.resolve().parent
    marker = root / MARKER
    if not marker.exists() and not marker.is_symlink() and not required:
        return None
    try:
        if marker.is_symlink() or not marker.is_file():
            raise ValueError("release marker missing or unsafe")
        snapshot = marker.read_bytes()
        manifest = json.loads(snapshot)
        if (not isinstance(manifest, dict) or type(manifest.get("format")) is not int
                or manifest["format"] != 1 or manifest.get("state") != "active"):
            raise ValueError("release is not active")
        files = manifest.get("files")
        if not isinstance(files, dict):
            raise ValueError("release manifest is incomplete")
        legacy = REQUIRED.issubset(files)
        if not (AGY_REQUIRED.issubset(files) if agy_only else legacy or MAC_REQUIRED.issubset(files)):
            raise ValueError("release manifest is incomplete")
        release = release_id(files)
        if manifest.get("release_id") != release:
            raise ValueError("release inventory digest differs")
        mmx_override: str | None = None
        for relative, expected in files.items():
            if agy_only and not (relative.startswith("agy/") or relative in AGY_REQUIRED):
                continue
            target = checked_path(root, relative)
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                raise ValueError("invalid release fingerprint")
            if not target.is_file() or digest(target.read_bytes()) != expected:
                # 若 mmx 独立更新导致与联合清单不一致，回退校验受管的 mmx/.mmx-release.json
                if legacy and relative.startswith("mmx/"):
                    if mmx_override is None:
                        mmx_override = verify_mmx_release(root)
                    continue
                raise ValueError(f"managed file mismatch: {relative}")
        if marker.read_bytes() != snapshot:
            raise ValueError("release marker changed during verification")
        return digest(f"{release}:{mmx_override}".encode("ascii")) if mmx_override else release
    except (OSError, UnicodeError, TypeError) as exc:
        raise ValueError("could not verify managed release") from exc


if __name__ == "__main__":
    try:
        args = sys.argv[1:]
        agy_only = args[:1] == ["--agy-only"]
        if agy_only:
            args = args[1:]
        if len(args) != 1 or (agy_only and Path(args[0]).name != "agy"):
            raise ValueError("expected the installed skill directory")
        verify_install(Path(args[0]), required=True, agy_only=agy_only)
    except ValueError:
        sys.exit("INSTALL_MISMATCH")
