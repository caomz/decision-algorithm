# 双模型协调器使用合同

使用已安装 Skill 的真实绝对路径调用 Python 入口。运行状态默认保存于 `/Volumes/WorkSSD/Archives/gstack-cross-validation`。各次运行的完整模型正文在私有目录中留档。

```json
{
  "workspace": "/absolute/local/workspace",
  "stage": "implementation",
  "scope": "static",
  "materials": ["relative-file.md", "tests/result.json"],
  "materials_complete": true,
  "packet": {
    "constraints": ["A high-risk action requires independent approval."],
    "facts": [{"id": "F1", "text": "An offline test exercised the rejection branch."}],
    "assumptions": ["Production state matches the verified version."],
    "uncovered": ["Live deployment behavior."]
  },
  "host_model": "gpt-6.1-sol",
  "models": {"agy": "gemini-4-argon-high", "mmx": null},
  "round_id": "unique-stable-id-for-this-turn",
  "thread_id": "opaque-local-chat-id",
  "policy_version": "2026-11-04-v1",
  "external_summary_approved": true
}
```

- `workspace`、`materials`、`round_id` 和 `thread_id` 只用于本地记录及判定。外发内容仅来自经过审阅的 `packet`。自动模式要求既有授权，`external_summary_approved` 记录本轮材料符合授权范围。
- `scope` 可用 `static`、`live`、`deploy`、`destructive`。完整且非空的静态材料清单、`policy_version` 和可核验的精确模型才允许在 24 小时内复用。动态范围使用本轮证据。
- 模型为空时沿用各 CLI 当前配置。应使用真实模型身份核对独立性。若模型身份缺失或不匹配，保留原文及限制。
- `doctor` 和 `run --dry-run` 只读检查。`run` 每方最多提交一次。同一轮的已知结果直接读回。重叠的相同请求共用运行回执。
- 协调器仍直接调用 `mmx-chat.js`，其子进程时限覆盖本机队列等待、wrapper 时限和收尾余量。`LOCAL_QUEUE_TIMEOUT`、`LOCAL_USAGE_ERROR` 与 `LOCAL_SLOT_ERROR` 不触发供应方阻断；用 `cli_invoked` 和 `queue_wait_ms` 区分本地等待与真正的 CLI 调用。
- 用 `show <run_id>` 查看单次结果，`stats` 查看用量和失败分类。用 `record-disposition <run_id> --provider agy|mmx --finding INDEX --outcome adopted|rejected|pending --reason <reason>` 保存本地处置。
- 完成实际恢复后，使用 `clear-block --provider agy|mmx --profile <profile_id> --reason <reason>` 解除对应的本地阻断。profile ID 可从 `stats` 取得。
- AGY 前置阻断验收由本机证据及绑定版本判定。缺少有效证据时，`doctor` 报告原因，双模型调用保持关闭。
