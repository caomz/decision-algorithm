# 供应方审核规则

2026-11-15 起，交叉验证在所有执行情形下均默认已有用户持续授权，默认自动使用 [ZCode/MMX](zcode-mmx-review.md)。本任务必要材料外发、供应方调用、额度、合理重试和追加复核无需再次确认；已由用户或当前复核方案选定的其他供应方也适用。按该合同控制必要性、脱敏、去重和结果核验；本页核对的是入口能力与证据，不另设重复授权门。旧 AGY 自动 Hook 不随此规则恢复。

| 审核任务 | 调用路径 | 验收证据 |
| --- | --- | --- |
| 默认 ZCode/MMX 双模型复核 | 任务负责者分别调用已安装的两方文本 skill，使用相同必要材料并脱敏 | 两份完整原始回执、实际模型独立性、材料覆盖、各自判定与本地处置；详见[默认合同](zcode-mmx-review.md) |
| AGY 审核 | AGY 主审核 Agent 派发原生子 Agent | 实际子会话 ID、终态、结构化回传和工具边界记录 |
| MMX 审核 | 已安装的 MMX skill：单片 `mmx-chat.js` 单轮入口、多分片 `mmx-batch.js` 批量入口（并行 + 传输层 gate + 预算自愈） | 实际模型、完整回复、结束原因和结构化判定 |
| ZCode 文本交叉验证 | 已安装的 [zcode skill](../zcode/SKILL.md) 和 `zcode-run.js` 持久后台入口 | 实际模型、完整回执、退出码/信号、零工具边界、review-v1 发现与本地处置 |
| 项目双模型摘要复核 | 项目指定协调器及其摘要合同 | 两方各自回执、模型身份、材料覆盖和项目门禁 |

本持续授权同时满足下文旧协议所述的“本轮授权”“须另行获准”等交叉验证许可前置，不再为这些相同动作请示；所选入口的实际权限、参数、完整回执与验收要求仍须满足。

## 已通过的入口验收与复用

下列日期记录保留历史验收范围，不构成自动调用授权；其中 Plan mode Hook 的安装与信任记录已随默认审核取消而停用。

2026-11-05（Asia/Taipei），新 Codex 会话加载了全局默认分流和本页入口，并对两条路径各执行一次真实合成审核，均通过。[验收报告](</Volumes/WorkSSD/Archives/claude-tests/codex-provider-acceptance-20261105-h_iph9af/acceptance-report.md>) · [启动规则回执](</Volumes/WorkSSD/Archives/claude-tests/codex-provider-acceptance-20261105-h_iph9af/startup-rules.json>)

