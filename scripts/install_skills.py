#!/usr/bin/env python3
"""Smart cross-platform installer for the skills in this repository.

One command instead of a wall of ``ln -s``:

    python3 scripts/install_skills.py            # status report, changes nothing
    python3 scripts/install_skills.py --apply    # link every skill into every detected platform
    python3 scripts/install_skills.py --apply --skill get-biji --target claude
    python3 scripts/install_skills.py --apply --with-deps   # also npm install + chromium
    python3 scripts/install_skills.py --uninstall
    python3 scripts/install_skills.py --json     # machine-readable report

Design rules:

* **Fail-closed.** Nothing is overwritten, deleted, or replaced without an explicit
  flag. ``--apply`` only fills in genuinely missing links.
* **Recoverable.** ``--relink`` backs up whatever it displaces: a real directory
  or a plain file is *moved* to ``<name>.backup-<timestamp>``, never deleted.
  Only a dangling link is removed outright, because a link holds no data.
* **Honest.** A skill that lives elsewhere on the machine (another checkout, the
  shared ``~/.agents/skills`` store) is reported as ``upstream``, not silently
  hijacked.
* **Preflight.** Runtime dependencies are checked before anything is linked, so
  an install that cannot work does not look successful.

Standard library only; Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Sequence

ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = ROOT / "skills"

# ---------------------------------------------------------------- states ----

LINKED = "linked"                # already points at this repository
UPSTREAM = "upstream"            # points at some other source of truth on this machine
COPY = "copy"                    # a real directory sits there (a manual copy)
DANGLING_LINK = "dangling-link"  # a link whose target is gone (removing it loses nothing)
PLAIN_FILE = "plain-file"        # a real file sits where the link should go
MISSING = "missing"              # nothing there yet

STATE_ORDER = [LINKED, MISSING, UPSTREAM, COPY, DANGLING_LINK, PLAIN_FILE]

STATE_LABEL = {
    LINKED: "已链接到本仓库",
    MISSING: "缺失",
    UPSTREAM: "指向别处（上游正本）",
    COPY: "是实体目录（手工拷贝）",
    DANGLING_LINK: "断链（目标已不存在）",
    PLAIN_FILE: "普通文件（不是链接）",
}


# ------------------------------------------------------------- platforms ----


@dataclass(frozen=True)
class Platform:
    key: str
    label: str
    home: str                      # ~-relative personal skills dir
    project: Optional[str] = None  # ~-relative project-local skills dir


PLATFORMS: Sequence[Platform] = (
    Platform("claude", "Claude Code", "~/.claude/skills", ".claude/skills"),
    Platform("codex", "Codex", "~/.codex/skills", ".codex/skills"),
    Platform("openclaw", "OpenClaw", "~/.openclaw/workspace/skills"),
    Platform("zcode", "ZCode", "~/.zcode/skills"),
    Platform("agents", "共享 skills 仓", "~/.agents/skills"),
    Platform("mcode", "MiniMax Code", "~/.minimax/skills"),
)


def expand(path_like: str) -> Path:
    """Expand ``~`` and environment variables into an absolute path."""
    return Path(os.path.expandvars(os.path.expanduser(path_like))).resolve(strict=False)


# ---------------------------------------------------------------- skills ----


@dataclass
class Skill:
    name: str
    path: Path
    requires: List[str] = field(default_factory=list)  # human-readable runtime needs


def discover_skills() -> List[Skill]:
    """Every directory under ``skills/`` that carries a SKILL.md is installable."""
    found: List[Skill] = []
    if not SKILLS_DIR.is_dir():
        return found
    for entry in sorted(SKILLS_DIR.iterdir()):
        if entry.is_dir() and (entry / "SKILL.md").is_file():
            found.append(Skill(name=entry.name, path=entry.resolve()))
    return found


# ------------------------------------------------------------- link layer ----

IS_WINDOWS = os.name == "nt"


def _strip_extended_prefix(raw: str) -> str:
    """Windows reports junctions as ``\\\\?\\C:\\...`` — drop that prefix."""
    if raw.startswith("\\\\?\\"):
        return raw[4:]
    return raw


def link_target(path: Path) -> Optional[Path]:
    """Resolve a directory link (POSIX symlink or Windows junction).

    Returns ``None`` when *path* is not a link at all.
    """
    if path.is_symlink():
        return Path(os.path.realpath(path))
    if IS_WINDOWS:
        try:
            raw = os.readlink(str(path))
        except (OSError, ValueError):
            return None
        return Path(os.path.realpath(_strip_extended_prefix(raw)))
    return None


def _same_path(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(os.path.abspath(str(b)))


def create_link(link: Path, target: Path) -> str:
    """Create a directory link at *link* pointing at *target*.

    Returns ``"symlink"`` or ``"junction"``. On Windows a junction is used when
    the process lacks ``SeCreateSymbolicLinkPrivilege`` (developer mode off),
    because junctions need no privilege and may cross volumes — so the
    repository stays the single source of truth without a re-login.
    """
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=True)
        return "symlink"
    except OSError as exc:
        if not IS_WINDOWS:
            raise
        symlink_error = exc

    proc = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise OSError(
            "创建目录链接失败："
            f"symlink → {symlink_error}；"
            f"mklink /J → {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return "junction"


def remove_link(link: Path) -> None:
    """Remove a link (POSIX symlink or Windows junction) without touching its target."""
    if IS_WINDOWS and not link.is_symlink():
        os.rmdir(str(link))
    else:
        link.unlink()


# ------------------------------------------------------------ inspection ----


@dataclass
class Target:
    platform: Platform
    scope: str          # "personal" | "project"
    path: Path
    exists: bool        # platform dir itself is present


def targets_for(platform: Platform, include_project: bool, explicit: bool) -> List[Target]:
    """Personal dir (always) plus optional project dir.

    A platform is only worth touching if it is already installed on this
    machine — unless the user named it explicitly with ``--target``, in which
    case the directory is created on demand.
    """
    personal = expand(platform.home)
    out = [Target(platform, "personal", personal, personal.is_dir() or explicit)]
    if include_project and platform.project:
        p = expand(platform.project)
        out.append(Target(platform, "project", p, p.is_dir() or explicit))
    return out


def classify(path: Path, repo_skill: Path) -> str:
    """Decide what a path currently is, relative to this repository."""
    target = link_target(path)
    if target is not None:
        if not target.exists():
            return DANGLING_LINK
        if _same_path(target, repo_skill):
            return LINKED
        return UPSTREAM
    if path.exists():
        if path.is_dir():
            return COPY
        return PLAIN_FILE
    return MISSING


@dataclass
class Row:
    skill: str
    platform: str
    scope: str
    path: Path
    state: str
    resolved: str = ""
    action: str = "skip"
    detail: str = ""

    def to_dict(self) -> Dict[str, object]:
        return {
            "skill": self.skill,
            "platform": self.platform,
            "scope": self.scope,
            "path": str(self.path),
            "state": self.state,
            "resolved": self.resolved,
            "action": self.action,
            "detail": self.detail,
        }


def plan(skills: Sequence[Skill], platform_keys: Sequence[str], include_project: bool) -> List[Row]:
    rows: List[Row] = []
    explicit = set(platform_keys)
    for platform in PLATFORMS:
        if platform_keys and platform.key not in platform_keys:
            continue
        for target in targets_for(platform, include_project, platform.key in explicit):
            if not target.exists:
                continue
            for skill in skills:
                link = target.path / skill.name
                state = classify(link, skill.path)
                resolved = link_target(link)
                row = Row(
                    skill=skill.name,
                    platform=platform.key,
                    scope=target.scope,
                    path=link,
                    state=state,
                    resolved=str(resolved) if resolved else "",
                )
                rows.append(row)
    return rows


# --------------------------------------------------------------- actions ----


def backup_path(path: Path) -> Path:
    """Timestamped ``<name>.backup-<stamp>`` sibling for a file or directory."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return path.with_name(f"{path.name}.backup-{stamp}")


