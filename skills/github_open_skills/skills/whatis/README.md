# whatis · 看不懂的东西，画成图给你看

碰到不熟的概念，或者 agent 甩来一大段字读不进去，叫一下 whatis。它生成一个 HTML 页面：大图为主、字很少，流程图、时序图、架构图、前后对比，哪个合适画哪个。

| | |
|---|---|
| **来源** | [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill) · `whatis/`（改自 Anthropic 的 [@trq212](https://x.com/trq212) 分享的 ELI5） |
| **作者** | 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)） |
| **许可** | MIT（原文见 [`../../sources/suyuan-skill/LICENSE`](../../sources/suyuan-skill/LICENSE)） |
| **上游提交** | `423473d`（引入，此后未改） |
| **本目录采用** | **本机适配版**（来自 `/Volumes/WorkSSD/.agents/skills/whatis`） |

## 与上游版的差异

上游只有一段写死的实现说明：

> No Artifact tool in this environment: write a self-contained HTML file (inline SVG/CSS, no external deps) to a temp directory (e.g. `$TMPDIR` or `/tmp`), then `open` it.

它硬编码假设「宿主没有 Artifact 工具、只能落 /tmp 再 open」。本机版把它改成**宿主工具无关**的路由逻辑：

| 上游 HEAD | 本目录（本机版） |
|---|---|
| 假定无 Artifact 工具，一律写 `/tmp` 再 `open` | 先**探测宿主实际可用的工具**，有可视化 / artifact 能力就用；没有才回退到自建自包含 HTML |
| 无路径管理要求 | 每次生成**唯一临时目录**，不覆盖旧文件 |
| 只给本地路径 | **返回绝对路径链接**；预览不可用时如实说明这个限制，不假装成功 |
| 未提只读模式 | **Plan / 只读模式下**只讲解或出图方案，不创建文件 |

采用适配版的原因：同一份 skill 要在 Claude Code、MiniMax Code 等多种宿主下都能用，写死 `/tmp + open` 在有 artifact 能力的宿主里既绕路又降级。

需要切回上游原版：`git show 5a6848f:whatis/SKILL.md`，覆盖本目录 `SKILL.md` 即可。

## 安装

**本目录就是本机生效版本**（2026-11-15 起），各平台都已指向这里：

| 平台 | 路径 | 指向 |
|---|---|---|
| 共享 skills 仓 | `~/.agents/skills/whatis` | → 本目录 |
| Claude Code | `~/.claude/skills/whatis` | → `~/.agents/skills/whatis`（链到本目录） |
| ZCode | `~/.zcode/skills/whatis` | → `~/.claude/skills/whatis`（链到本目录） |
| Codex | `~/.codex/skills/whatis` | → 本目录 |
| OpenClaw | `~/.openclaw/workspace/skills/whatis` | → 本目录 |
| MiniMax Code | `~/.minimax/skills/whatis` | → 本目录 |

改动前 `~/.agents/skills/whatis` 是实体目录（原 skill 管理器 `suyuan2022/suyuan-skill` 装的副本），已按仓库安装器惯例移开备份到 `~/.agents/skills-backup/whatis-20261115-200909`，未删除。

手动重链任一平台：

```bash
ln -sfn /Volumes/WorkSSD/Dev/decision-algorithm/skills/github_open_skills/skills/whatis ~/.codex/skills/whatis
```

> 注意：`~/.agents/.skill-lock.json` 里仍记着 whatis 来自 `suyuan2022/suyuan-skill`。若之后跑 `npx skills update` 之类命令，管理器可能用上游副本覆盖这个软链——那会退回上游原版，需要按上面的命令重新指向本目录。

## 使用

```text
/whatis 美联储加息为什么会让房贷变贵
```

## 同步

```bash
python3 scripts/sync_from_github.py            # 只看差异，不落盘
python3 scripts/sync_from_github.py --apply    # 对标记为「上游为准」的 skill 执行更新
```