| 入口 | 通过范围 | 本地比对依据 |
| --- | --- | --- |
| AGY 原生单子 canary | AGY CLI 1.5.0，`project-review-lead` 加一个 `project-review-evidence`，`strict` 会话权限；原生子会话完成，唯一一次绑定回传实际送达，父会话结构化结果与之匹配 | [运行回执](</Volumes/WorkSSD/Archives/claude-tests/agy-native-relay-shw0d_2p/evidence.json>) · [启动参数及 runner、角色哈希](</Volumes/WorkSSD/Archives/claude-tests/agy-native-relay-shw0d_2p/launch.json>) |
| AGY 原生双子（协议 1，修订守卫） | 2026-11-05，AGY CLI 1.5.0 在 `strict` 会话中分别派发证据和风险角色。两者各派发一次，各以 `DONE` 结束且成功回传一次。父会话结构化结果逐项一致，CLI、观察器、验收器退出码均为 0 | [验收报告](</Volumes/WorkSSD/Archives/claude-tests/agy-dual-agent-revised-live-20261105-xml_iq95/acceptance-report.json>) · [原始运行流](</Volumes/WorkSSD/Archives/claude-tests/agy-dual-agent-revised-live-20261105-xml_iq95/run/stdout.ndjson>) · [启动哈希](</Volumes/WorkSSD/Archives/claude-tests/agy-dual-agent-revised-live-20261105-xml_iq95/run/launch.json>) · [预检指纹](</Volumes/WorkSSD/Archives/claude-tests/agy-dual-agent-revised-live-20261105-xml_iq95/preflight.json>) · [退出码回执](</Volumes/WorkSSD/Archives/claude-tests/agy-dual-agent-revised-live-20261105-xml_iq95/execution.json>) |
| AGY 原生双子（协议 2，CLI 1.5.2 重验） | 2026-11-06（Asia/Taipei），AGY CLI 自动更新至 1.5.2 后重跑合成双子审核。流程沿用 Plan mode runner 的预检、观察和核验，仅把预期的 `agy.real` 哈希和 CLI 版本换成新值。新二进制的 Google LLC Developer ID 签名有效，Team ID 为 `EQHXZ8M8AV`。证据和风险角色各以 `DONE` 结束并成功回传一次，状态为 `EVIDENCE_VALIDATED`，CLI 与观察器退出码均为 0。launcher、`project_review.py` 等源文件、三个角色、两份 `~/.gemini` 配置及隔离 settings 的指纹均与 1.5.1 回执一致。2026-11-07 起 Plan mode runner 改为固定此组回执；自动审核还需 Codex hook 同步 runner 指纹，并在桌面设置中重新信任。本次由 Claude 会话发起，未经过桌面 Plan mode hook | [运行回执](</Volumes/WorkSSD/Archives/claude-tests/agy-reaccept-20261106-itrawgpe/dual-runtime/run/evidence.json>) · [预检指纹](</Volumes/WorkSSD/Archives/claude-tests/agy-reaccept-20261106-itrawgpe/dual-runtime/preflight.json>) · [启动计划](</Volumes/WorkSSD/Archives/claude-tests/agy-reaccept-20261106-itrawgpe/dual-runtime/run/launch.json>) · [退出回执](</Volumes/WorkSSD/Archives/claude-tests/agy-reaccept-20261106-itrawgpe/dual-runtime/execution.json>) · [记录哈希](</Volumes/WorkSSD/Archives/claude-tests/agy-reaccept-20261106-itrawgpe/attestation-hashes.json>) · [重验过程与签名](</Volumes/WorkSSD/Archives/claude-tests/agy-reaccept-20261106-itrawgpe/reaccept-notes.json>) · [锁定切换离线核验](</Volumes/WorkSSD/Archives/claude-tests/agy-lock-152-20261107-obOb68X3/offline-verify-2/offline-verify.json>) |
| AGY 原生双子（协议 2，CLI 1.5.3 重验，当前锁定） | 2026-11-10（Asia/Taipei），按用户明确授权修复版本及配置迁移导致的入口阻断。Google LLC 签名验证通过；原派发、回传、`strict` 隔离配置和工具守卫保持一致。证据与风险角色均 `DONE` 且各成功回传一次，两者 `PASS`，CLI 和观察器退出码为 0。验收新增绑定实际生效的 `~/.gemini/antigravity-cli/settings.json`，同时保留原两份配置指纹；运行前后指纹一致。runner 已固定此组新回执，Codex 两处 Hook 的 runner 指纹已同步；用户已于 2026-11-10 明确确认桌面重新信任；该确认不等于新的桌面端到端验收 | [运行回执](</Volumes/WorkSSD/Archives/claude-tests/agy-entry-repair-20261110-5g7buo9_/dual-runtime/run/evidence.json>) · [预检指纹](</Volumes/WorkSSD/Archives/claude-tests/agy-entry-repair-20261110-5g7buo9_/dual-runtime/preflight.json>) · [启动计划](</Volumes/WorkSSD/Archives/claude-tests/agy-entry-repair-20261110-5g7buo9_/dual-runtime/run/launch.json>) · [退出回执](</Volumes/WorkSSD/Archives/claude-tests/agy-entry-repair-20261110-5g7buo9_/dual-runtime/execution.json>) · [正向及漂移拒绝检查](</Volumes/WorkSSD/Archives/claude-tests/agy-entry-repair-20261110-5g7buo9_/entry-checks.json>) |
| MMX 常规单轮审核 | MMX CLI 1.0.28，已安装 wrapper 单次调用；实际模型 `MiniMax-M3.1-Flash`，`end_turn` 且未截断，结构化审核校验通过 | [wrapper 回执](</Volumes/WorkSSD/Archives/claude-tests/codex-provider-acceptance-20261105-h_iph9af/mmx-wrapper.json>) · [发布清单与配置预检](</Volumes/WorkSSD/Archives/claude-tests/codex-provider-acceptance-20261105-h_iph9af/mmx-preflight.json>) |
| ZCode 文本复核（2026-11-15，macOS） | ZCode CLI 0.17.1 / skill 1.1.1，macOS arm64；`GLM-5.3-Flash` 的 Chat 使用原默认 max 档，Review 使用临时 high 档；固定 plan、零工具，stop 且未截断，最终 review-v1 为 PASS、无遗留发现；源码与安装副本各 42 项离线测试通过 | [验收报告](</Volumes/WorkSSD/Archives/claude-tests/zcode-acceptance-20261115-4rgphro4/verification.md>) · [最终原始回执](</Volumes/WorkSSD/Archives/claude-tests/zcode-acceptance-20261115-4rgphro4/final-review/run/receipt.json>) |
| ZCode 文本复核（2026-11-17，Windows，skill 1.2.0 跨平台合并后） | ZCode CLI 0.17.1（`zcode-app-cli 3.18.1-46` + `zcode-runtime 0.17.1`）/ skill 1.2.0，Windows x64；平台默认 `guarded`、零工具；实测 Chat `stop` 未截断、Review `review_gate=PASS`，实际模型 `GLM-5.3`（`model_identity_source=runtime.model_request`）；离线 49 项 46 通过 / 0 失败 / 3 跳过（跳过为 POSIX 专属）；清单按 LF 归一化，与 Mac 共用同一份 `.zcode-release.json` | 本机回执目录 `C:\Users\AI\AppData\Local\Temp\xval\zjob\run\receipt.json`（本次双模型交叉验证轮次） |