def apply_row(row: Row, repo_skill: Path, relink: bool, dry_run: bool) -> Row:
    """Perform (or simulate) the action for one row. Never destroys data."""
    if row.state == LINKED:
        row.action = "noop"
        row.detail = "已指向本仓库"
        return row

    if row.state == MISSING:
        row.action = "create"
        row.detail = f"创建链接 → {repo_skill}"
        if not dry_run:
            kind = create_link(row.path, repo_skill)
            row.detail = f"创建{kind} → {repo_skill}"
            new_state = classify(row.path, repo_skill)
            row.state = new_state
            if new_state != LINKED:
                row.detail = f"创建后状态异常：{STATE_LABEL.get(new_state, new_state)}"
        return row

    if row.state in (UPSTREAM, DANGLING_LINK):
        if not relink:
            row.action = "skip"
            row.detail = "需 --relink 才会改指向（默认不动）"
            return row
        old = row.resolved or str(row.path)
        row.action = "relink"
        row.detail = f"改指向本仓库（原：{old}）"
        if not dry_run:
            remove_link(row.path)
            create_link(row.path, repo_skill)
            row.state = classify(row.path, repo_skill)
        return row

    # COPY / PLAIN_FILE: something real is standing where the link should go —
    # move it aside to a timestamped backup, never delete it.
    if not relink:
        row.action = "skip"
        what = "实体目录" if row.state == COPY else "普通文件"
        row.detail = f"{what}，需 --relink 备份后改链接（默认不动）"
        return row
    backup = backup_path(row.path)
    row.action = "adopt"
    row.detail = f"备份为 {backup.name} 后改链接"
    if not dry_run:
        shutil.move(str(row.path), str(backup))
        create_link(row.path, repo_skill)
        row.state = classify(row.path, repo_skill)
        row.detail += f"；备份在 {backup}"
    return row


