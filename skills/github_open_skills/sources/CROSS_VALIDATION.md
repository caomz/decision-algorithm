# 交叉验证记录：MiniMax Code × ZCode

> **2026-11-16** · 对两个宿主全局 skill 仓做交叉验证，取交集入库。

## 验证方法

| 步骤 | 做法 |
|---|---|
| 取交集 | 比较 `~/.minimax/skills`（49 项）与 `~/.zcode/skills`（287 项）的 skill 名集合 |
| 校内容 | 对交集内每个 skill，递归遍历全部文件（排除 `node_modules` / `__pycache__` / `.git`），按「相对路径 + 文件内容」计算哈希 |
| 判定 | 两仓哈希一致才算交叉验证通过 |

**结果**：`~/.minimax/skills` 是 `~/.zcode/skills` 的**严格子集**（mx 独有 0 个，zcode 独有 238 个）。交集内 **49 个 skill 全部内容逐字节一致，无分歧**。

## 入库结论

49 个交叉验证通过的 skill 全部收录，另加 4 个本仓自管的：

| 类别 | 数量 | 说明 |
|---|---|---|
| 来自 GitHub 仓库 | 35 | 20 个仓库，见下方来源表 |
| 来自 open.feishu.cn | 11 | 飞书开放平台 well-known 端点，非 GitHub |
| 本机自装（无上游） | 1 | `hallmark`，不在 skills CLI lock 中 |
| 本仓自管 | 4 | `whatis` / `claude-cleanup` / `break-ai-slop` / `get-biji` |

合计 **51 个** skill 收录在 `skills/github_open_skills/skills/`。

## 来源明细

### GitHub（35 个 / 20 个仓库）

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

### open.feishu.cn（11 个，非 GitHub）

`lark-apps`、`lark-base`、`lark-calendar`、`lark-doc`、`lark-drive`、`lark-event`、`lark-im`、`lark-meeting`、`lark-shared`、`lark-slides`、`lark-task`

来源端点：`https://open.feishu.cn/.well-known/skills/<skill>/`（发布完整 skill 树：SKILL.md + references/ + agents/，但无索引文件）。同步时以本机安装版作文件清单逐个拉取，校验哈希后入库。

### 无上游（2 个）

| skill | 说明 |
|---|---|
| `hallmark` | 本机自装，不在 `~/.agents/.skill-lock.json`，无公开来源可追；快照随 `LICENSE` 一并收录 |
| `break-ai-slop` | 上游 [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill)，但本仓收录的是**本机定制版**，见该目录 README |

## 收录策略

**仅逻辑**：只入库 skill 的行为定义——`SKILL.md`、`references/`、`scripts/`、`agents/`。以下不入库：

- 目录：`assets/`、`demos/`、`demo/`、`examples/`、`media/`、`public/`、`dist/`、`build/`、`vendor/`、`node_modules/`
- 文件：音视频（`.mp3` `.mp4` `.wav`）、图片（`.jpg` `.png` `.webp` `.svg` 等）、字体、压缩包

**效果**：完整快照 107.5 MB → 入库 **19 MB**（1270 个文件）。全量快照里 95% 的体积是 demo 素材（huashu-design 47MB 的 mp3、design-taste-frontend 42MB 的图片、last30days 19MB 的素材），不属于 skill 的行为定义。

**逐文件校验**：入库后与本机安装版逐文件比对，49 个中 **47 个逻辑文件完全一致**；另 2 个是上游已前进（见下）。

## 两个「差异」的性质

`last30days` 与 `ui-ux-pro-max` 入库内容与本机安装版不同，核对 git 历史后确认是**上游前进**，不是本地修改被覆盖：

| skill | 本机安装版 | 入库版 | 证据 |
|---|---|---|---|
| `ui-ux-pro-max` | commit `0e8d408`（11-16） | HEAD `902bf61`（11-15 晚） | 上游新增 `--preview` 与 `--tokens` 导出功能（commit `efd9822`、`b6a7900`） |
| `last30days` | v3.39.0 | v4.0.5 | 上游跨主版本，HEAD `8ae0469` |

两者都是上游新增内容，入库取的是更新版本。**本机安装位不受影响**——那里仍是旧版，直到执行 `npx skills update -g`。

## 复现

```bash
cd skills/github_open_skills

# 重建清单（读 ~/.agents/.skill-lock.json + 重新做交叉验证）
python3 scripts/build_manifest.py --write

# 报告差异，不落盘
python3 scripts/sync_from_github.py

# 真正同步（只更新「上游为准」的 skill，覆盖前自动备份）
python3 scripts/sync_from_github.py --apply
```
