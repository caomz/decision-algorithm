#!/usr/bin/env python3
"""
Decision Calculator - 期望值与凯利公式计算器

用法：
    python decision_calculator.py --ev -p 0.3 -g 100000 -l 20000
    python decision_calculator.py --kelly -p 0.4 -o 3
    python decision_calculator.py --full -p 0.3 -g 100000 -l 20000 --capital 500000

非法输入（缺失字段、非数值、非有限数值、除数为 0 等）会得到可读的错误信息，
并以非 0 退出码结束，而不是抛出未捕获异常。
"""

from __future__ import annotations

import argparse
import math
import sys


def _validate_probability(probability: float) -> None:
    """胜率必须是 [0, 1] 内的有限数值。"""
    if not math.isfinite(probability):
        raise ValueError(f"胜率必须是有限数值，当前为 {probability!r}")
    if not 0 <= probability <= 1:
        raise ValueError(f"胜率必须在 0-1 之间，当前为 {probability!r}")


def _validate_finite(name: str, value: float) -> None:
    """金额与赔率必须是有限数值（拒绝 nan / inf）。"""
    if not math.isfinite(value):
        raise ValueError(f"{name}必须是有限数值，当前为 {value!r}")


def _validate_positive(name: str, value: float) -> None:
    """作为除数或赔率分子的金额必须大于 0（前置校验需先排除 nan）。"""
    if value <= 0:
        raise ValueError(f"{name}必须大于 0，当前为 {value!r}")


def _finite_float(text: str) -> float:
    """argparse 数值类型：拒绝无法解析或非有限的输入（含 nan / inf）。"""
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"不是有效的数值：{text!r}") from None
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError(f"必须是有限数值，当前为 {text!r}")
    return value


def calculate_expected_value(probability: float, gain: float, loss: float) -> float:
    """计算期望值: EV = p * gain - (1-p) * loss"""
    _validate_probability(probability)
    _validate_finite("收益金额", gain)
    _validate_finite("损失金额", loss)
    return probability * gain - (1 - probability) * loss


def calculate_kelly(probability: float, odds: float) -> float:
    """计算凯利公式: f* = (p*b - q) / b"""
    _validate_probability(probability)
    _validate_finite("赔率", odds)
    _validate_positive("赔率", odds)  # odds 是除数，<= 0 会除零或产生无意义结果
    q = 1 - probability
    return (probability * odds - q) / odds


