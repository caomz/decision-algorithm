# github_open_skills · 常用 skill 开源记录仓

> 从 GitHub 开源项目同步来的 skill，一份一份记在这里——**来源可查、版本可追、差异可查**。

本目录位于仓库的 `skills/` 之下（`skills/github_open_skills/`），只做**记录**：收录从开源项目同步过来的 skill，标清来源、作者、许可、上游提交，以及本地版本和上游版本的差异。它**不接管安装**——本机真正生效的安装位仍然是 `/Volumes/WorkSSD/.agents/skills/`。

> 注：本目录内层还有一个 `skills/`，即实际快照在 `skills/github_open_skills/skills/<skill名>/`。因为顶层没有 `SKILL.md`，仓库的一键安装器 `scripts/install_skills.py` **不会**把这些快照当成可安装 skill，它们只是记录。

---

## 收录范围：mx × zcode 交叉验证

本仓收录的 skill 不是拍脑袋挑的，而是对两个宿主全局 skill 仓做**交叉验证**后取的交集：

| 全局仓 | 路径 | 条目 |
|---|---|---|
| MiniMax Code | `~/.minimax/skills` | 49 |
| ZCode | `~/.zcode/skills` | 287 |

- mx 是 zcode 的**严格子集**（mx 独有 0 个）
- 交集内 **49 个 skill 内容逐字节一致**，无分歧

这 49 个全部收录，另加 4 个本仓自管的，合计 **51 个**。完整方法与逐项来源见 [`sources/CROSS_VALIDATION.md`](sources/CROSS_VALIDATION.md)。

| 来源类型 | 数量 | 仓库数 |
|---|---|---|
| GitHub 仓库 | 35 | 20 |
| open.feishu.cn（飞书开放平台，非 GitHub） | 11 | — |
| 本机自装，无公开上游 | 1（`hallmark`） | — |
| 本仓自管 | 4（`whatis` / `claude-cleanup` / `break-ai-slop` / `get-biji`） | — |

**收录范围仅逻辑**：`SKILL.md`、`references/`、`scripts/`、`agents/` 入库；`assets/`、`demos/`、音视频图片不入库。完整快照 107.5 MB → 入库 **19 MB**（1270 个文件）。

---

## 收录清单

### 来自 [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill)

> 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)）的精品 skill 合集，MIT 许可。上游同步于 2026-11-15，HEAD `5a6848f`（2026-11-12）。

| Skill | 定位 | 本目录采用 | 上游提交 | 本机安装位 |
|---|---|---|---|---|
| [`break-ai-slop`](skills/break-ai-slop/) | 专家预检：动手前挖出隐性经验与决定成败的约束 | **本机定制版**（克制：不强制、不外露推理） | `6da5289` → `f40ca58` | `~/.agents/skills/break-ai-slop` |
| [`claude-cleanup`](skills/claude-cleanup/) | Claude 本机清理 + 开局上下文瘦身（macOS / Windows） | **上游 HEAD 版**（含 context-slim 分支） | `e61cc66` → `fb4782e` → `ed8c1b8` | **本目录快照**（六平台均链到此处） |
| [`get-biji`](skills/get-biji/) | Get 笔记同步、检索与音视频转写 | **本机领先版**（含跨平台锁、cron 接入、只读去重） | `d932bb7` → `915276a` → `24a3cfd` → `d943cb1` | `~/.agents/skills/get-biji` |
| [`whatis`](skills/whatis/) | 看不懂的东西，画成大图 HTML 给你看 | **本机适配版**（宿主工具无关，不写死 `/tmp`） | `423473d` | **本目录快照**（六平台均链到此处） |

上游原文许可：[`sources/suyuan-skill/LICENSE`](sources/suyuan-skill/LICENSE)。

### 来自其余 19 个 GitHub 仓库（31 个 skill）

