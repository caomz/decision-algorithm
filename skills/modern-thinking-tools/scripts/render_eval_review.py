#!/usr/bin/env python3
"""Render a private, dependency-free static review page for skill evals."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_EVALS = ROOT / "skills" / "modern-thinking-tools" / "evals" / "evals.json"
DEFAULT_OUTPUT = ROOT / "tmp" / "modern-thinking-tools" / "eval-review.html"


def render(payload: dict) -> str:
    cards: list[str] = []
    for item in payload.get("evals", []):
        assertions = "".join(
            f"<li><label><input type='checkbox'> {html.escape(str(assertion))}</label></li>"
            for assertion in item.get("assertions", [])
        )
        cards.append(
            "<article>"
            f"<h2>{html.escape(str(item.get('id', 'unnamed')))}</h2>"
            f"<h3>Prompt</h3><pre>{html.escape(str(item.get('prompt', '')))}</pre>"
            f"<h3>Expected</h3><p>{html.escape(str(item.get('expected_output', '')))}</p>"
            f"<h3>Review checklist</h3><ul>{assertions}</ul>"
            "<h3>With Skill output</h3><textarea placeholder='Paste output here'></textarea>"
            "<h3>Without Skill output</h3><textarea placeholder='Paste baseline here'></textarea>"
            "<h3>Reviewer notes</h3><textarea placeholder='Record evidence, defects, and decision'></textarea>"
            "</article>"
        )
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>modern-thinking-tools eval review</title>
<style>
body{{font:16px/1.55 system-ui,sans-serif;max-width:1040px;margin:40px auto;padding:0 20px;background:#f4f5f7;color:#172033}}
header,article{{background:white;border:1px solid #d9dee8;border-radius:12px;padding:24px;margin:18px 0}}
h1,h2,h3{{line-height:1.25}} pre{{white-space:pre-wrap;background:#f7f8fa;padding:14px;border-radius:8px}}
textarea{{box-sizing:border-box;width:100%;min-height:140px;border:1px solid #c9d1de;border-radius:8px;padding:12px}}
li{{margin:8px 0}} .note{{color:#5a6475}}
</style></head><body>
<header><h1>modern-thinking-tools 静态评审</h1>
<p class="note">私有本地页面。顺序比较有 Skill 与无 Skill 输出，重点检查 GetNote evidence、3+1 工具合同、行动与停止条件。</p></header>
{''.join(cards)}
</body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evals", type=Path, default=DEFAULT_EVALS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    payload = json.loads(args.evals.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(render(payload), encoding="utf-8")
    args.output.chmod(0o600)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
