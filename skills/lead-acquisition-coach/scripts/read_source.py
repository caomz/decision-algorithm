#!/usr/bin/env python3
"""Locate exact passages in the bundled course notes. No external packages needed."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'sources' / 'course-notes.md'
MANIFEST = ROOT / 'sources' / 'source-manifest.json'


def section_ranges(lines: list[str]) -> list[tuple[int, int, str]]:
    heads = [(i, line[2:]) for i, line in enumerate(lines, 1)
             if re.match(r'^# [一二三四五六七八九十]+、', line)]
    end_after_sections = next((i - 1 for i, line in enumerate(lines, 1)
                               if line == '# 核心要点提炼'), len(lines))
    return [(start, heads[j + 1][0] - 1 if j + 1 < len(heads)
             else end_after_sections, title)
            for j, (start, title) in enumerate(heads)]


def emit(lines: list[str], ranges: list[tuple[int, int]], cap: int) -> None:
    used = 0
    for start, end in ranges:
        heading = f'\n--- 原稿 L{start}–L{end} ---\n'
        print(heading, end='')
        used += len(heading)
        for i in range(start, end + 1):
            out = f'L{i}: {lines[i - 1]}\n'
            if used + len(out) > cap:
                print(f'\n[已达输出字符上限；未显示部分从 L{i} 起。'
                      f'可用 --lines {i}:{end} 继续读取。]')
                return
            print(out, end='')
            used += len(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--index', action='store_true', help='List the 14 source sections.')
    group.add_argument('--verify', action='store_true', help='Verify source SHA-256 and length.')
    group.add_argument('--lines', metavar='START:END', help='Read an inclusive original line range.')
    group.add_argument('--section', type=int, help='Read a section, numbered 1 through 14.')
    group.add_argument('--search', metavar='TEXT', help='Find literal text, not a regular expression.')
    parser.add_argument('--context', type=int, default=2, help='Context lines per search hit (0–50).')
    parser.add_argument('--limit', type=int, default=5, help='Maximum matching passages (1–30).')
    parser.add_argument('--max-chars', type=int, default=12000, help='Maximum emitted passage characters.')
    args = parser.parse_args()
    if not 0 <= args.context <= 50 or not 1 <= args.limit <= 30:
        parser.error('--context must be 0–50 and --limit must be 1–30.')
    if args.max_chars < 500:
        parser.error('--max-chars must be at least 500.')
    try:
        raw = SOURCE.read_bytes()
        lines = raw.decode('utf-8-sig').splitlines()
    except (OSError, UnicodeError) as exc:
        print(f'无法读取原稿：{exc}', file=sys.stderr)
        return 1
    if args.verify:
        try:
            expected = json.loads(MANIFEST.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as exc:
            print(f'无法读取来源清单：{exc}', file=sys.stderr)
            return 1
        actual = hashlib.sha256(raw).hexdigest()
        ok = (actual == expected.get('sha256') and len(raw) == expected.get('bytes')
              and len(lines) == expected.get('lines'))
        print(f'SHA-256: {actual}\n字节数: {len(raw)}\n行数: {len(lines)}')
        print('核对通过：与本包保留的上传源文件清单一致。' if ok else '核对失败：原稿或清单已变化。')
        return 0 if ok else 1
    if args.lines:
        match = re.fullmatch(r'(\d+):(\d+)', args.lines)
        if not match:
            parser.error('--lines must have the form START:END, e.g. 1980:1998.')
        start, end = map(int, match.groups())
        if not 1 <= start <= end <= len(lines):
            parser.error(f'Line range must satisfy 1 <= START <= END <= {len(lines)}.')
        emit(lines, [(start, end)], args.max_chars)
        return 0
    sections = section_ranges(lines)
    if args.section is not None:
        if not 1 <= args.section <= len(sections):
            parser.error(f'--section must be 1–{len(sections)}.')
        start, end, _ = sections[args.section - 1]
        emit(lines, [(start, end)], args.max_chars)
        return 0
    if args.search is not None:
        if not args.search.strip():
            parser.error('--search cannot be empty or whitespace.')
        matches = [i for i, line in enumerate(lines, 1) if args.search in line]
        if not matches:
            print('没有找到匹配文本。')
            return 0
        ranges: list[tuple[int, int]] = []
        last_end = 0
        for i in matches:
            if i <= last_end:
                continue
            start, end = max(1, i - args.context), min(len(lines), i + args.context)
            ranges.append((start, end))
            last_end = end
            if len(ranges) >= args.limit:
                break
        print(f'匹配行数：{len(matches)}；本次最多显示 {args.limit} 处，遵守字符上限。')
        emit(lines, ranges, args.max_chars)
        return 0
    for i, (start, end, title) in enumerate(sections, 1):
        print(f'{i:02d} | L{start}–L{end} | {title}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
