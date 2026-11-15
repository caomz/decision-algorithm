# break-ai-slop · 专家预检协议

强制 AI 在动手前先找到「真正的行家」，把隐性经验、失败模式和那条决定成败的约束挖出来，避免交付一堆看着完整但没用的通用答案。

| | |
|---|---|
| **来源** | [suyuan2022/suyuan-skill](https://github.com/suyuan2022/suyuan-skill) · `break-ai-slop/` |
| **作者** | 夙愿（X：[@suyuan1711](https://x.com/suyuan1711)） |
| **许可** | MIT（原文见 [`../../sources/suyuan-skill/LICENSE`](../../sources/suyuan-skill/LICENSE)） |
| **上游提交** | `6da5289`（引入）→ `f40ca58`（移除 “Why This Works” 段落） |
| **本目录采用** | **本机定制版**（来自 `/Volumes/WorkSSD/.agents/skills/break-ai-slop`） |

## 与上游版的差异

上游 HEAD 是「每次任务都强制跑完 4 步、并把推理过程全部输出」的激进版；本机版是**克制版**：只在显式要求或复杂任务时才触发，且不暴露内部分 step-by-step 思考。差异集中在四处：

| 位置 | 上游 HEAD | 本目录（本机版） |
|---|---|---|
| `description` | "force the AI to think like a real expert before doing anything"，**任何**非琐碎任务前都触发 | "calibrate complex work with concrete expert criteria"，显式要求或复杂任务才触发，简单编辑与日常提问直接跳过 |
| The Protocol | 所有任务执行前必须完成全部 4 步，不得跳过，不得缩写，**输出**每步推理 | 按需触发；只共享简短结论（相关 expertise、一条具体风险、一条验收标准），私有推理保持内部 |
| Step 4 约束 | 该约束成为执行期**最高优先级规则**，压过所有默认值与惯例 | 该约束只是**用户目标、既有授权与宿主指令之内**的验收标准，不覆盖它们 |
| Execution Rules | 全量输出 + 方向一变就整体重跑 | 按任务规模缩放；只重访**实质变化**的部分；保留原有 scope 与权限 |

采用克制版的原因：全量输出推理既拖慢简单任务，也会和宿主系统的执行边界打架（约束不得覆盖宿主指令与用户授权）。

需要切回上游激进版：`git show 5a6848f:break-ai-slop/SKILL.md`，覆盖本目录 `SKILL.md` 即可。

## 安装

```bash
# Claude Code / Codex / OpenClaw / ZCode / 共享 skills 仓 同理
ln -s /Volumes/WorkSSD/Dev/decision-algorithm/skills/github_open_skills/skills/break-ai-slop ~/.claude/skills/break-ai-slop
```

本目录**只做记录**，不负责安装。正本安装位是 `/Volumes/WorkSSD/.agents/skills/break-ai-slop`，本机已装且可用——同步脚本不会动它。

## 使用

```text
break-ai-slop / anti-slop / slopbreak / 行家模式 / 专家预检 / 防止AI水货
```

也可直接说「别给我水货」「先想清楚再做」「这个别敷衍」。

## 同步

```bash
python3 scripts/sync_from_github.py            # 只看差异，不落盘
python3 scripts/sync_from_github.py --apply    # 对标记为「上游为准」的 skill 执行更新
```
