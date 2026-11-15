# claude-cleanup · Claude 本机清理与上下文瘦身

两件事：把本机 Claude Code / Claude Desktop 的状态安全清理干净；以及给开局上下文瘦身（关掉用不上的工具、MCP、skill、插件）。

| | |
|---|---|
| **来源** | [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill) · `claude-cleanup/` |
| **作者** | 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)） |
| **许可** | MIT（原文见 [`../../sources/suyuan-skill/LICENSE`](../../sources/suyuan-skill/LICENSE)） |
| **上游提交** | `e61cc66`（引入）→ `fb4782e`（简化清理流程）→ `ed8c1b8`（新增 context-slim 分支） |
| **本目录采用** | **上游 HEAD 版**（本机旧快照已过时，本次同步直接更新到最新） |

## 为什么这版比本机旧快照好

本机 `/Volumes/WorkSSD/.agents/skills/claude-cleanup` 是 10-24 的旧快照，缺上游 10 月底的 `ed8c1b8`「context-slim 分支」：

| 变化 | 旧快照 | 本目录（上游 HEAD） |
|---|---|---|
| 能力范围 | 只有「本机清理」 | 「本机清理」+「上下文瘦身」两条分支，macOS 与 Windows 都支持瘦身 |
| 上下文瘦身文档 | 无 | 新增 [`references/context-slim.md`](references/context-slim.md)，讲清 Claude Code 全局配置在哪、怎么改 |
| `~/.claude/usage-data` | 自动清理 | **不再自动清**——它存的是 `/insights` 生成的报告，不算缓存 |
| 脚本调用方式 | `python3 "$SKILL_ROOT/scripts/claude_cleanup.py"` | `python3 scripts/claude_cleanup.py`（相对 skill 目录） |
| 测试 | 基础测试 | 新增 `tests/sim/` 三个仿真脚本（fake gateway / fake mcp / fake home） |

## 风险边界（上游明确写死的，不要绕过）

- 高风险、不可逆的操作**只在终端跑脚本**，由用户自己输入 `CONFIRM`；可逆的设置修改由 agent 讲清楚后直接改。
- `~/.claude/skills`、`plugins`、`hooks`、`commands`、`agents`、`mcp-servers`、`scheduled-tasks`、`backups`、`CLAUDE.md`、`settings*.json` 以及任何项目目录、Git 仓库、Codex 会话**一律不删不移**。
- 所有移除只进**时间戳废纸篓目录**，不永久删除、不清空废纸篓。
- 身份轮换只用于隐私与排障，**不宣称能改变平台关联判断**；本 skill **不用于规避封禁、支付检查、设备/IP 信誉或任何平台风控**。
- 正在使用 `~/.claude` 的 Claude Code 自己只跑只读审计，清理要切到 Codex 或普通终端。

## 安装

```bash
ln -s /Volumes/WorkSSD/Dev/decision-algorithm/skills/github_open_skills/skills/claude-cleanup ~/.claude/skills/claude-cleanup
```

本目录**只做记录**，不负责安装。正本安装位是 `/Volumes/WorkSSD/.agents/skills/claude-cleanup`，本机仍是旧快照——想换到新版，走上面的链接或用同步脚本的 `--apply`。

## 验证

```bash
cd skills/claude-cleanup && python3 -m pytest tests -q
```

## 同步

```bash
python3 scripts/sync_from_github.py            # 只看差异，不落盘
python3 scripts/sync_from_github.py --apply    # 对标记为「上游为准」的 skill 执行更新
```
