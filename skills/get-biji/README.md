# get-biji · Get 笔记同步与转写

Get 笔记（biji.com）skill：把账号里的录音、链接、文字笔记同步成本地 Markdown 并可检索；用 Get 的转写额度把抖音 / 小红书 / B 站 / 小宇宙链接，或本地音视频，转成逐字稿。两件事共用同一个 biji.com 登录态。

> 本目录可能是复制安装的快照副本（与正本内容一致）。在 macOS 上正本位于 `/Volumes/WorkSSD/.agents/skills/get-biji`（经 `~/.claude/skills/get-biji` symlink 安装）；快照更新需从正本重新同步。

## 能力

| 能力 | 说明 |
|------|------|
| 同步 | 增量把账号笔记落成 `<笔记目录>/YYYY-MM-DD/HHMMSS_标题.md`；录音逐字稿超过 50 行会拆成 `HHMMSS_标题_原文.md` |
| 检索 | 由粗到细搜总结 → 章节 → 逐字稿，见 [`references/检索.md`](references/检索.md) |
| 转逐字稿 | 链接解析不扣额度；`--file` 本地音视频按音频时长扣 Get 网页端的**每月本地音视频转写时长额度** |
| 去重盘点 | 只读列出同一 `note_id` 的多个总结文件，**不**自动删除、不做版本取舍 |

## 外部依赖

| 依赖 | 说明 |
|------|------|
| Node.js ≥ 18 | 运行时，`package.json` 已声明 `engines.node >= 18` |
| Playwright + Chromium | **仅用于登录** biji.com（约 250MB）；`node -e "require('playwright')"` 不报错即为装好 |
| ffmpeg / ffprobe | 传本地音视频时读取时长 |
| yt-dlp | 下载其他网站音视频后再 `--file` 转写（可选） |
| `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` | 可选，走 GetNote 开放 API 取笔记详情；缺失时回退网页端抓取 |
| `GET_BIJI_HOME` | 可选，状态目录；默认 `~/.config/get-biji/` |
| `GET_BIJI_NON_INTERACTIVE=1` | 定时任务用：允许静默刷新，需重新登录时直接失败，不弹浏览器 |

登录态、同步记录和笔记目录位置都记在状态目录，**重装 skill 不受影响**。

## 安装

用仓库根目录的一键安装器（自动识别平台、装前体检依赖、只补缺失链接）：

```bash
# 从仓库根目录执行
python3 scripts/install_skills.py --apply --skill get-biji --with-deps
```

`--with-deps` 会顺带跑 `npm install` 和 `npx playwright install chromium`（Chromium 约 250MB，**仅用于登录**）。

手动装（不想用脚本时）：

```bash
cd skills/get-biji && npm install && npx playwright install chromium
ln -s /path/to/decision-algorithm/skills/get-biji ~/.claude/skills/get-biji
# Codex / OpenClaw / ZCode / MiniMax Code 同理
```

> Windows 上不要用 symlink：请把整个 skill 目录整体复制到目标位置（如 `~/.claude/skills/get-biji`），否则运行态解析可能出现路径异常。

首次登录：任意脚本在缺登录态时会开一个 Chrome 窗口等你登录 biji.com（最多 10 分钟），登录成功后窗口自动关闭。登录态存在 `GET_BIJI_HOME`（默认 `~/.config/get-biji/`），重装 skill 不受影响。

## 平台支持

macOS / Windows / Linux 全部可用。

| 平台 | 锁后端 | 说明 |
|------|--------|------|
| macOS | `posix-exlock` | 内核 `O_EXLOCK`，进程退出自动释放 |
| Windows / Linux | `portable-exclusive` | 原子独占创建 holder 文件互斥 + 持有者 PID 存活检测，崩溃残留可被接管 |

两套后端对外语义一致：互斥、忙时抛 `SYNC_LOCK_BUSY`（定时任务依赖这个错误码）、canonical 锁文件保留且运行中不删除不替换。

Windows 上默认状态目录 `~/.config/get-biji/` 会解析成 `C:\Users\<你>\.config\get-biji`，能用但不常规；想放到常规位置就设 `GET_BIJI_HOME`：

```powershell
$env:GET_BIJI_HOME = "$env:APPDATA\get-biji"
```

其他 Windows 注意点：

- `ffprobe` / `ffmpeg` 需在 `PATH` 上（`choco install ffmpeg` 或 `winget install Gyan.FFmpeg`）
- Playwright 的 Chromium 正常安装：`npx playwright install chromium`
- 一次性同步建议放后台跑：`Start-Process node -ArgumentList "scripts/sync.js" -NoNewWindow`
- 同步/转写路径一律用绝对路径，Windows 下别用 `/` 混写

## 使用

