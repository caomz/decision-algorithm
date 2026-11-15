# 上游同步记录

## 来源

| | |
|---|---|
| **仓库** | <https://github.com/suyuan2022/suyuan-skill> |
| **作者** | 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)） |
| **许可** | MIT（原文见 [`LICENSE`](LICENSE)） |

## 同步历史

| 日期 | 上游 commit | 提交时间 | 提交说明 | 本次处理 |
|---|---|---|---|---|
| 2026-11-15 | `5a6848f` | 2026-11-12 | chore: remove clash-guard prompt from repo | 首次收录。`break-ai-slop`、`whatis`、`get-biji` 收本机定制/领先版；`claude-cleanup` 收上游 HEAD（相对本机旧快照新增 context-slim 分支与 `tests/sim/`） |

## 各 skill 的上游提交线

| Skill | 上游提交 |
|---|---|
| `break-ai-slop` | `6da5289` 引入 → `f40ca58` 移除 "Why This Works" 段落 |
| `claude-cleanup` | `e61cc66` 引入 → `fb4782e` 简化清理流程 → `ed8c1b8` 新增 context-slim 分支 |
| `get-biji` | `d932bb7` 引入 → `915276a` 转写成一等能力 → `24a3cfd` 可安装性修复 → `d943cb1` 迟到录音修复 |
| `whatis` | `423473d` 引入，此后未改 |

## 上游已移除的内容（本地不收录）

上游历史里有几个 skill 后来被删掉了，本仓不收录，也不留快照：

- `codex-review`（`cb53544` 引入，`f77736f` 移除）——双模型 code review
- `task-triage`（`21d7d7f` 移除）
- `claude-cleanup-audit`（`c4aa7fb` 移除，被 `claude-cleanup` 取代）
- `clash-guard` prompt（`b57b866` 引入，`5a6848f` 移除）

## 下次同步

```bash
python3 scripts/sync_from_github.py            # 只报告差异
python3 scripts/sync_from_github.py --apply    # 只更新「上游为准」的 skill
```

同步后请把新 commit 追加到上面的同步历史表，并把 `UPSTREAM_COMMIT` 更新为新的 HEAD。
