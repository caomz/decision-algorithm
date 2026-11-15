#!/usr/bin/env python3
"""
Decision Calculator - 期望值与凯利公式计算器

用法：
    python decision_calculator.py --ev -p 0.3 -g 100000 -l 20000
    python decision_calculator.py --kelly -p 0.4 -o 3
    python decision_calculator.py --full -p 0.3 -g 100000 -l 20000 --capital 500000
"""

from __future__ import annotations

import argparse
import sys


def calculate_expected_value(probability: float, gain: float, loss: float) -> float:
    """计算期望值: EV = p * gain - (1-p) * loss"""
    return probability * gain - (1 - probability) * loss


def calculate_kelly(probability: float, odds: float) -> float:
    """计算凯利公式: f* = (p*b - q) / b"""
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
    ev = calculate_expected_value(probability, gain, loss)
    odds = gain / loss if loss > 0 else float("inf")
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

    if capital:
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
    parser.add_argument("-p", "--probability", type=float, required=True, help="胜率 (0-1)")
    parser.add_argument("-g", "--gain", type=float, help="收益金额")
    parser.add_argument("-l", "--loss", type=float, help="损失金额")
    parser.add_argument("-o", "--odds", type=float, help="赔率（赢/亏比）")
    parser.add_argument("--capital", type=float, help="总资金")
    parser.add_argument("--conservative", action="store_true", help="使用凯利的一半")
    parser.add_argument("--very-conservative", action="store_true", help="使用凯利的1/4")

    args = parser.parse_args()

    if args.probability < 0 or args.probability > 1:
        print("错误：胜率必须在 0-1 之间", file=sys.stderr)
        return 1

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
        if args.odds:
            odds = args.odds
        elif args.gain and args.loss and args.loss > 0:
            odds = args.gain / args.loss
        else:
            print("错误：计算凯利公式需要 --odds 或 --gain 和 --loss", file=sys.stderr)
            return 1

        kelly = calculate_kelly(args.probability, odds)
        print(f"凯利公式 (f*): {kelly:.4f} ({kelly*100:.2f}%)")
        print(f"  胜率: {args.probability*100:.1f}%")
        print(f"  赔率: {odds:.2f}")
        if args.capital:
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
        if args.capital:
            print(f"建议投入: {result['suggested_investment']:,.2f}")
        print(f"建议: {result['recommendation']}")
        print("=" * 40)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