def uninstall_row(row: Row, repo_skill: Path, dry_run: bool) -> Row:
    """Remove a link only when it points into this repository."""
    if row.state != LINKED:
        row.action = "skip"
        row.detail = "不指向本仓库，保持不动"
        return row
    row.action = "unlink"
    row.detail = f"移除链接 {row.path}"
    if not dry_run:
        remove_link(row.path)
        row.state = MISSING
    return row


# --------------------------------------------------------- dependencies ----


@dataclass
class Dep:
    name: str
    ok: bool
    level: str       # "error" | "warn" | "info"
    detail: str
    fix: str = ""


def _which(cmd: str) -> Optional[str]:
    return shutil.which(cmd)


def _node_version() -> Optional[str]:
    node = _which("node")
    if not node:
        return None
    try:
        out = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip().lstrip("v")
    except Exception:
        return None


def _python_version() -> Optional[str]:
    return sys.version.split()[0]


def check_dependencies(skills: Sequence[Skill]) -> List[Dep]:
    deps: List[Dep] = []
    names = {s.name for s in skills}

    if "get-biji" in names:
        skill_dir = SKILLS_DIR / "get-biji"
        version = _node_version()
        if version is None:
            deps.append(Dep("Node.js ≥ 18", False, "error", "未安装 node",
                            "brew install node"))
        elif int(version.split(".")[0]) < 18:
            deps.append(Dep("Node.js ≥ 18", False, "error", f"当前 v{version}",
                            "brew install node"))
        else:
            deps.append(Dep("Node.js ≥ 18", True, "info", f"v{version}"))

        if _which("npm"):
            deps.append(Dep("npm", True, "info", "可用"))
        else:
            deps.append(Dep("npm", False, "error", "未安装 npm", "随 Node.js 一同安装"))

        if (skill_dir / "node_modules" / "playwright").is_dir():
            deps.append(Dep("playwright", True, "info", "已安装"))
        else:
            deps.append(Dep("playwright", False, "warn", "未安装（仅登录时需要）",
                            "python3 scripts/install_skills.py --apply --with-deps"))

        if _which("ffprobe"):
            deps.append(Dep("ffmpeg / ffprobe", True, "info", "可用（--file 转写需要）"))
        else:
            deps.append(Dep("ffmpeg / ffprobe", False, "warn", "未安装（--file 转写需要）",
                            "brew install ffmpeg"))

        if _which("yt-dlp"):
            deps.append(Dep("yt-dlp", True, "info", "可用（可选）"))
        else:
            deps.append(Dep("yt-dlp", False, "info", "未安装（可选，下载其他站点音视频用）",
                            "brew install yt-dlp"))

        key = os.environ.get("GETNOTE_API_KEY")
        cid = os.environ.get("GETNOTE_CLIENT_ID")
        if key and cid:
            deps.append(Dep("GetNote API 凭证", True, "info", "GETNOTE_API_KEY / CLIENT_ID 已设置"))
        else:
            deps.append(Dep("GetNote API 凭证", False, "warn",
                            "未设置（网页端抓取仍可用，官方 API 不可用）",
                            "export GETNOTE_API_KEY=... GETNOTE_CLIENT_ID=..."))

    if "modern-thinking-tools" in names:
        key = os.environ.get("GETNOTE_API_KEY")
        cid = os.environ.get("GETNOTE_CLIENT_ID")
        if key and cid:
            deps.append(Dep("modern-thinking-tools 凭证", True, "info", "已设置"))
        else:
            deps.append(Dep("modern-thinking-tools 凭证", False, "warn",
                            "未设置 GETNOTE_API_KEY / GETNOTE_CLIENT_ID，将进入检索降级模式",
                            "export GETNOTE_API_KEY=... GETNOTE_CLIENT_ID=..."))

    if {"decision-algorithm", "dedao-life-algorithms"} & names:
        version = _python_version()
        deps.append(Dep("Python", True, "info", version or "未知"))

    return deps