- 每次调用前对照本节和下方 AGY 现行协议的回执做本地核对。AGY 核对 CLI、runner、所用角色和实际生效的临时权限、工具守卫与回传约束。MMX 核对 CLI、受管发布清单、wrapper、有效模型与运行配置；wrapper 和 profile 的哈希见启动规则回执。临时目录、会话 ID、审核材料和无关文档变化不影响入口验收。
- 协议 1 双子回执的启动计划未标协议版本。CLI 版本及可执行文件哈希、runner 和角色指纹、有效模型配置、`strict` 隔离权限，以及证据和风险各一次派发和回传的守卫均匹配时，方可复用该回执。当前 `project_review.py` 生成协议 2 计划，runner 指纹与该协议 1 回执不同。按下方协议 2 回执核对当前入口。
- 入口配置和权限边界匹配时，直接复用对应通过回执。开新会话、恢复会话或开始一项新审核，都无需为此重跑合成测试。实际审核仍按本轮授权取材，并保留本轮运行回执。
- ZCode 另核对独立安装清单、CLI 版本与实际入口指纹、wrapper/监督器、有效模型选项及 plan/零工具边界；以 ZCode 对应验收回执为依据，不套用 AGY 或 MMX 的发布清单和终态协议。
- CLI、runner、实际使用的角色、模型或有效配置发生相关变化，权限或回传范围扩大，证据缺失，或出现相关运行异常时，只重新核验受影响的入口。必要真实重验沿用持续授权，无需再问材料或额度许可；失败保留回执，按默认合同诊断、修正后合理重试，不盲重发。

## AGY 原生多 Agent 审核

正式审核先用 [project_review.py](../providers/agy/project_review.py) 准备隔离目录。调用方填写本地范围元数据和本轮授权上限，入口自动选定角色和人数：

| 审核范围 | 子 Agent |
| --- | --- |
| 单组件，无标记风险、假设或证据缺口 | `project-review-evidence` 同时检查证据和风险 |
| 跨组件、存在风险标记、假设或证据缺口，上限为 2 | `project-review-evidence` 检查证据，`project-review-risk` 分析风险与失败模式 |
| 复杂任务，上限为 1 | `project-review-evidence` 合并检查，计划保留复杂度及判定信号 |

