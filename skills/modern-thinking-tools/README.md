# modern-thinking-tools · 现代思维工具

万维钢《现代思维工具100讲》风格的人生顾问 skill：把具体处境转化为可判断、可行动、可复盘的问题，从 Get笔记知识库检索证据后给出 3 主工具 + 1 校正工具的建议。支持训练 / 复盘 / 顾问 / 直接解释四种模式。

> 本目录是快照副本。**正本**位于 `/Volumes/WorkSSD/Dev/openclaw_mz/skills/modern-thinking-tools`（经 `~/.claude/skills`、`~/.zcode/skills` symlink 安装）。快照更新需从正本重新同步。

## 外部依赖

| 依赖 | 说明 |
|------|------|
| `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` | GetNote（biji.com）开放 API 凭证，环境变量注入 |
| 课程原文 | 相对仓库根解析 `knowledge/raw/05-素材库/万维钢·现代思维工具100讲.md`，可用环境变量 `MODERN_THINKING_COURSE_PATH` 覆盖；缺失时自动进入检索降级模式 |
| 知识库 ID | `0Rp2K3pn`（可用 `--topic-id` 覆盖） |

## 目录结构

```
modern-thinking-tools/
├── SKILL.md              # ⭐ Skill 入口（模式路由、检索门禁、3+1 工具协议）
├── references/           # tool-catalog.json（T001–T100 唯一编号真值）、场景路由、训练协议等
├── scripts/
│   ├── retrieve_evidence.py    # GetNote 语义召回 + 证据包（核心）
│   ├── training_record.py      # SQLite 私有训练账本
│   ├── build_tool_catalog.py   # 课程→工具目录生成
│   ├── install_skill_links.py  # symlink 安装器（面向 openclaw_mz 正本，本副本不适用）
│   ├── render_eval_review.py   # evals 静态评审页
│   └── getnote/                # vendored：GetNote 公共库（common.py，纯标准库）
├── tests/                # pytest 测试（不触网）
├── evals/                # 6 个人工评测用例
├── agents/openai.yaml    # Codex agent 接口
└── test-prompts.json     # 13 个手动前向测试
```

## 验证

```bash
python3 -m pytest skills/modern-thinking-tools/tests -q

# 检索 dry-run（不写 API）
python3 skills/modern-thinking-tools/scripts/retrieve_evidence.py \
  --problem "<问题摘要>" --query "<处境查询>" --query "<机制查询>" \
  --query "<反方查询>" --query "<行动查询>" --stage discovery --dry-run
```

## 与其他 Skill 的边界

- 明确涉及胜率、赔率、期望值、凯利仓位或量化下注时，配合同集合的 `decision-algorithm`；不复制其完整八步流程。
