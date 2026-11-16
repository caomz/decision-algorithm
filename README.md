# decision-algorithm · 人生与思维 Skills 集合

> *"做重大人生决策不靠一时的热情，而靠可重复的决策算法。"*

一套围绕**人生决策与思维工具**的 AI skills 集合仓库，收录三个互补的决策 skill，外加一个笔记检索工具：

| Skill | 定位 | 何时用 |
|-------|------|--------|
| [`decision-algorithm`](skills/decision-algorithm/) | EKB 决策算法（期望值 + 凯利公式 + 贝叶斯） | 要不要、该不该、该投多少——可量化的重大决策 |
| [`modern-thinking-tools`](skills/modern-thinking-tools/) | 现代思维工具人生顾问（100 个思维工具） | 看清问题、选框架、给行动与复盘点——广义人生诊断 |
| [`dedao-life-algorithms`](skills/dedao-life-algorithms/) | 老喻《人生算法课》行动闭环 | 个人成长、小步试验、把选择转成可观察的反馈问题 |
| [`get-biji`](skills/get-biji/) | Get 笔记同步、检索与音视频转写（工具型，跨平台） | 要把账号里的录音/笔记变成可搜的本地文本，或把链接转成逐字稿 |

前三者边界：`modern-thinking-tools` 负责广义诊断与工具选择；涉及胜率、赔率、期望值、凯利仓位等量化判断时交给 `decision-algorithm`；成长类卡点与行动闭环用 `dedao-life-algorithms`。

`get-biji` 是**工具型** skill，不做人生判断——它只负责把素材变成证据，拿到证据后交给上面三者。

---

## 🌐 外部开源 skills

[`skills/github_open_skills/`](skills/github_open_skills/) 是本仓库的**外部开源 skill 记录仓**：收录从开源项目同步来的 skill，逐个标清来源、作者、许可、上游提交与本地差异。它**只做记录，不接管安装**——本机生效的安装位仍是 `/Volumes/WorkSSD/.agents/skills/`。

**收录范围来自交叉验证**：对 `~/.minimax/skills`（49 项）与 `~/.zcode/skills`（287 项）两个宿主全局仓逐文件比对，取内容完全一致的交集——49 个 skill 全部入库，来自 20 个 GitHub 仓库 + 飞书开放平台，加 4 个本仓自管的，合计 **51 个**。