def install_dependencies(skills: Sequence[Skill], dry_run: bool) -> List[str]:
    """Run the heavy installs the user explicitly asked for."""
    notes: List[str] = []
    names = {s.name for s in skills}
    if "get-biji" in names:
        skill_dir = SKILLS_DIR / "get-biji"
        if dry_run:
            notes.append(f"[dry-run] cd {skill_dir} && npm install")
            notes.append(f"[dry-run] cd {skill_dir} && npx playwright install chromium")
            return notes
        notes.append("· npm install（get-biji）")
        subprocess.run(["npm", "install"], cwd=str(skill_dir), check=False)
        notes.append("· npx playwright install chromium（get-biji）")
        subprocess.run(
            ["npx", "playwright", "install", "chromium"],
            cwd=str(skill_dir),
            check=False,
        )
    return notes


# --------------------------------------------------------------- output ----


def _display_width(text: str) -> int:
    """Terminal width of a string; CJK characters occupy two columns."""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _display_width(text))


def render_table(rows: Sequence[Row]) -> str:
    if not rows:
        return "（没有检测到目标平台；用 --target <platform> 可指定平台并自动建目录）"
    columns = [("平台", 12), ("scope", 9), ("skill", 23), ("状态", 24), ("操作", 0)]
    head = " ".join(_pad(title, width) for title, width in columns)
    lines = [head, "-" * _display_width(head)]
    last_platform = None
    for row in rows:
        platform = row.platform if row.platform != last_platform else ""
        last_platform = row.platform
        values = [
            platform,
            row.scope,
            row.skill,
            STATE_LABEL.get(row.state, row.state),
            row.action,
        ]
        lines.append(" ".join(_pad(v, w) for v, w in zip(values, [c[1] for c in columns])))
    return "\n".join(lines)


def render_deps(deps: Sequence[Dep]) -> str:
    if not deps:
        return ""
    icon = {"error": "✗", "warn": "!", "info": "·"}
    lines = []
    for dep in deps:
        suffix = f"  → {dep.fix}" if dep.fix and not dep.ok else ""
        lines.append(f"  {icon.get(dep.level, '·')} {dep.name}: {dep.detail}{suffix}")
    return "\n".join(lines)


