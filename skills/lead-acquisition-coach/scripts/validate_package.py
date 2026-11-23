#!/usr/bin/env python3
"""Check package structure, preserved source, evidence lines and local file links."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    errors: list[str] = []
    checks: list[str] = []
    required = [
        'SKILL.md', 'README.md', '第一课-获客核心与成交时刻.md',
        'sources/course-notes.md', 'sources/source-manifest.json',
        'references/01-course-core.md', 'references/02-learning-path.md',
        'references/03-coaching-workflows.md',
        'references/04-diagnostics-and-evidence.md',
        'references/05-user-context-and-ai-examples.md',
        'references/06-source-map.md',
        'references/07-case-bank-and-questions.md',
        'assets/01-business-brief.md', 'assets/02-customer-interview.md',
        'assets/03-content-brief.md', 'assets/04-trust-and-decision.md',
        'assets/05-offer-and-pilot.md', 'assets/06-experiment-and-review.md',
        'assets/07-lead-record.md', 'assets/08-learning-state.md',
        'scripts/read_source.py', 'tests/acceptance-cases.md',
    ]
    for name in required:
        path = ROOT / name
        if not path.is_file() or not path.stat().st_size:
            errors.append(f'Missing/empty required file: {name}')
    if errors:
        for item in errors:
            print('FAIL:', item)
        return 1
    checks.append(f'{len(required)} required files present and nonempty')
    skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
    if not re.match(r'\A---\nname: lead-acquisition-coach\ndescription: .+\n---\n', skill):
        errors.append('SKILL.md frontmatter is missing required name/description format')
    if len(skill.splitlines()) >= 500:
        errors.append('SKILL.md should remain below 500 lines')
    checks.append('Skill name/description and compact entrypoint checked')
    raw = (ROOT / 'sources/course-notes.md').read_bytes()
    lines = raw.decode('utf-8-sig').splitlines()
    manifest = json.loads((ROOT / 'sources/source-manifest.json').read_text(encoding='utf-8'))
    if (hashlib.sha256(raw).hexdigest() != manifest['sha256']
        or len(raw) != manifest['bytes'] or len(lines) != manifest['lines']):
        errors.append('Source hash, bytes or lines changed')
    checks.append('Original source SHA-256, byte size and line count checked')
    index = (ROOT / 'references/06-source-map.md').read_text(encoding='utf-8')
    sids = set(re.findall(r'^### (S\d{2})｜', index, re.MULTILINE))
    if sids != {f'S{i:02d}' for i in range(1, 34)}:
        errors.append('Source index must contain S01–S33')
    excerpt_count = 0
    for match in re.finditer(r'^> L(\d+): (.*)$', index, re.MULTILINE):
        num, quote = int(match[1]), match[2]
        excerpt_count += 1
        if not 1 <= num <= len(lines) or quote != lines[num - 1]:
            errors.append(f'Source excerpt mismatch at line {num}')
    checks.append(f'{len(sids)} source points and {excerpt_count} exact quoted lines checked')
    md_files = list(ROOT.rglob('*.md'))
    local_links = 0
    for p in md_files:
        text = p.read_text(encoding='utf-8')
        for line_no, line in enumerate(text.splitlines(), 1):
            if p.name == '06-source-map.md' and line.startswith('> L'):
                continue  # A quoted original relative link belongs to the original document.
            for match in re.finditer(r'!?\[[^\]\n]*\]\(([^)\n]+)\)', line):
                url = match[1].strip().split(' "', 1)[0]
                if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', url) or url.startswith('#'):
                    continue
                local = unquote(url.split('#', 1)[0])
                if not local:
                    continue
                local_links += 1
                if not (p.parent / local).exists():
                    errors.append(f'Broken local file link: {p.relative_to(ROOT)}:{line_no}: {url}')
        if p.name != 'course-notes.md':
            if re.search(r'/Users/|/Volumes/', text):
                errors.append(f'Unportable private path in {p.relative_to(ROOT)}')
            for sid in set(re.findall(r'\bS\d{2}\b', text)):
                if sid not in sids:
                    errors.append(f'Undefined source ID {sid} in {p.relative_to(ROOT)}')
    checks.append(f'{local_links} relative file links across {len(md_files)} Markdown files checked')
    read_script = ROOT / 'scripts/read_source.py'
    tests = [
        (['--verify'], 0), (['--index'], 0),
        (['--lines', '1980:1998'], 0),
        (['--section', '3', '--max-chars', '500'], 0),
        (['--search', '买单前', '--context', '0', '--limit', '1'], 0),
        (['--search', '__NO_SUCH_TEXT_985832__'], 0),
        (['--lines', '10:3'], 2), (['--section', '15'], 2),
        (['--context', '-1'], 2), (['--search', ' '], 2),
    ]
    for args, expected in tests:
        result = subprocess.run([sys.executable, str(read_script), *args],
                                capture_output=True, text=True, timeout=10)
        if result.returncode != expected:
            errors.append(f'CLI check failed for {args}: {result.returncode}, expected {expected}')
    checks.append(f'{len(tests)} source-reader normal/error-path checks run')
    image_count = len(list((ROOT / 'sources/图片和附件').glob('*.png')))
    if image_count != manifest['image_count']:
        errors.append('Source image count does not match manifest')
    checks.append(f'{image_count} original image files present')
    for item in checks:
        print('CHECK:', item)
    for item in errors:
        print('FAIL:', item)
    if errors:
        print(f'RESULT: {len(errors)} error(s)')
        return 1
    print('RESULT: structural/source checks passed. This is not a test of business effectiveness.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
