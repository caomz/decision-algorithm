# C1-C11 交付状态（以代码和证据为准）

| 编号 | 本包实际实现 | 原技能接入/验证 |
| --- | --- | --- |
| C1 | `ny_carrier.js` 原子替换候选、失败保全、无自动抢锁 | 未接入、Windows 目标语义未测 |
| C2 | `ny_sms_state.js` 领取前后状态与调用方绑定 | 旧登录脚本未接入；未修改生产载体 |
| C3 | 新短信消息去重、可信来源时间字段与有效期校验接口 | 必须确认实际短信供应商 TTL 与消息来源 |
| C4 | 新状态机无生产占位回退 | 原 `login_4a`、`ny_autologin`、`login_cdp` 尚未修改，**未修复上线** |
| C5 | 新状态模块有行为单测与双进程测试 | 旧真实入口的直接测试尚未补 |
| C6 | 人工路径阶段合约与假回调测试 | 实际 Playwright/CDP 适配未接入 |
| C7 | `ny_log_guard.js` 的受控事件写入 | 旧 `ny_log.js` 与所有绕过出口尚未接入 |
| C8 | `verify_distribution.js` allowlist + 文件名拒绝 | 实际分发脚本未接入 |
| C9 | 敏感上下文扫描的初步检测 | 实际日志、编码覆盖与 CI 集成未做 |
| C10 | 文件锁、快照比较与双进程竞争检查 | 旧所有写入者尚未迁移；Windows 本机验证未做 |
| C11 | 运行证据哈希和外部清单校验 | 实际审计日志与产物绑定未接入 |

**总状态：`STANDALONE_KIT_TESTED`，`ORIGINAL_SKILL_NOT_PATCHED`，`PRODUCTION_NOT_APPROVED`。**

## R1 增量（2026-11-23，隔离测试）

- 消息去重日志不再截断历史；容量上限显式 fail-closed（尚未设计真实生产历史迁移）。
- 审计关联标识不再是从可能低熵值生成的公开可枚举 SHA-256。
- 目标文件链接拒绝、分发备份命名与文本编码检查已强化。
- 增加 `npm run probe:windows`，在非 Windows 环境返回 `NOT_EVALUATED`。
- 离线 Node 测试：21/21 PASS（Linux 容器）。
- GitHub 项目：当前未找到原技能仓库；远端分支、原有入口接入、Windows 本机验证均 NOT_EVALUATED。