# ----------------------------------------------------------------- main ----


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="安装本仓库的 skills 到各 AI 平台（默认只检查，不改动）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python3 scripts/install_skills.py                     # 看状态\n"
            "  python3 scripts/install_skills.py --apply             # 装全部缺失链接\n"
            "  python3 scripts/install_skills.py --apply --relink    # 连上游/实体目录一起改指向\n"
            "  python3 scripts/install_skills.py --apply --with-deps # 顺带装 npm 依赖\n"
        ),
    )
    parser.add_argument("--apply", action="store_true", help="执行安装（默认只检查）")
    parser.add_argument("--uninstall", action="store_true", help="移除指向本仓库的链接")
    parser.add_argument("--relink", action="store_true",
                        help="允许改写指向别处的链接 / 实体目录（实体目录会先备份）")
    parser.add_argument("--with-deps", action="store_true", help="顺带安装运行时依赖")
    parser.add_argument("--dry-run", action="store_true", help="只演示，不落盘")
    parser.add_argument("--skill", action="append", default=[], metavar="NAME",
                        help="只处理某个 skill（可重复）")
    parser.add_argument("--target", action="append", default=[], metavar="PLATFORM",
                        help=f"只处理某个平台（可重复）：{', '.join(p.key for p in PLATFORMS)}")
    parser.add_argument("--all-scopes", action="store_true",
                        help="同时处理项目内 .claude/.codex 目录（默认只处理个人目录）")
    parser.add_argument("--list", action="store_true", help="列出可安装的 skill 与平台")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)

    skills = discover_skills()
    if args.skill:
        wanted = set(args.skill)
        unknown = wanted - {s.name for s in skills}
        if unknown:
            parser.error(f"未知 skill: {', '.join(sorted(unknown))}")
        skills = [s for s in skills if s.name in wanted]

    if args.list:
        print("skills:")
        for skill in skills:
            print(f"  - {skill.name:<22} {skill.path}")
        print("平台:")
        for platform in PLATFORMS:
            mark = "✓" if expand(platform.home).is_dir() else "·"
            print(f"  {mark} {platform.key:<10} {platform.label:<16} {platform.home}")
        return 0

    if not skills:
        print("没有找到任何 skill（skills/*/SKILL.md）", file=sys.stderr)
        return 1

    rows = plan(skills, args.target, args.all_scopes)

    if args.uninstall:
        for row in rows:
            repo_skill = (SKILLS_DIR / row.skill).resolve()
            uninstall_row(row, repo_skill, args.dry_run)
    elif args.apply:
        for row in rows:
            repo_skill = (SKILLS_DIR / row.skill).resolve()
            apply_row(row, repo_skill, args.relink, args.dry_run)
        if args.with_deps:
            install_dependencies(skills, args.dry_run)
    else:
        for row in rows:
            if row.state == LINKED:
                row.action = "ok"
            elif row.state == MISSING:
                row.action = "would-create"
            elif row.state in (UPSTREAM, COPY, DANGLING_LINK, PLAIN_FILE) and not args.relink:
                row.action = "needs-relink"

    deps = check_dependencies(skills)

    if args.json:
        conflicted = [r for r in rows if r.state in (UPSTREAM, COPY, DANGLING_LINK, PLAIN_FILE)]
        print(json.dumps({
            "ok": not conflicted,
            "mode": "uninstall" if args.uninstall else ("apply" if args.apply else "check"),
            "root": str(ROOT),
            "skills": [s.name for s in skills],
            "rows": [r.to_dict() for r in rows],
            "conflicts": [r.to_dict() for r in conflicted],
            "dependencies": [
                {"name": d.name, "ok": d.ok, "level": d.level, "detail": d.detail, "fix": d.fix}
                for d in deps
            ],
        }, ensure_ascii=False, indent=2))
        return 0 if not conflicted else 1

    title = {
        "check": "安装状态检查",
        "apply": "执行安装",
        "uninstall": "执行卸载",
    }[("uninstall" if args.uninstall else ("apply" if args.apply else "check"))]
    if args.dry_run:
        title += "（dry-run，不落盘）"

    print(f"\n{title} · {ROOT}")
    print()
    print(render_table(rows))

    if deps:
        print()
        print("运行时依赖")
        print(render_deps(deps))
        if any(d.level == "error" and not d.ok for d in deps):
            print("  ⚠️ 有 error 级依赖缺失，先修掉再安装。")

    if not args.apply and not args.uninstall:
        missing = sum(1 for r in rows if r.state == MISSING)
        needs = sum(1 for r in rows if r.state in (UPSTREAM, COPY, DANGLING_LINK, PLAIN_FILE))
        print()
        if missing:
            print(f"下一步：python3 scripts/install_skills.py --apply    # 补上 {missing} 个缺失链接")
        if needs:
            print(f"      python3 scripts/install_skills.py --apply --relink   # 另外 {needs} 处指向别处（会先备份）")
        if not missing and not needs:
            print("全部就绪，无需操作。")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
