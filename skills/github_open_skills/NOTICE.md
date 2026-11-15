# 第三方来源与许可声明

本仓收录的 skill 全部来自公开的 GitHub 开源项目，版权归各自作者所有。此处记录来源、作者、许可与同步到的版本，便于追溯。

---

## suyuan-skill

| | |
|---|---|
| **仓库** | <https://github.com/suyuan2022/suyuan-skill> |
| **作者** | 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)） |
| **许可** | MIT — Copyright (c) 2026 Suyuan |
| **许可原文** | [`sources/suyuan-skill/LICENSE`](sources/suyuan-skill/LICENSE) |
| **同步到的 commit** | `5a6848ffd3c2b4f6705aa18547117ed1b1bf05cb`（2026-11-12，"chore: remove clash-guard prompt from repo"） |
| **首次同步** | 2026-11-15 |

### 收录的 skill

| Skill | 上游路径 | 本仓采用版本 |
|---|---|---|
| `break-ai-slop` | `break-ai-slop/` | 本机定制版（上游 `6da5289` → `f40ca58`） |
| `claude-cleanup` | `claude-cleanup/` | 上游 HEAD（`e61cc66` → `fb4782e` → `ed8c1b8`） |
| `get-biji` | `get-biji/` | 本机领先版（上游 `d932bb7` → `915276a` → `24a3cfd` → `d943cb1`） |
| `whatis` | `whatis/` | 本机适配版（上游 `423473d`） |

### 关于 `whatis` 的二次来源

上游 `whatis` 自述改自 Anthropic 的 [@trq212](https://x.com/trq212) 分享的 ELI5（Explain Like I'm Five）。原始 ELI5 只有一句话，本仓版本在上游基础上补了排版与信息层级要求。

### 关于 `get-biji` 的二次来源

上游 `get-biji` 的 skill 本体基于 [skychentian/GET-biji](https://github.com/skychentian/GET-biji)。

---

## 本地改动说明

MIT 许可允许修改与再分发，但需保留版权与许可声明。本仓对部分 skill 做了本地改动，逐一记录在对应目录的 `README.md`「与上游版的差异」一节：

| Skill | 改动性质 |
|---|---|
| `break-ai-slop` | 触发条件收窄为「显式要求或复杂任务」，不再强制每次输出推理步骤；核心约束不再覆盖宿主指令与用户授权 |
| `whatis` | 改为宿主工具无关的出图路由：优先使用宿主可视化 / artifact 能力，回退时才自建自包含 HTML；唯一临时目录不覆盖旧文件；返回绝对路径；Plan / 只读模式下不创建文件 |
| `get-biji` | 新增跨平台锁、只读去重清单、认证加固、cron 非交互接入、`--keep` / `--out` 等；已覆盖上游全部修复 |
| `claude-cleanup` | 与上游 HEAD 一致，无本地改动 |
