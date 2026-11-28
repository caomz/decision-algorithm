---
name: cross-validation
description: Coordinate the authorized AGY and MMX summary review for a direct Codex or Claude Code task. Use when the project cross-validation policy calls for both reviewers. Track coverage, evidence, and the two independent responses across chats.
---

# AGY/MMX 摘要复核

本技能的 `run` 和 `doctor` 面向 AGY/MMX 摘要组合。项目选择 ZCode/MMX 时，由主会话按项目合同分别调用两方文本入口。此处的 `validate-review` 可单独校验 MMX 回执，AGY 的运行验收只约束需要调用 AGY 的组合。

以当前项目规则判定风险、外发授权和验收范围。先完成本地验证，再为本轮创建一次双模型复核。普通低风险任务按项目规则记 `EXEMPT`。

1. 从已加载的本文件定位 `scripts/cross_validate.py`，调用 `python3` 时优先使用受管的 Python 3.11+（如 `/Users/mingtian/.local/bin/python3.11`，亦兼容系统 Python 3.9，并保持与生成 AGY 安全认证时的解释器一致）。先运行 `doctor`，核对已安装发布清单、CLI 和 AGY 摘要模式的执行前阻断证据。
2. 将本地材料清单与脱敏事实包分别写入同一个私有请求文件。路径、日志、原始代码和文件指纹属于本地材料。事实包只含可外发的抽象约束、事实、假设与未覆盖范围。
3. 先运行 `run --request-file <file> --dry-run` 核对请求，然后按既有外发授权执行 `run --request-file <file>`。同一回合始终使用同一个 `round_id`。相同请求已运行时，从回执读取 run ID，使用 `show <run_id>` 等待或读取结果。
4. 核对两方独立的调用状态、模型身份、证据覆盖和原始判定。本地核验后，用 `record-disposition` 记录采纳、拒绝或待查。聊天展示有效发现、分歧、证据缺口与本地原文链接。

`COMPLETED` 表示两方有效返回、模型独立性可核验且覆盖当前材料。缺少任一条件时报告 `NOT_EVALUATED` 及具体原因。验收与发布授权由项目规则判定。

请求字段、命令和复用规则见 [使用合同](references/usage.md)。