| 来源 | 数量 | 备注 |
|---|---|---|
| GitHub 仓库 | 35 | 20 个仓库，含 [anthropics/skills](https://github.com/anthropics/skills)、[shadcn/ui](https://github.com/shadcn/ui)、[microsoft/azure-skills](https://github.com/microsoft/azure-skills) 等 |
| [open.feishu.cn](https://open.feishu.cn/.well-known/skills/) | 11 | 飞书开放平台，非 GitHub |
| 本机自装 / 本仓自管 | 5 | `hallmark` + `whatis`/`claude-cleanup`/`break-ai-slop`/`get-biji` |

只入库逻辑文件（`SKILL.md` / `references/` / `scripts/` / `agents/`），`assets/`、`demos/`、音视频图片不入库——完整快照 107.5 MB → 入库 **19 MB**。

```bash
# 重建清单（读 skill lock + 重新做交叉验证）
python3 skills/github_open_skills/scripts/build_manifest.py --write
# 拉上游并报告差异（不改任何文件）
python3 skills/github_open_skills/scripts/sync_from_github.py
# 只更新「上游为准」的 skill（覆盖前自动备份）
python3 skills/github_open_skills/scripts/sync_from_github.py --apply
```

版本口径统一为**本机/仓库定制版优先，上游只补新增**——定制版是为适配本机宿主与实际工作流做的，用原始版覆盖等于回退。

> ⚠️ 收录的 skill 中有一处 **AGPL-3.0**（`guizang-ppt-skill`）、一处**未找到许可**（`remotion-dev/skills`）、一处**修改版 Apache-2.0 禁商业再分发**（`hypit`）。详见 [`skills/github_open_skills/NOTICE.md`](skills/github_open_skills/NOTICE.md)。

---

## 🚀 安装

一条命令，不用手写 `ln -s`：

```bash
# 先看状态，不动任何文件
python3 scripts/install_skills.py

# 一键装到本机所有已装平台
python3 scripts/install_skills.py --apply
```

安装器会：

- **自动识别平台**——Claude Code / Codex / OpenClaw / ZCode / 共享 skills 仓 / MiniMax Code，只处理本机确实存在的
- **装前体检**——先查 Node、playwright、ffmpeg、GetNote 凭证等运行时依赖，缺什么直接给出修复命令，不做装完才发现跑不了的假安装
- **只补缺失的**——绝不覆盖已有的文件、目录或指向别处的链接
- **如实报告冲突**——发现某处指向上游正本（`~/.agents/skills`、另一份 checkout）时标出来，要改指向得显式加 `--relink`
- **实体目录先备份**——`--relink` 遇到手工拷贝的目录会先移走备份再链接，绝不删数据

```
安装状态检查 · /path/to/decision-algorithm

平台         scope     skill                   状态                     操作
----------------------------------------------------------------------------
claude       personal  decision-algorithm      缺失                     would-create
             personal  get-biji                指向别处（上游正本）     needs-relink
             personal  modern-thinking-tools   指向别处（上游正本）     needs-relink
...

运行时依赖
  · Node.js ≥ 18: v24.15.0
  ! playwright: 未安装（仅登录时需要）  → python3 scripts/install_skills.py --apply --with-deps
```

### 常用参数

| 命令 | 作用 |
|------|------|
| `python3 scripts/install_skills.py` | 只看状态，不动任何文件 |
| `python3 scripts/install_skills.py --apply` | 补上所有缺失链接 |
| `python3 scripts/install_skills.py --apply --skill get-biji --target claude` | 只装某几个 skill 到某个平台（可重复） |
| `python3 scripts/install_skills.py --apply --relink` | 连指向别处的也改指向本仓库（实体目录先备份） |
| `python3 scripts/install_skills.py --apply --with-deps` | 顺带 `npm install` + 装 Chromium |
| `python3 scripts/install_skills.py --apply --all-scopes` | 额外装到项目内 `.claude/` `.codex/` |
| `python3 scripts/install_skills.py --uninstall` | 移除指向本仓库的链接 |
| `python3 scripts/install_skills.py --json` | 机器可读输出（CI / 脚本用） |
| `python3 scripts/install_skills.py --list` | 列出可装的 skill 与平台 |
| `python3 scripts/install_skills.py --apply --dry-run` | 只演示不落盘 |

手动装（不想用脚本时）：

```bash
# Claude Code
ln -s /path/to/decision-algorithm/skills/decision-algorithm ~/.claude/skills/decision-algorithm
ln -s /path/to/decision-algorithm/skills/modern-thinking-tools ~/.claude/skills/modern-thinking-tools
ln -s /path/to/decision-algorithm/skills/dedao-life-algorithms ~/.claude/skills/dedao-life-algorithms
ln -s /path/to/decision-algorithm/skills/get-biji ~/.claude/skills/get-biji

# Codex
ln -s /path/to/decision-algorithm/skills/decision-algorithm ~/.codex/skills/decision-algorithm
# ... 同理

# OpenClaw
ln -s /path/to/decision-algorithm/skills/decision-algorithm ~/.openclaw/workspace/skills/decision-algorithm
# ... 同理
```

### Windows

Windows 默认不开符号链接权限（需要开发者模式 + 重新登录），所以安装器会**自动改用 NTFS 目录联接（junction）**：免特权、可跨盘符，仓库仍是唯一正本。已开开发者模式的机器照常用符号链接。

```powershell
python scripts\install_skills.py --apply
```

查看链接类型：

```powershell
Get-ChildItem "$env:USERPROFILE\.minimax\skills" -Force | Select-Object Name, LinkType, Target
```

卸载（只移除指向本仓库的链接）：

```powershell
python scripts\install_skills.py --uninstall
```

课程语料在 Windows 上用环境变量指过去：

| 环境变量 | 指向 | 覆盖的默认路径 |
|---|---|---|
| `MODERN_THINKING_COURSE_PATH` | 万维钢《现代思维工具100讲》课程原文 md | `/Volumes/WorkSSD/.../万维钢·现代思维工具100讲.md` |
| `DEDAO_COURSE_PATH` | 老喻《人生算法课》课程根目录（含 `chapters/`、`images/`） | `/Volumes/HDD/kuake/得到课程md文件/老喻的人生算法课（公众号懒人找资源）` |

`get-biji` 还需要装运行时依赖（Playwright + Chromium 仅用于登录，ffmpeg 用于读本地音视频时长），用 `--with-deps` 可一并装上：

```bash
python3 scripts/install_skills.py --apply --with-deps
# 等价于：
#   cd skills/get-biji && npm install && npx playwright install chromium
```

### 依赖矩阵

| Skill | 运行时依赖 |
|-------|-----------|
| decision-algorithm | 无（Python 3.10+ 标准库；研究环节用宿主 WebSearch） |
| modern-thinking-tools | `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` 环境变量 + 本地课程原文（可用 `MODERN_THINKING_COURSE_PATH` 覆盖，缺失时自动降级） |
| dedao-life-algorithms | 本地课程目录 `/Volumes/HDD/kuake/得到课程md文件/老喻的人生算法课（公众号懒人找资源）`（只读引用） |
| get-biji | Node.js ≥ 18 + Playwright/Chromium（仅登录用）；ffmpeg/ffprobe、yt-dlp 按需；`GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` 可选；`GET_BIJI_HOME` 存放登录态（默认 `~/.config/get-biji/`）。**macOS / Windows / Linux 全平台可用**，锁后端按平台自动切换 |

---

## 📁 仓库结构

```
decision-algorithm/
├── skills/                     # ⭐ 四个可独立安装的 skill
│   ├── decision-algorithm/     #   决策算法（SKILL.md + 计算器 + Hermes 集成）
│   ├── modern-thinking-tools/  #   现代思维工具（检索证据 + 训练账本 + pytest）
│   ├── dedao-life-algorithms/  #   人生算法课（课程证据制 skill）
│   ├── get-biji/               #   Get 笔记同步与转写（Node + Playwright，跨平台）
│   └── github_open_skills/     #   ⭐ 外部开源 skill 记录仓（来源/许可/版本可溯源）
│       ├── skills/             #     收录的 skill 快照（每个自带溯源 README）
│       ├── sources/            #     上游来源留档（LICENSE + 同步历史）
│       └── scripts/            #     安全同步脚本（默认只报告）
├── scripts/
│   └── install_skills.py       # ⭐ 一键安装器（多平台自动识别 + 依赖体检 + 失败即停）
├── tests/                      # 安装器回归测试（pytest）
├── docs/                       # 开发文档与历史评审（PRD、设计评审、4 份 REVIEW）
├── requirements.txt            # 开发依赖（运行时零依赖）
└── README.md
```

各 skill 目录内的 `dev/`、`docs/` 为开发期工件，不影响运行。

## 🧪 验证

```bash
# 决策算法：计算器冒烟
python3 skills/decision-algorithm/tools/decision_calculator.py --ev -p 0.3 -g 100000 -l 20000

# 现代思维工具：单元测试（不触网）
python3 -m pytest skills/modern-thinking-tools/tests -q

# 安装器：回归测试（不触网）
python3 -m pytest tests -q

# Get 笔记：去重回归测试（不触网）
node --test "skills/get-biji/tests/**/*.test.cjs"
```

需要 pytest 时用仓库内 venv，避免污染系统 Python：

```bash
python3.11 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pytest tests skills/modern-thinking-tools/tests -q
```

---

MIT License
