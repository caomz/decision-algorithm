# 第三方来源与许可声明

本仓收录的 skill 全部来自公开的开源项目，版权归各自作者所有。此处逐来源记录**来源、作者、许可与同步到的版本**，便于追溯。

**收录范围说明**：本仓只收录「MiniMax Code 全局 skills ∩ ZCode 全局 skills」交叉验证一致的那批 skill，共 49 个，另加 4 个本仓自管的，合计 51 个。收录时**只入库逻辑文件**（`SKILL.md` / `references/` / `scripts/` / `agents/`），`assets/`、`demos/`、音视频图片不入库。

---

## ⚠️ 三处需要注意的许可情况

### 1. `op7418/guizang-ppt-skill` —— GNU AGPL-3.0（copyleft）

`guizang-ppt-skill` 及其在 `skills/guizang-ppt-skill/` 下的副本受 **AGPL-3.0** 约束。AGPL 是 copyleft 许可：本仓公开收录其源码，意味着**该部分以 AGPL-3.0 发布**，任何基于它的修改版同样须以 AGPL-3.0 发布并提供源码。

许可原文：[`sources/op7418__guizang-ppt-skill/LICENSE`](sources/op7418__guizang-ppt-skill/LICENSE)。

如果本仓要以**非 AGPL 许可**整体发布，需把该 skill 移出或替换为非 copyleft 版本。

### 2. `remotion-dev/skills` —— 未找到许可文件

上游仓库根目录与各 skill 子目录均**没有 LICENSE 文件**，README 里也没有许可声明。在无明示许可的情况下，默认保留全部权利。本仓收录其 4 个 skill（`remotion-best-practices`、`remotion-captions`、`remotion-create`、`remotion-render`）仅作记录快照用途。

标记文件：[`sources/remotion-dev__skills/NO_LICENSE_FOUND.md`](sources/remotion-dev__skills/NO_LICENSE_FOUND.md)。

要公开发布的话，建议向上游确认许可，或把这 4 个 skill 移出本仓。

### 3. `hypit-ai/hypit` —— 修改版 Apache 2.0（禁止商业再分发）

允许非商业的 fork / 修改 / 再发布（须同许可发布），但**禁止**：未经书面授权的多租户服务运营、商业性再分发。

许可原文：[`sources/hypit-ai__hypit/LICENSE`](sources/hypit-ai__hypit/LICENSE)。

### 4. `open.feishu.cn` —— 未发布许可

飞书开放平台的 `/.well-known/skills/` 端点未附许可文件。收录的 11 个 `lark-*` skill 版权归飞书所有。

---

## 来源总表

| 来源 | 类型 | 许可 | skill |
|---|---|---|---|
| [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill) | GitHub | MIT (c) 2026 Suyuan | break-ai-slop、claude-cleanup、get-biji、whatis |
| [microsoft/azure-skills](https://github.com/microsoft/azure-skills) | GitHub | MIT (c) Microsoft | azure-cloud-migrate、azure-compute、azure-messaging、azure-quotas、azure-upgrade、microsoft-foundry |
| [iswalle/getnote-cli](https://github.com/iswalle/getnote-cli) | GitHub | MIT (c) 2026 iswalle | getnote-auth、getnote-kb、getnote-note、getnote-search、getnote-tag |
| [jackwener/opencli](https://github.com/jackwener/opencli) | GitHub | Apache-2.0 | opencli-adapter-author、opencli-autofix、opencli-browser、opencli-usage |
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | GitHub | **未找到** ⚠️ | remotion-best-practices、remotion-captions、remotion-create、remotion-render |
| [anthropics/skills](https://github.com/anthropics/skills) | GitHub | Apache-2.0（`skills/frontend-design/LICENSE.txt`） | frontend-design |
| [shadcn/ui](https://github.com/shadcn/ui) | GitHub | MIT (c) 2023 shadcn | shadcn |
| [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design) | GitHub | MIT (c) 2026 alchaincyf | huashu-design |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | GitHub | MIT (c) 2026 Leonxlnx | design-taste-frontend |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | GitHub | MIT (c) 2024 Next Level Builder | ui-ux-pro-max |
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | GitHub | MIT (c) 2026 Matt Van Horn | last30days |
| [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill) | GitHub | **AGPL-3.0** ⚠️ | guizang-ppt-skill |
| [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) | GitHub | MIT (c) 2026 歸藏 | humanizer-zh |
| [hypit-ai/hypit](https://github.com/hypit-ai/hypit) | GitHub | **修改版 Apache-2.0** ⚠️ | hypit |
| [juliusbrussee/caveman](https://github.com/juliusbrussee/caveman) | GitHub | Apache-2.0 | caveman |
| [obra/superpowers](https://github.com/obra/superpowers) | GitHub | MIT (c) 2025 Jesse Vincent | brainstorming |
| [supabase/agent-skills](https://github.com/supabase/agent-skills) | GitHub | MIT (c) 2026 Supabase | supabase-postgres-best-practices |
| [typesafe-ai/skills](https://github.com/typesafe-ai/skills) | GitHub | MIT (c) 2026 TypeSafe AI | typesafe-ai |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | GitHub | Apache-2.0 | agent-browser |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | GitHub | MIT (c) 2026 Vercel | find-skills |
| [walkinglabs/learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) | GitHub | MIT (c) 2025 WalkingLab | harness-creator |
| [open.feishu.cn](https://open.feishu.cn/.well-known/skills/) | well-known | **未发布** ⚠️ | lark-apps、lark-base、lark-calendar、lark-doc、lark-drive、lark-event、lark-im、lark-meeting、lark-shared、lark-slides、lark-task |
| 本机自装 | 无上游 | 随快照收录 `LICENSE` | hallmark |

每个来源的许可原文与同步到的 commit 都留档在 `sources/<来源>/` 下（`LICENSE` + `UPSTREAM_COMMIT`）。

---

## 二次来源

- `whatis` 的思路源自 Anthropic 的 [@trq212](https://x.com/trq212) 分享的 ELI5（Explain Like I'm Five）。
- `get-biji` 的 skill 本体基于 [skychentian/GET-biji](https://github.com/skychentian/GET-biji)。

---

## 本地改动说明

MIT 等许可允许修改与再分发，但需保留版权与许可声明。本仓对部分 skill 做了本地改动，逐项记录在对应目录的 README 或 `PROVENANCE.md`：

| Skill | 改动性质 |
|---|---|
| `break-ai-slop` | 触发条件收窄为「显式要求或复杂任务」，不再强制每次输出推理步骤；核心约束不再覆盖宿主指令与用户授权 |
| `whatis` | 改为宿主工具无关的出图路由：优先使用宿主可视化 / artifact 能力，回退时才自建自包含 HTML；唯一临时目录不覆盖旧文件；返回绝对路径；Plan / 只读模式下不创建文件 |
| `get-biji` | 新增跨平台锁、只读去重清单、认证加固、cron 非交互接入、`--keep` / `--out` 等；已覆盖上游全部修复 |
| `claude-cleanup` | 与上游 HEAD 一致，无本地改动 |

其余 47 个 skill 与上游逐文件一致（`last30days`、`ui-ux-pro-max` 例外——上游已前进，入库取的是更新版本，详见 [`CROSS_VALIDATION.md`](CROSS_VALIDATION.md)）。