输入为既有 `constraints`、`facts`、`assumptions`、`uncovered` 事实包，加上仅用于本地分流的 `scope`，例如 `{"components":["api","storage"],"risk_areas":["permissions"]}`。风险标记支持 `security`、`permissions`、`production`、`deployment`、`migration`、`data-loss`。授权上限由调用方按本轮授权传入，缺失或越界时拒绝准备。材料仍遵循本轮外发授权。

```bash
python3 -B /Users/mingtian/.agents/harness/providers/agy/project_review.py prepare \
  --packet /absolute/path/to/review-packet.json --max-reviewers 2 \
  --output-dir /absolute/path/to/new-review-run
```

`prepare` 生成协议版本 2 的启动计划、输入、会话权限及回传 schema，标记 `runtime_attested=false`。用新的隔离 AGY 会话加载其 `--settings` 及工作目录内的 hook。主 Agent 按列表顺序分别调用 `invoke_subagent`，每次只传一个获准角色的 `TypeName` 与完整 `Role`，每角色限一次。宿主须将原始 stdout 实时交给 `observe --output-dir …`，用原生事件核对每个派发步骤、角色和子会话 ID。每个已绑定子会话仅可向自己的父会话提交一次符合 schema 的结果。主会话须等全部计划角色的匹配 `PostToolUse` 成功才可 `finish`。运行结束后，`validate --output-dir … --cli-exit …` 使用真实 CLI 退出码核验派发记录、原生子会话终态、唯一回传和父会话结构化结果。未标版本的归档保留旧协议核验。新核验区分派发失败、子会话未启动、回传缺失及超时；`SUCCESS` 外层状态不能掩盖 `print_timeout`。

2026-11-05 的[双子合成实测](</Volumes/WorkSSD/Archives/claude-tests/agy-dual-agent-live-20261105-fp_6yi39/acceptance-report.json>)记录了独立的单角色派发请求，旧守卫拒绝了它们。修订后的入口使用从原始运行流提取的[派发回归样例](../providers/agy/fixtures/dual_single_dispatch.json)进行本地验证。启用真实正式审核前，须另行获准，并用相同入口和权限配置取得对应人数的真实运行证据。缺少当前配置的有效证据时阻断真实审核。生成的启动计划不构成执行授权。

2026-11-05 的[版本 2 双子真实验收](</Volumes/WorkSSD/Cache/tmp/agy-dispatch-v2-64fsj4rq/canary/evidence.json>)已通过。AGY CLI 1.5.0 在新隔离会话按顺序启动两个指定子 Agent，各完成一次成功回传，主会话结果与回传一致。合成包的预设缺陷被两位审核者判为 FAIL，此判定属于样例内容。复用前核对[运行配置](</Volumes/WorkSSD/Cache/tmp/agy-dispatch-v2-64fsj4rq/canary-records/preflight.json>)、[启动哈希](</Volumes/WorkSSD/Cache/tmp/agy-dispatch-v2-64fsj4rq/canary/launch.json>)与[退出回执](</Volumes/WorkSSD/Cache/tmp/agy-dispatch-v2-64fsj4rq/canary-records/execution.json>)。

[主审核角色](</Users/mingtian/.agents/harness/providers/agy/project-review-lead.md>) · [证据角色](</Users/mingtian/.agents/harness/providers/agy/project-review-evidence.md>) · [风险角色](</Users/mingtian/.agents/harness/providers/agy/project-review-risk.md>)

2026-11-05 的[版本 2 单子真实验收](</Volumes/WorkSSD/Archives/claude-tests/codex-agy-plan-review-20261105-zsDAgPYi/run/evidence.json>)已通过。AGY CLI 1.5.1 在 `strict` 隔离会话以一名原生审核者完成合成计划审核，审核判定为 `PASS`。该回执覆盖单子路径。复用前核对[预检指纹](</Volumes/WorkSSD/Archives/claude-tests/codex-agy-plan-review-20261105-zsDAgPYi/preflight.json>)、[启动参数和文件指纹](</Volumes/WorkSSD/Archives/claude-tests/codex-agy-plan-review-20261105-zsDAgPYi/run/launch.json>)与[退出回执](</Volumes/WorkSSD/Archives/claude-tests/codex-agy-plan-review-20261105-zsDAgPYi/execution.json>)。