def analyze_decision(
    probability: float,
    gain: float,
    loss: float,
    capital: float | None = None,
    conservative: bool = False,
    very_conservative: bool = False,
) -> dict:
    """完整决策分析"""
    _validate_probability(probability)
    _validate_finite("收益金额", gain)
    _validate_finite("损失金额", loss)
    _validate_positive("收益金额", gain)  # 收益是赔率的分子，必须为正
    _validate_positive("损失金额", loss)  # 损失是计算赔率的除数
    if capital is not None:
        _validate_finite("总资金", capital)
        if capital < 0:
            raise ValueError(f"总资金不能为负数，当前为 {capital!r}")

    ev = calculate_expected_value(probability, gain, loss)
    odds = gain / loss
    kelly = calculate_kelly(probability, odds)

    # 保守策略调整
    if very_conservative:
        kelly *= 0.25
        strategy = "极保守（凯利的1/4）"
    elif conservative:
        kelly *= 0.5
        strategy = "保守（凯利的1/2）"
    else:
        strategy = "标准凯利"

    # 确保凯利比例在合理范围内
    kelly = max(0, min(kelly, 1))

    result = {
        "ev": ev,
        "ev_positive": ev > 0,
        "odds": odds,
        "kelly_fraction": kelly,
        "strategy": strategy,
        "recommendation": "",
    }

    if capital is not None:
        result["suggested_investment"] = capital * kelly

    # 生成建议
    if ev <= 0:
        result["recommendation"] = "负期望值，不建议参与"
    elif kelly <= 0:
        result["recommendation"] = "凯利公式建议不下注（胜率过低或赔率不佳）"
    elif kelly < 0.05:
        result["recommendation"] = "极小仓位试探（<5%）"
    elif kelly < 0.2:
        result["recommendation"] = "轻仓参与（5-20%）"
    elif kelly < 0.4:
        result["recommendation"] = "适中仓位（20-40%）"
    else:
        result["recommendation"] = "可重仓但永远不要All in"

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="决策计算器")
    parser.add_argument("--ev", action="store_true", help="仅计算期望值")
    parser.add_argument("--kelly", action="store_true", help="仅计算凯利公式")
    parser.add_argument("--full", action="store_true", help="完整分析")
    parser.add_argument("-p", "--probability", type=_finite_float, required=True, help="胜率 (0-1)")
    parser.add_argument("-g", "--gain", type=_finite_float, help="收益金额")
    parser.add_argument("-l", "--loss", type=_finite_float, help="损失金额")
    parser.add_argument("-o", "--odds", type=_finite_float, help="赔率（赢/亏比）")
    parser.add_argument("--capital", type=_finite_float, help="总资金")
    parser.add_argument("--conservative", action="store_true", help="使用凯利的一半")
    parser.add_argument("--very-conservative", action="store_true", help="使用凯利的1/4")

    args = parser.parse_args()

    try:
        _validate_probability(args.probability)
        if args.capital is not None and args.capital < 0:
            raise ValueError(f"总资金不能为负数，当前为 {args.capital!r}")

        # 期望值计算
        if args.ev or args.full:
            if args.gain is None or args.loss is None:
                print("错误：计算期望值需要 --gain 和 --loss", file=sys.stderr)
                return 1
            ev = calculate_expected_value(args.probability, args.gain, args.loss)
            print(f"期望值 (EV): {ev:,.2f}")
            print(f"  胜率: {args.probability*100:.1f}%")
            print(f"  收益: {args.gain:,.2f}")
            print(f"  损失: {args.loss:,.2f}")
            print(f"  判断: {'正期望值' if ev > 0 else '负期望值'}")
            print()

        # 凯利公式计算
        if args.kelly or args.full:
            if args.odds is not None:
                odds = args.odds
            elif args.gain is None or args.loss is None:
                print("错误：计算凯利公式需要 --odds 或 --gain 和 --loss", file=sys.stderr)
                return 1
            else:
                _validate_positive("收益金额", args.gain)
                _validate_positive("损失金额", args.loss)
                odds = args.gain / args.loss
            kelly = calculate_kelly(args.probability, odds)
            print(f"凯利公式 (f*): {kelly:.4f} ({kelly*100:.2f}%)")
            print(f"  胜率: {args.probability*100:.1f}%")
            print(f"  赔率: {odds:.2f}")
            if args.capital is not None:
                print(f"  建议投入: {args.capital * kelly:,.2f}")
            print()

        # 完整分析
        if args.full:
            if args.gain is None or args.loss is None:
                print("错误：完整分析需要 --gain 和 --loss", file=sys.stderr)
                return 1

            result = analyze_decision(
                probability=args.probability,
                gain=args.gain,
                loss=args.loss,
                capital=args.capital,
                conservative=args.conservative,
                very_conservative=args.very_conservative,
            )

            print("=" * 40)
            print("决策分析报告")
            print("=" * 40)
            print(f"期望值: {result['ev']:,.2f} ({'正' if result['ev_positive'] else '负'})")
            print(f"赔率: {result['odds']:.2f}")
            print(f"凯利比例: {result['kelly_fraction']*100:.2f}% ({result['strategy']})")
            if args.capital is not None:
                print(f"建议投入: {result['suggested_investment']:,.2f}")
            print(f"建议: {result['recommendation']}")
            print("=" * 40)
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
