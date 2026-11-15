# decision-algorithm · 人生与思维 Skills 集合

> *"做重大人生决策不靠一时的热情，而靠可重复的决策算法。"*

一套围绕**人生决策与思维工具**的 AI skills 集合仓库，收录三个互补的决策 skill，外加一个笔记检索工具：

| Skill | 定位 | 何时用 |
|-------|------|--------|
| [`decision-algorithm`](skills/decision-algorithm/) | EKB 决策算法（期望值 + 凯利公式 + 贝叶斯） | 要不要、该不该、该投多少——可量化的重大决策 |
| [`modern-thinking-tools`](skills/modern-thinking-tools/) | 现代思维工具人生顾问（100 个思维工具） | 看清问题、选框架、给行动与复盘点——广义人生诊断 |
| [`dedao-life-algorithms`](skills/dedao-life-algorithms/) | 老喻《人生算法课》行动闭环 | 个人成长、小步试验、把选择转成可观察的反馈问题 |
| [`get-biji`](skills/get-biji/) | Get 笔记同步、检索与音视频转写（工具型） | 要把账号里的录音/笔记变成可搜的本地文本，或把链接转成逐字稿 |

前三者边界：`modern-thinking-tools` 负责广义诊断与工具选择；涉及胜率、赔率、期望值、凯利仓位等量化判断时交给 `decision-algorithm`；成长类卡点与行动闭环用 `dedao-life-algorithms`。

`get-biji` 是**工具型** skill，不做人生判断——它只负责把素材变成证据，拿到证据后交给上面三者。

---

## 🚀 安装

每个 skill 独立安装（按需选择，symlink 到对应平台的 skills 目录）：

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

`get-biji` 还需要装运行时依赖（Playwright + Chromium 仅用于登录，ffmpeg 用于读本地音视频时长）：

```bash
cd /path/to/decision-algorithm/skills/get-biji && npm install && npx playwright install chromium
```

### 依赖矩阵

| Skill | 运行时依赖 |
|-------|-----------|
| decision-algorithm | 无（Python 3.10+ 标准库；研究环节用宿主 WebSearch） |
| modern-thinking-tools | `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` 环境变量 + 本地课程原文（可用 `MODERN_THINKING_COURSE_PATH` 覆盖，缺失时自动降级） |
| dedao-life-algorithms | 本地课程目录 `/Volumes/HDD/kuake/得到课程md文件/老喻的人生算法课（公众号懒人找资源）`（只读引用） |
| get-biji | Node.js ≥ 18 + Playwright/Chromium（仅登录用）；ffmpeg/ffprobe、yt-dlp 按需；`GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` 可选；`GET_BIJI_HOME` 存放登录态（默认 `~/.config/get-biji/`） |

---

## 📁 仓库结构

```
decision-algorithm/
├── skills/                     # ⭐ 四个可独立安装的 skill
│   ├── decision-algorithm/     #   决策算法（SKILL.md + 计算器 + Hermes 集成）
│   ├── modern-thinking-tools/  #   现代思维工具（检索证据 + 训练账本 + pytest）
│   ├── dedao-life-algorithms/  #   人生算法课（课程证据制 skill）
│   └── get-biji/               #   Get 笔记同步与转写（Node + Playwright）
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

# Get 笔记：去重回归测试（不触网）
node --test "skills/get-biji/tests/**/*.test.cjs"
```

---

MIT License
