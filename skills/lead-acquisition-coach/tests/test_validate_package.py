"""skills/lead-acquisition-coach/scripts/validate_package.py 的回归测试。

正向路径直接对真实包做只读校验；负向路径在临时目录构造包副本，
不改动真实包内容。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
SCRIPT = PACKAGE / "scripts" / "validate_package.py"


def run_validator(script: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script)], text=True, capture_output=True, check=False,
    )


def _copy_package(tmp_path: Path) -> Path:
    """把整个包复制到临时目录，返回副本里的校验脚本路径。"""
    dest = tmp_path / "lead-acquisition-coach"
    shutil.copytree(PACKAGE, dest, ignore=shutil.ignore_patterns("__pycache__"))
    return dest / "scripts" / "validate_package.py"


def test_current_package_passes() -> None:
    result = run_validator(SCRIPT)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "RESULT: structural/source checks passed" in result.stdout
    assert "FAIL:" not in result.stdout


def test_missing_required_file_fails_in_temp_copy(tmp_path: Path) -> None:
    script = _copy_package(tmp_path)
    (script.parents[1] / "SKILL.md").unlink()
    result = run_validator(script)
    assert result.returncode == 1
    assert "FAIL: Missing/empty required file: SKILL.md" in result.stdout
