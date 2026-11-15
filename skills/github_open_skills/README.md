# github_open_skills · 常用 skill 开源记录仓

> 从 GitHub 开源项目同步来的 skill，一份一份记在这里——**来源可查、版本可追、差异可查**。

本目录位于仓库的 `skills/` 之下（`skills/github_open_skills/`），只做**记录**：收录从开源项目同步过来的 skill，标清来源、作者、许可、上游提交，以及本地版本和上游版本的差异。它**不接管安装**——本机真正生效的安装位仍然是 `/Volumes/WorkSSD/.agents/skills/`。

> 注：本目录内层还有一个 `skills/`，即实际快照在 `skills/github_open_skills/skills/<skill名>/`。因为顶层没有 `SKILL.md`，仓库的一键安装器 `scripts/install_skills.py` **不会**把这些快照当成可安装 skill，它们只是记录。

---

## 收录清单

### 来自 [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill)

> 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)）的精品 skill 合集，MIT 许可。上游同步于 2026-11-15，HEAD `5a6848f`（2026-11-12）。

| Skill | 定位 | 本目录采用 | 上游提交 | 本机安装位 |
|---|---|---|---|---|
| [`break-ai-slop`](skills/break-ai-slop/) | 专家预检：动手前挖出隐性经验与决定成败的约束 | **本机定制版**（克制：不强制、不外露推理） | `6da5289` → `f40ca58` | `~/.agents/skills/break-ai-slop` |
| [`claude-cleanup`](skills/claude-cleanup/) | Claude 本机清理 + 开局上下文瘦身（macOS / Windows） | **上游 HEAD 版**（本机旧快照缺 context-slim 分支，本次更新） | `e61cc66` → `fb4782e` → `ed8c1b8` | `~/.agents/skills/claude-cleanup`（仍是旧快照） |
| [`get-biji`](skills/get-biji/) | Get 笔记同步、检索与音视频转写 | **本机领先版**（含跨平台锁、cron 接入、只读去重） | `d932bb7` → `915276a` → `24a3cfd` → `d943cb1` | `~/.agents/skills/get-biji` |
| [`whatis`](skills/whatis/) | 看不懂的东西，画成大图 HTML 给你看 | **本机适配版**（宿主工具无关，不写死 `/tmp`） | `423473d` | **本目录快照**（六平台均链到此处） |

上游原文许可：[`sources/suyuan-skill/LICENSE`](sources/suyuan-skill/LICENSE)。

### 自有 skill（不在本仓复制，只做索引）

正本在 `/Volumes/WorkSSD/Dev/decision-algorithm/skills/`，同样经 `~/.agents/skills/` 安装：

| Skill | 定位 | 仓库内路径 |
|---|---|---|
| `decision-algorithm` | EKB 决策算法：期望值 + 凯利公式 + 贝叶斯 | `skills/decision-algorithm/` |
| `modern-thinking-tools` | 现代思维工具人生顾问（100 个思维工具） | `skills/modern-thinking-tools/` |
| `dedao-life-algorithms` | 老喻《人生算法课》行动闭环 | `skills/dedao-life-algorithms/` |

`get-biji` 同属该仓库（`skills/get-biji/`），三处副本内容一致；正本仍是 `/Volumes/WorkSSD/.agents/skills/get-biji`。

---

## 版本策略

统一口径：**本机 / 仓库定制版优先，上游只补新增**。

| 情况 | 处理 |
|---|---|
| 上游比本地新（`claude-cleanup`） | 直接更新到上游版；本地有改动就先备份再覆盖 |
| 本地是定制版、上游是原始版（`break-ai-slop`、`whatis`） | **保留本地版**，只在 README 里记清差异；同步脚本只报告差异，永不覆盖 |
| 本地大幅领先上游（`get-biji`） | 保留本地版；上游修复先核对是否已被本地包含，再决定是否挑拣合并 |

这样做的原因：定制版是为了适配本机宿主与实际工作流，用原始版覆盖等于回退。

---

## 目录结构