| 仓库 | skill |
|---|---|
| [microsoft/azure-skills](https://github.com/microsoft/azure-skills) | azure-cloud-migrate、azure-compute、azure-messaging、azure-quotas、azure-upgrade、microsoft-foundry |
| [iswalle/getnote-cli](https://github.com/iswalle/getnote-cli) | getnote-auth、getnote-kb、getnote-note、getnote-search、getnote-tag |
| [jackwener/opencli](https://github.com/jackwener/opencli) | opencli-adapter-author、opencli-autofix、opencli-browser、opencli-usage |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | remotion-best-practices、remotion-captions、remotion-create、remotion-render |
| [anthropics/skills](https://github.com/anthropics/skills) | frontend-design |
| [shadcn/ui](https://github.com/shadcn/ui) | shadcn |
| [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design) | huashu-design |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | design-taste-frontend |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | ui-ux-pro-max |
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | last30days |
| [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill) | guizang-ppt-skill |
| [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) | humanizer-zh |
| [hypit-ai/hypit](https://github.com/hypit-ai/hypit) | hypit |
| [juliusbrussee/caveman](https://github.com/juliusbrussee/caveman) | caveman |
| [obra/superpowers](https://github.com/obra/superpowers) | brainstorming |
| [supabase/agent-skills](https://github.com/supabase/agent-skills) | supabase-postgres-best-practices |
| [typesafe-ai/skills](https://github.com/typesafe-ai/skills) | typesafe-ai |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | agent-browser |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | find-skills |
| [walkinglabs/learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) | harness-creator |

### 来自 open.feishu.cn（11 个，非 GitHub）

`lark-apps`、`lark-base`、`lark-calendar`、`lark-doc`、`lark-drive`、`lark-event`、`lark-im`、`lark-meeting`、`lark-shared`、`lark-slides`、`lark-task`

### 无公开上游

`hallmark` —— 本机自装，不在 skills CLI lock 中。

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
        ├── skills/                  #   51 个收录快照
        │   ├── <skill名>/
        │   │   ├── SKILL.md         #     skill 入口
        │   │   └── PROVENANCE.md    #     溯源：来源、commit、收录方式
        │   └── ...
        ├── sources/                 #   上游来源留档
        │   ├── manifest.json        #     ⭐ 多源清单（同步脚本的唯一真相）
        │   ├── CROSS_VALIDATION.md  #     ⭐ mx × zcode 交叉验证记录
        │   ├── sync-history.jsonl   #     同步流水
        │   └── suyuan-skill/        #     上游 LICENSE 与提交留档
        └── scripts/
            ├── sync_from_github.py  #   多源安全同步（默认只报告）
            └── build_manifest.py    #   从 skill lock 重建清单
```

---

## 同步

清单 `sources/manifest.json` 是唯一真相：每个 skill 从哪个上游来、在上游哪里、能不能被 `--apply` 覆盖，都记在里面。

```bash
cd /Volumes/WorkSSD/Dev/decision-algorithm/skills/github_open_skills

# 重建清单（读 ~/.agents/.skill-lock.json，重新做 mx × zcode 交叉验证）
python3 scripts/build_manifest.py --write

# 拉取上游并报告差异，不改任何文件
python3 scripts/sync_from_github.py

# 只对「上游为准」的 skill 执行更新
python3 scripts/sync_from_github.py --apply

# 只看某个来源
python3 scripts/sync_from_github.py --source microsoft__azure-skills
```

脚本行为：

- 支持三类来源：**git**（GitHub 仓库）、**wellknown**（飞书开放平台 `/.well-known/skills/`）、**local**（本仓自管，无上游）
- 上游缓存在 `.cache/`，`--apply` 前会把要覆盖的本地目录整体备份为 `<name>.backup-<时间戳>`，不删数据
- 标记为「本机版优先」的 skill **永远不会被 `--apply` 覆盖**，只输出差异清单，需要时人工合并
- **只同步逻辑文件**：`SKILL.md` / `references/` / `scripts/` / `agents/` 入库，`assets/`、`demos/`、音视频图片跳过
- 每次 `--apply` 往 `sources/sync-history.jsonl` 追加一条流水

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
| [`whatis`](skills/whatis/) | ✅ **已指向本目录**：共享仓 / Claude Code / ZCode / Codex / OpenClaw / MiniMax Code 六处均链到本目录快照（原实体副本内容与本快照相同，已清理）。`~/.agents/.skill-lock.json` 已改为本地源且不记 hash，`npx skills update` 会跳过它，不会覆盖软链 |
| 其余 49 个交叉验证 skill | ✅ **Codex 已补齐**：2026-11-16 把 49 个交叉验证 skill 全部装进 `~/.codex/skills/`（原仅 9 个）。统一软链到 `../../.agents/skills/<name>` 完整安装位——本目录快照是「仅逻辑」版，`guizang-ppt-skill` / `last30days` / `shadcn` 依赖 assets，指向快照会装坏 |
| [`break-ai-slop`](skills/break-ai-slop/) | 未改动，仍是 `~/.agents/skills/break-ai-slop` 实体目录。lock 里仍记上游 GitHub 源，`npx skills update` 会用上游激进版覆盖它——如需保护，用同样办法改成本地源 |
| [`claude-cleanup`](skills/claude-cleanup/) | ✅ **已指向本目录**：共享仓 / Claude Code / ZCode / Codex / OpenClaw / MiniMax Code 六处均链到本目录快照。lock 已改为本地源且不记 hash，`npx skills update` 会跳过它，不会覆盖软链 |
| [`get-biji`](skills/get-biji/) | 未改动，正本在 `~/.agents/skills/get-biji`（与本目录内容一致） |

其余 3 个 skill 想换成仓库版本时，按上面的 `ln -sfn` 逐个重链即可；重链前先把实体目录移走备份。

> 实测记录（2026-11-15）：执行过一次完整的 `npx skills update -g`，whatis 的六处软链与 `.skill-lock.json` 条目**均未被改写**——lock 里 whatis 被列为 `Local path` 并跳过。其余 40 个 skill 被更新到上游版本，MiniMax Code 的 `~/.minimax/skills/` 另新增 45 个指向 `~/.agents/skills/` 的软链，属 skills CLI 的正常全局安装行为。

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
