"""Tests for the decision calculator's input validation.

opt-02 acceptance: zero divisors and illegal inputs (missing fields,
non-numeric or non-finite values) fail with a readable error and a non-zero
exit instead of an uncaught traceback — both as a library API and when the
calculator is run directly.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "skills" / "decision-algorithm" / "tools" / "decision_calculator.py"
)
SPEC = importlib.util.spec_from_file_location("decision_calculator", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    """Run the calculator directly, the way a user would."""
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------------------
# Library-level validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("odds", [0, -1, float("nan"), float("inf")])
def test_calculate_kelly_rejects_zero_and_illegal_odds(odds: float) -> None:
    # odds is the divisor in f* = (p*b - q) / b, so 0 used to raise
    # ZeroDivisionError and negatives/nan produced meaningless results.
    with pytest.raises(ValueError, match="赔率"):
        MODULE.calculate_kelly(0.5, odds)


@pytest.mark.parametrize("probability", [-0.1, 1.5, float("nan"), float("inf")])
def test_calculators_reject_probability_out_of_range(probability: float) -> None:
    with pytest.raises(ValueError, match="胜率"):
        MODULE.calculate_expected_value(probability, 100, 50)
    with pytest.raises(ValueError, match="胜率"):
        MODULE.calculate_kelly(probability, 2)
    with pytest.raises(ValueError, match="胜率"):
        MODULE.analyze_decision(probability, 100, 50)


def test_calculate_expected_value_rejects_nonfinite_amounts() -> None:
    with pytest.raises(ValueError, match="收益金额"):
        MODULE.calculate_expected_value(0.5, float("nan"), 100)
    with pytest.raises(ValueError, match="损失金额"):
        MODULE.calculate_expected_value(0.5, 100, float("inf"))


def test_analyze_decision_rejects_zero_gain_and_zero_loss() -> None:
    # gain=0 made odds=0 hit the division inside calculate_kelly;
    # loss=0 produced odds=inf and a nan-derived kelly of 0.
    with pytest.raises(ValueError, match="收益金额"):
        MODULE.analyze_decision(0.5, 0, 100)
    with pytest.raises(ValueError, match="损失金额"):
        MODULE.analyze_decision(0.5, 100, 0)


def test_analyze_decision_rejects_nonfinite_and_negative_capital() -> None:
    with pytest.raises(ValueError, match="总资金"):
        MODULE.analyze_decision(0.5, 100, 50, capital=float("nan"))
    with pytest.raises(ValueError, match="总资金"):
        MODULE.analyze_decision(0.5, 100, 50, capital=-1)


def test_analyze_decision_reports_suggested_investment_for_zero_capital() -> None:
    # capital=0 used to be falsy, so "suggested_investment" was missing from
    # the result dict and library callers hit a KeyError.
    result = MODULE.analyze_decision(0.5, 100, 50, capital=0)
    assert result["suggested_investment"] == 0


def test_analyze_decision_valid_input_still_works() -> None:
    result = MODULE.analyze_decision(0.3, 100000, 20000, capital=500000)
    assert result["ev"] == pytest.approx(16000)
    assert result["odds"] == pytest.approx(5)
    assert result["kelly_fraction"] == pytest.approx(0.16)
    assert result["suggested_investment"] == pytest.approx(80000)


# ---------------------------------------------------------------------------
# CLI: illegal inputs must exit non-zero with a readable error, no traceback
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("args", [
    # --odds satisfied the kelly section while analyze_decision still derived
    # odds=0 from gain/loss: an uncaught ZeroDivisionError before the fix.
    ("--full", "-p", "0.5", "-o", "3", "-g", "0", "-l", "100"),
    ("--full", "-p", "0.5", "-o", "3", "-g", "100", "-l", "0"),
    ("--full", "-p", "0.5", "-g", "-100", "-l", "100"),
    ("--kelly", "-p", "0.4", "-o", "0"),
    ("--kelly", "-p", "0.4", "-o", "-1"),
    ("--kelly", "-p", "0.4", "-g", "0", "-l", "100"),
    ("--kelly", "-p", "0.4", "-g", "100", "-l", "0"),
    ("--kelly", "-p", "0.4"),
    ("--ev", "-p", "0.3"),
])
def test_cli_illegal_inputs_exit_nonzero_without_traceback(args: tuple[str, ...]) -> None:
    proc = run_cli(*args)
    assert proc.returncode != 0
    assert "Traceback" not in proc.stderr
    assert "错误：" in proc.stderr


@pytest.mark.parametrize("args,expected", [
    (("-p", "abc", "--kelly", "-o", "3"), "不是有效的数值"),
    (("-p", "nan", "--kelly", "-o", "3"), "有限数值"),
    (("-p", "inf", "--kelly", "-o", "3"), "有限数值"),
    (("-p", "0.4", "--kelly", "-o", "nan"), "有限数值"),
    (("-p", "0.4", "--kelly", "-o", "3", "--capital", "inf"), "有限数值"),
    (("-p", "0.4", "--ev", "-g", "abc", "-l", "100"), "不是有效的数值"),
])
def test_cli_non_numeric_and_nonfinite_inputs_are_rejected(
    args: tuple[str, ...], expected: str
) -> None:
    proc = run_cli(*args)
    assert proc.returncode != 0
    assert "Traceback" not in proc.stderr
    assert expected in proc.stderr


def test_cli_probability_out_of_range_is_rejected() -> None:
    proc = run_cli("-p", "1.5", "--kelly", "-o", "3")
    assert proc.returncode == 1
    assert "胜率必须在 0-1 之间" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_negative_capital_is_rejected() -> None:
    proc = run_cli("--full", "-p", "0.3", "-g", "100000", "-l", "20000", "--capital", "-5")
    assert proc.returncode == 1
    assert "总资金不能为负数" in proc.stderr
    assert "Traceback" not in proc.stderr


# ---------------------------------------------------------------------------
# CLI: documented success paths stay intact
# ---------------------------------------------------------------------------


def test_cli_ev_success() -> None:
    proc = run_cli("--ev", "-p", "0.3", "-g", "100000", "-l", "20000")
    assert proc.returncode == 0
    assert "期望值 (EV): 16,000.00" in proc.stdout


def test_cli_kelly_success() -> None:
    proc = run_cli("--kelly", "-p", "0.4", "-o", "3")
    assert proc.returncode == 0
    assert "凯利公式 (f*): 0.2000 (20.00%)" in proc.stdout


def test_cli_full_success_with_capital() -> None:
    proc = run_cli("--full", "-p", "0.3", "-g", "100000", "-l", "20000", "--capital", "500000")
    assert proc.returncode == 0
    assert "决策分析报告" in proc.stdout
    assert "赔率: 5.00" in proc.stdout
    assert "凯利比例: 16.00%" in proc.stdout
    assert "建议投入: 80,000.00" in proc.stdout


def test_cli_full_zero_capital_still_reports_suggestion() -> None:
    proc = run_cli("--full", "-p", "0.3", "-g", "100000", "-l", "20000", "--capital", "0")
    assert proc.returncode == 0
    assert "建议投入: 0.00" in proc.stdout