```bash
cd skills/get-biji

# 同步（首次需指定笔记目录，要绝对路径）
OUTPUT_DIR="/绝对路径/笔记目录" node scripts/sync.js

# 增量同步（目录已记下就不用带 OUTPUT_DIR）
node scripts/sync.js

# 只同步最新的 3 条（第一次建议先试跑）
TEST_LIMIT=3 node scripts/sync.js

# 只同步某天及之后
SINCE_DATE=2026-10-01 node scripts/sync.js

# 链接 → 逐字稿（免费，不扣额度）
node scripts/link-transcript.js "<链接>" --json

# 本地音视频 → 逐字稿（按时长扣额度）
node scripts/link-transcript.js --file "<本地路径>" --json

# 落盘为 Markdown
node scripts/link-transcript.js --file "<本地路径>" --keep --out "<落盘路径>" --json

# 只读去重盘点（不删文件）
node scripts/dedupe.js --notes-dir "/绝对路径/笔记目录" --json

# 同步记录丢了但笔记目录还在：按硬盘上的文件重建
OUTPUT_DIR="/绝对路径/笔记目录" node scripts/rebuild-state.js
```

链接和路径都要加引号——分享链接里的 `?`、`&` 会被 shell 吃掉。退出码 0 且结尾是 `Sync Completed` 表示同步完成；退出码 1 会列出失败的笔记，直接重跑即可只补没拉下来的。

## 目录结构

```
get-biji/
├── SKILL.md                  # ⭐ Skill 入口（首次准备、登录、同步、检索、转写、出错处理）
├── references/检索.md        # 笔记文件格式 + 由粗到细的检索方法
├── scripts/
│   ├── sync.js               # 增量同步（支持 TEST_LIMIT / SINCE_DATE）
│   ├── link-transcript.js    # 链接 / 本地音视频 → 逐字稿（stdout 一行 JSON）
│   ├── api.js                # Get 网页端 + 开放 API 客户端、认证与刷新
│   ├── format.js             # 笔记 → Markdown（总结 / 章节概要 / 待办 / 逐字稿）
│   ├── dedupe.js             # 只读去重盘点
│   ├── rebuild-state.js      # 按磁盘文件重建同步记录
│   ├── paths.js              # 状态目录、笔记目录
│   └── lock.js               # ⭐ 跨平台锁（macOS O_EXLOCK / win32+linux 独占 holder）
├── tests/
│   ├── dedupe.test.cjs       # node:test 回归测试（不触网）
│   ├── format.test.cjs       # 章节时间戳 / frontmatter 重建 / 文件名规则回归（不触网）
│   ├── lock.test.cjs         # 锁的互斥 / 释放 / 崩溃接管回归（不触网）
│   └── test_get_biji_regression.py  # pytest 入口，运行上面的 node:test 套件
├── package.json              # 依赖 playwright；scripts.sync / scripts.dedupe
└── package-lock.json
```

## 验证

```bash
# Node 24 下 `node --test <目录>` 会把目录当模块解析而报错，用 glob 形式
node --test "skills/get-biji/tests/**/*.test.cjs"

# 同一套用例的 pytest 入口；跑之前先清代理变量（宿主代理 env 会让 node 单测假失败）
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NODE_USE_ENV_PROXY
python3 -m pytest skills/get-biji/tests -q

# 登录态检查（不弹浏览器）
node -e "require('playwright')"
```

## 隐私

- **录音逐字稿是私密素材**，笔记目录不要放进会推到公开仓库的路径。本 skill 的 `.gitignore` 已排除 `notes/`、`.auth-state.json`、`.token-cache.json`、`.sync-state.json`、`.link-transcript-ids.json` 等运行态文件，但**只挡 skill 目录内的产物**——真正的笔记目录在仓库外，由你自己保证。
- 凭证、登录态、同步进度只存在 `GET_BIJI_HOME`（默认 `~/.config/get-biji/`），权限 `0600`，**不得自动清除或重建**。Windows 不校验 POSIX 权限位（mode 参数被忽略、组/其他位检查自动跳过），文件保密性依赖所在目录的默认 ACL——不要把 `GET_BIJI_HOME` 指向共享目录等宽权限位置。
- `--file` 会消耗 Get 的月度转写时长额度。上传前先看时长：`ffprobe -v error -show_entries format=duration -of csv=p=0 "<文件>"`（单位秒），超过 30 分钟先跟用户确认。

## 与其他 Skill 的边界

本 skill 是**工具型**的——它只负责把 Get 笔记和音视频变成可检索的本地文本，不做人生判断。检索到的证据要怎么用，交给 [`decision-algorithm`](../decision-algorithm/)、[`modern-thinking-tools`](../modern-thinking-tools/) 或 [`dedao-life-algorithms`](../dedao-life-algorithms/)。三者共用 GetNote 开放 API 凭证，但笔记目录与状态目录互相独立。