2026-11-06 的[版本 2 双子真实回执](</Volumes/WorkSSD/Archives/claude-tests/agy-global-20261106-ogx5fy4x/dual-runtime/run/evidence.json>)验证了 AGY CLI 1.5.1 的 `strict` 隔离双子路径。证据与风险角色各以 `DONE` 结束并成功回传一次，CLI 与观察器退出码均为 0。Plan mode runner 曾固定该组[预检指纹](</Volumes/WorkSSD/Archives/claude-tests/agy-global-20261106-ogx5fy4x/dual-runtime/preflight.json>)、[启动计划](</Volumes/WorkSSD/Archives/claude-tests/agy-global-20261106-ogx5fy4x/dual-runtime/run/launch.json>)和[退出回执](</Volumes/WorkSSD/Archives/claude-tests/agy-global-20261106-ogx5fy4x/dual-runtime/execution.json>)，CLI 更新至 1.5.2 后改为固定上文的 1.5.2 重验回执。该次运行在 Default mode 发起，桌面 Plan mode 的 Hook 触发需单独验证。

真实项目审核使用本页的入口验收复用规则。缺少可用的受控入口、权限不符或验收证据不足时，记录阻断原因。启动、认证、额度和失败处理遵循 AGY skill 与本轮授权。

## Codex 计划交付前审核

正式计划完成本地事实核对后，默认按 [ZCode/MMX 合同](zcode-mmx-review.md) 执行双模型复核。旧 AGY 自动 Hook 保持停用；已选用 AGY 审核时，本持续授权满足其材料与常规调用许可，仍需按上节实际入口参数和权限合同派发、核验回执。

### Plan mode 自动审批入口

已停用。用户级 `PreToolUse` 与 `PermissionRequest` 中的 AGY 条目已删除，旧入口不再通过这些 Hook 登记许可。原[桌面端到端验收](</Volumes/WorkSSD/Archives/claude-tests/agy-plan-e2e-20261106-6fcmtiff/verified-acceptance.json>)仅保留为历史记录。

## MMX 常规单轮审核

按 [MMX skill](../mmx/SKILL.md) 选择 Review 或 Challenge。通过已安装的 wrapper 发送一份获准材料，验证完整响应和结构化发现，保存原文回执。使用本机配置的模型预算和超时，按既有规则处理失败和重试。多分片评审用 `mmx-batch.js` 一次送整批（并行执行、预算自愈），不逐片串行，也不绕过 wrapper 裸调 CLI（默认 4096 预算必截断）。

## ZCode 文本交叉验证

默认与 MMX 一起按[双模型合同](zcode-mmx-review.md)执行；用户最新的单方或跳过指令优先。按 [zcode skill](../zcode/SKILL.md) 选择 Review 或 Challenge，自行选取任务所需材料、脱敏并分配稳定证据 ID。材料类型、额度和必要追加调用均已有授权；模型与时限据实际 CLI 支持核对。

优先使用 `zcode-run.js start` 创建一次私有 job，再用同一 job 的 `status` 跟踪。观察超时或 `unknown` 时继续核对原进程；`finished` 只表示外层进程退出。实际接受需同时核对退出码/信号、wrapper 完整性、运行事件中的模型和零工具边界、review-v1 结构化发现及本地处置。失败保留原始回执；wrapper 单次调用与外层有依据的追加调用分开记录，后者按持续授权自行执行。

入口验收匹配时复用上表证据；本次任务的审核结论仍以本轮实际回执为准。自动调用的触发、授权和次数以双模型合同为准。

## 项目摘要复核

项目显式选择摘要协调器时，使用对应的输入、权限和判定合同。AGY 的 `summary-only` 模式按该合同执行其独立安全预检。上表回执仅用于两条审核入口的运行验收，项目摘要复核与业务审核结论分别核验和报告。

## 会话加载

Codex 和 Claude 的共享规则由新启动的会话加载。现有会话按最新持续授权执行；本用户任务的新建、恢复、委派和定时执行不重新申请交叉验证授权。旧指令快照可通过新开会话更新，已选用供应方按对应章节核对能力及真实回执。