```
decision-algorithm/
└── skills/
    ├── decision-algorithm/          # 自有 skill
    ├── dedao-life-algorithms/       # 自有 skill
    ├── get-biji/                    # 自有 skill（正本副本）
    ├── modern-thinking-tools/       # 自有 skill
    └── github_open_skills/          # ⭐ 外部开源 skill 记录仓（本目录）
        ├── README.md                #   收录清单与版本策略
        ├── NOTICE.md                #   第三方来源与许可声明
        ├── skills/                  #   收录的 skill 快照（每个目录自带溯源 README）
        │   ├── break-ai-slop/
        │   ├── claude-cleanup/
        │   ├── get-biji/
        │   └── whatis/
        ├── sources/                 #   上游来源留档
        │   └── suyuan-skill/
        │       ├── LICENSE          #     上游 MIT 原文
        │       ├── UPSTREAM_COMMIT  #     上游同步到的 commit
        │       └── SYNC.md          #     同步历史与差异说明
        └── scripts/
            └── sync_from_github.py  #   安全同步脚本（默认只报告，不落盘）
```

---

## 同步

```bash
cd /Volumes/WorkSSD/Dev/decision-algorithm/skills/github_open_skills

python3 scripts/sync_from_github.py            # 拉取上游并报告差异，不改任何文件
python3 scripts/sync_from_github.py --apply    # 只对「上游为准」的 skill 执行更新
python3 scripts/sync_from_github.py --list     # 列出收录来源与版本策略
```

脚本行为：

- 上游缓存在 `.cache/`，`--apply` 前会把要覆盖的本地目录整体备份为 `<name>.backup-<时间戳>`，不删数据。
- 标记为「本机版优先」的 skill **永远不会被 `--apply` 覆盖**，只输出差异清单，需要时人工合并。
- 每次同步会更新 `sources/<仓库>/UPSTREAM_COMMIT` 与 `SYNC.md` 的同步记录。

---

## 安装

本目录**不自动安装**。要装某个 skill，手工链到对应平台：

```bash
# Claude Code / Codex / OpenClaw / ZCode / 共享 skills 仓 同理
ln -sfn /Volumes/WorkSSD/Dev/decision-algorithm/skills/github_open_skills/skills/whatis ~/.codex/skills/whatis
```

### 当前本机安装状态

| Skill | 安装状态 |
|---|---|
| [`whatis`](skills/whatis/) | ✅ **已指向本目录**：共享仓 / Claude Code / ZCode / Codex / OpenClaw / MiniMax Code 六处均链到本目录快照（原实体副本内容与本快照相同，已清理） |
| [`break-ai-slop`](skills/break-ai-slop/) | 未改动，仍是 `~/.agents/skills/break-ai-slop` 实体目录 |
| [`claude-cleanup`](skills/claude-cleanup/) | 未改动，仍是 `~/.agents/skills/claude-cleanup` 实体目录（**旧快照**，缺 context-slim 分支） |
| [`get-biji`](skills/get-biji/) | 未改动，正本在 `~/.agents/skills/get-biji`（与本目录内容一致） |

其余 3 个 skill 想换成仓库版本时，按上面的 `ln -sfn` 逐个重链即可；重链前先把实体目录移走备份。

---

## 安全提示

- `claude-cleanup` 会动 `~/.claude`——先跑只读审计，看清清单再决定；高风险操作它自己也会要求你在终端手动确认。
- `get-biji` 的录音逐字稿是私密素材，笔记目录不要放进会推到公开仓库的路径；凭证与登录态只存在 `GET_BIJI_HOME`（默认 `~/.config/get-biji/`）。
- 本仓同步过来的都是 **MIT 许可**的第三方 skill，许可原文随目录留档（`sources/`）。

---

## 许可

- 本仓收录的第三方 skill 版权归各自作者所有，许可见各 skill 的溯源 README 与 `sources/`。
- 上游 [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill)：MIT，Copyright (c) 2026 Suyuan。
- `get-biji` 的 skill 本体基于 [skychentian/GET-biji](https://github.com/skychentian/GET-biji)。
