# V2.1 Phase 3：MMX 持久任务候选

## 启用边界

`mmx-job.js` 只接受显式 `--backend fixture`，默认启用状态为 `false`；`--backend real` 和未指定 backend 的提交在读取材料、创建任务目录之前拒绝。fixture 通过现有 `mmx-batch.js` 和 `batch-safety.js` 执行固定的 `mmx-job-fixture.js`，不运行真实 CLI，不访问供应方，也不把 fixture 的协议字段视为真实传输证据。

| 项目 | 当前边界 |
| --- | --- |
| 持久任务默认启用 | `false` |
| 允许后端 | 显式 `fixture` |
| 原生 macOS/Windows 生命周期 | `NOT_EVALUATED` |
| 固定真实 CLI 传输验收 | `NOT_EVALUATED`，须另行核验 |
| 本地记录一致性 | `verify` 可检查；不等于远端证明 |
| 自动重发/自动重试 | 禁止 |

本次延续 Phase 3 的现有实现：持久监督器和绑定校验取自 [`b45456ee32da074e1d4c36135012ab0b0a2a30c3`](https://github.com/caomz/decision-algorithm/commit/b45456ee32da074e1d4c36135012ab0b0a2a30c3)，原持久任务入口来自 [`62ce109928a528d09a98fc7cf7f9354b0a585749`](https://github.com/caomz/decision-algorithm/commit/62ce109928a528d09a98fc7cf7f9354b0a585749)，单槽锁原语来自 [`fabc8f62b5c242e424abec321f3eefbe32ebdc55`](https://github.com/caomz/decision-algorithm/commit/fabc8f62b5c242e424abec321f3eefbe32ebdc55)。保留独占目录、永久 worker claim、材料快照、完成记录哈希、只读恢复和保守取消语义。

## 提交与断线查询

以下命令仅用于已验证隔离环境下的离线验收。`ROOT` 是固定的任务根目录，`KEY` 是调用者在首次提交前保存的稳定幂等键；同一次评审断线后继续使用该键与根目录。

```bash
node skills/mmx/scripts/mmx-job.js submit ROOT KEY \
  --backend fixture --prompt-file SHARD.txt
```

入口用 `SHA-256(KEY)` 导出固定 job 目录。相同键、材料和参数返回原 job，`reused: true`；材料、profile、模型、token 预算、截止时间、逻辑分片上限、固定 CLI 版本或槽命名空间改变时拒绝为 `idempotency_conflict`。发现旧目录但其记录缺失、损坏或未完成时返回 `unknown`，保留原目录，不创建另一个任务，不修补、覆盖或重新执行。

首次提交返回的 `job_dir` 用于后续查询：

```bash
node skills/mmx/scripts/mmx-job.js status JOB_DIR
node skills/mmx/scripts/mmx-job.js wait JOB_DIR --wait-ms 1000
node skills/mmx/scripts/mmx-job.js resume JOB_DIR
node skills/mmx/scripts/mmx-job.js verify JOB_DIR
```

`wait` 仅查询，单次等待允许 0～60000ms。宿主等待到期返回 `host_wait_timed_out: true` 和 `query_only_no_cancel_no_resubmit`；不创建取消标记，不杀进程，不重新提交。宿主提交进程退出后，独立监督器继续执行；`SIGHUP` 不触发任务取消。`resume` 始终为 `inspect_only_no_automatic_replay`。正常轮询可能仍返回 `unknown`，因为未取得已校验的终态就不能断言任务已停止。

仍保留 Phase 3 的 `start NEW_DIR --backend fixture ...` 接口，其目录本身作为幂等键；跨会话工作推荐使用上述 `submit ROOT KEY`，不要为超时查询生成新的目录或随机键。

只有显式取消命令会请求取消：

```bash
node skills/mmx/scripts/mmx-job.js cancel JOB_DIR
```

取消写入独占 advisory marker，由持有任务的监督器处理，不根据落盘 PID 向其他进程发信号。无法观察根进程退出或无法证明子树停止时保留不确定性；信号送达不能代替终止证明。

## 并发与截止时间

持久入口的任务内并发固定为 1；同一用户、同一主机的合作持久任务默认共用 `~/.zmx/locks/mmx/slot-0`。锁使用原 Phase 2/3 原子目录和 owner 身份校验，不根据 PID 消失、时间戳陈旧、心跳缺失或 `UNKNOWN` 状态自动回收。占用者异常终止后，后续任务可能被阻断，这是保守恢复语义。

槽覆盖范围是**采用该持久入口且使用同一槽根目录的合作进程**。直接调用 `mmx-chat.js`、`mmx-batch.js` 或裸 CLI 尚未纳入这一跨会话槽，不能据此宣称整台机器上的所有 MMX 调用已全局限流。`--slot-root DIR` 仅用于显式 fixture 隔离命名空间；改变它会改变幂等提交身份，也会离开默认共享范围。

槽等待默认最多 120000ms，可使用 `--slot-wait-ms 0..120000` 缩短 fixture 等待。排队超时不创建 batch，记录 `slot_busy`，不夺取其他持有者的锁。同一任务也不能因槽超时自动重跑。

请求默认 600 秒，wrapper 默认 630 秒，现有 batch 的每分片 supervisor 默认 650 秒。整个 batch 的既有有界预算继续生效；持久监督器在该 batch 预算外保留 20 秒，再执行有界取消。`--shard-max-bytes` 默认 16384、实验范围 8192～16384；它和 `--expected-cli-version` 都进入提交身份与封存参数。超限材料在预约 job 前拒绝，不截断材料或自动切碎证据单位。

## 完成记录与恢复

输入材料和 profile 以独占文件保存并执行文件同步。POSIX 上同时同步任务根目录的父目录、新建 input/worker claim 的目录项以及每次原子记录发布的父目录；provider slot 的根目录、命名空间、owner 文件、获取和释放目录项也执行同步。Windows 目录同步未在此实现中判为已验收，保持 `NOT_EVALUATED`。`request.json` 和 `request-digest.json` 绑定快照、实际参数、固定 fixture、batch 及监督器脚本哈希。等待槽后、启动 batch 前重新校验这些记录；batch 自己继续生成原有每分片 intent、材料快照和终态回执。job 校验把每个回执的材料与 profile 哈希反向核对到该 job，阻止跨版本回执混用。

`worker.lock` 在首次 worker 进入时独占创建，正常结束、失败和崩溃后都不自动删除。再次调用 worker 必须失败，不能作为重发入口。

监督器先同步 stdout/stderr、batch 回执及每分片归档中的文件和目录，再写入并绑定 `execution.json`、`started.json`，最后发布并同步 `completion.json`。只有这一步同步成功后才创建 `completion-confirmed.json`；状态查询要求该确认记录与完成记录绑定。若 completion 已可见但目录同步失败，状态仍为 UNKNOWN，槽仍保留。只有观察到当前进程的干净退出、batch 进程组消失，以及完整绑定的成功 fixture 回执后，才允许释放自己的槽；完成记录发布在释放之前。释放动作另写入与完成记录绑定的 `slot-release.json`。完成记录发布或同步失败、取消不确定、失败传输、worker 崩溃或 owner 被替换时，槽不会被自动释放。释放后的证据保存失败不能据此推断槽仍存在；查询不把缺失释放回执当作释放成功，且始终禁止自动重跑该 job。Windows 下尚无完整原生组消失证明，fixture 也不据此宣称可安全释放。

`status: finished` 表示本地终态记录自洽；batch 的 `transport_gate` 与 `review_gate` 仍分别保留。fixture 成功不能产生真实供应方验收或完整双模型评审 PASS。哈希只能校验本地记录一致性，不能抵抗同权限用户主动整体伪造记录，也不能证明远端完成。不要手工删除锁来绕过 UNKNOWN。

运行中的 job 绑定其脚本版本。升级或切换检出会使与原脚本哈希不符的 job 返回不确定状态；查询和验收应使用创建该 job 的固定 SHA。

## 回归证据

当前 Linux 隔离验证：`mmx-job.test.js` 23 项 + `mmx-provider-slot.test.js` 8 项，共 31 项通过，零失败、零跳过。运行环境使用独立 user/network namespace、唯一 loopback 网卡、外部地址不可达探测和临时 HOME/env allowlist。此项不能替代 macOS/Windows 原生生命周期或固定真实 CLI 传输验收。

覆盖内容包括：默认/real admission 拒绝；600/630/650 保留；stdin 关闭；源文件变更后的快照绑定；重复及三进程并发幂等提交；冲突键拒绝；宿主 wait 超时；宿主退出后的新会话查询；跨任务单槽；缺失、损坏和部分发布记录；材料/回执混用；符号链接；恶意继承环境隔离；排队取消；槽截止时间；失败传输；监督器被 SIGKILL 后不重发；SIGHUP；完成记录发布失败仍持槽；completion 原子链接之后注入目录 fsync EIO，验证 UNKNOWN、无确认记录且继续持槽；分片上限和 CLI 版本参数绑定。
