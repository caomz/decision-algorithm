# zcode-mmx-review · ZCode/MMX 双模型交叉验证执行规则

> 本目录是**交叉验证规则文档**（非 skill，无 `SKILL.md`，不会被一键安装器当成可安装项）。
> 配套的 skill 本体在同级的 [`../zcode/`](../zcode/) 与 [`../mmx/`](../mmx/)。

---

## 统一入口（离线原型）

[`scripts/review-run.js`](scripts/review-run.js) 是仓库内的**离线统一入口原型**：它把同一个逻辑审核包（由 `skills/zcode/scripts/review.js` 的 `buildPrompt` 生成）交给两侧，并用**同一个** `validateReview` 判定有效票，替代“两边各说各话”的回执口径。它是本轮（2026-11-19/20）改造的落地物，不改变已安装的运行流程。

### 命令

```bash
# 预检（只查本地清单一致性与文件齐全，不启动任何 CLI）
node scripts/review-run.js doctor --offline [--json]

# 一轮 fixture 复核：--backend 必填；real 是保留值，本版在读取任何输入前即以退出码 2 拒绝
node scripts/review-run.js run \
  --backend fixture --scenario both-pass \
  --packet examples/packet.json \
  --out <全新目录> \
  [--timeout-seconds 600] [--max-tokens 524288]

# 组装 v2 材料包（不启动 git、不跑测试，只消费已复核、已脱敏的输入文件）
node scripts/review-run.js pack --out <新包.json> \
  [--facts FILE] [--goal-file FILE] \
  [--patch-file FILE --base <40位SHA> --kind worktree_patch|commit_range [--head <40位SHA>]] \
  [--test-log FILE --test-cmd "命令" --test-exit 0]... \
  [--claims-file FILE]

# 复验一个运行目录（只读；不调用任何 wrapper）
node scripts/review-run.js verify --run <运行目录>
```

fixture 后端只用 `tests/fixtures/backends/` 下的固定假 wrapper 与场景表（`scenarios.json` 里的键才可用）；不接受任何用户传入的脚本路径。

### 有效票与汇总

每一方分别记录**回执和内容校验**与**材料绑定**两项结果。只有同时满足以下条件的响应才有投票资格：正常完成；回执和内容校验通过（wrapper 零退出、stdout 恰好一个严格 JSON、`cli_invoked/exit_code/status/complete/truncated`、模型身份来源与 stop_reason 符合各侧合同、ZCode 另加零工具与 `cleanup_confirmed===true`，且回执 review 与本地 `validateReview` 复判一致）；实收的材料字节与预期一致（ZCode 比对 material+IDs 并重建 P，MMX 比对实收 P；argv 参数同时核对）。

汇总规则：取消 → `NOT_EVALUATED`；任一有资格的票为 `FAIL` → `FAIL`（另一方无效或两方同族都不会抹掉已绑定材料的单方 FAIL）；`COMPLETED` 且两方 `PASS` → `PASS`；其余 → `NOT_EVALUATED`。`COMPLETED` 另要求两方模型族（glm / minimax 前缀表）已知且不同。退出码：`PASS`=0，`FAIL`=1，其他=2。结果始终标注 `backend=fixture`，这不是外部复核。

`--timeout-seconds`（1..3570，默认 600）同时传给两侧：ZCode 收到 `--timeout-seconds T`，MMX 收到 `--timeout T` 与 `--wrap-timeout T+30`；`--max-tokens` 只约束 MMX。fixture 父进程对每个假 wrapper 的截止时间固定为 30 秒。material 上限 192 KiB（v2 补丁另限 128 KiB），超限提示改用 batch 入口按分片手工处理。

### 记录与 verify

每次 run 在 `--out` 下留下完整档案：输入组原字节（`packet.json`、`material.txt`、`evidence-ids.json`、`prompt.txt`）、`request.json`（预计哈希、两侧 argv、判定代码与溯源文件的 sha256）、每侧的 `*-execution.json`、`*-observed-input.json`（实收 argv/环境键名/原字节 Base64；未捕获记 `unobserved`）、stdout/stderr 原样、`result.json`，最后写 `record-manifest.json`。

`verify --run` 先核完整性（清单、路径、文件类型、必需字段、内容摘要），再在**判定代码集**（review-run.js、review.js、review-v1.schema.json）与记录一致时从归档重算绑定、资格、票和结果并比对，报 `replay=match|mismatch`；判定代码不一致时只报 `version_drift`，不声称已复判。`integrity=ok` 且 `replay=match` 才退出 0。这只是**相对本地记录的自洽核查**：不证明上游真的收到，也不能防篡改。

### 材料合同

`packet.json` v1 只认 `facts`（非空）与可选的 `constraints/assumptions/uncovered`；v2 另加 `goal / changes / execution / claims / provenance`，证据 ID 由入口按保留名派生（`GOAL`、`AC-n`、`DIFFSTAT`、`PATCH`、`TEST-n`、`CLAIM-n`，facts 的 id 不得与它们冲突），material 里的补丁与日志正文只在 evidence 出现一次。`run` 会复核补丁的 UTF-8 sha256、可解析性、空补丁与体积上限。`material_warnings`（`no_goal` / `no_changes` / `no_execution` / `claims_without_execution`）只提示材料形状，不影响 gate。

DIFFSTAT 的补丁解析规则：同一文件段内文本 hunk 与二进制标记（`GIT binary patch`、`Binary files … differ`）互斥，第二个二进制标记同样拒收；`GIT binary patch` 段内每个 hunk 必须以空行闭合，且至少有一个 `literal`/`delta` hunk；`Binary files … differ` 行只当二进制标记，不从这一行取路径。路径只从三处取：`diff --git` 头（两侧都能解析且去掉前缀后相同才给出默认名字，改名/复制段两侧不同，以 `rename to`/`copy to` 为准，头两侧引号不对称不拒收）、`rename to`/`copy to` 行、非 `/dev/null` 的 `+++` 行；整段结束仍没有路径则拒收。补丁必须用 git 的默认前缀生成（例如 `git diff --binary --src-prefix=a/ --dst-prefix=b/ <base>`）：`diff --git` 头旧侧 `a/`、新侧 `b/`，`---` 非 `/dev/null` 时 `a/`，`+++` 非 `/dev/null` 时 `b/`；改名/复制段的 `---`、`+++` 行必须分别正好是 `a/` 加 `rename from`/`copy from`、`b/` 加 `rename to`/`copy to` 的名字（git apply 同样核对）；配置了 `diff.mnemonicPrefix` 或 `diff.noprefix` 的补丁会被整份拒收，不静默失真。唯一无法识别的是 `diff.noprefix` 下从 `a/` 目录改名或复制到 `b/` 目录、内容不变的段：它没有 `---`/`+++` 行，与默认前缀补丁无法区分，按 `rename to`/`copy to` 记录，与 git 一致。补丁里的路径按 UTF-8 解码：引号串内的原始多字节字符（含增补平面的 emoji 等）整体还原，名字开头的 U+FEFF 按普通字符保留、不当作 BOM 去掉；引号转义（含 `\NNN` 八进制）聚合出的字节必须是合法 UTF-8，否则整份补丁拒收——与补丁本身不是合法 UTF-8 时的处理相同，与 `core.quotePath` 的取值无关。DIFFSTAT 行的**路径转义规则**与 `git -c core.quotePath=false diff --numstat` 的路径字段逐字一致：路径含 `"`、`\`、C0 控制字符（0x00–0x1F）或 DEL（0x7F）时整体加双引号，`\a \b \t \n \v \f \r \" \\` 用命名转义、其余控制字符用三位八进制 `\NNN`；其余路径（含空格、首尾空格、中文等非 ASCII）原样输出。这样不加引号的行永远不会以 `"` 开头、一个文件只占一行，路径字段无法伪造行边界。DIFFSTAT 行按路径的 **UTF-8 字节序**排序：名字必须是合法 UTF-8 之后，UTF-8 字节序就是原始字节序，与 `git numstat` 的行序一致。`execution.tests[].cmd` 必须是不含 CR/LF 的单行字符串（`pack --test-cmd` 与 `run` 走同一项校验），防止在 material 的 `cmd=…\nexit_code=…` 文本里伪造 `exit_code` 行。

### 限制

- 只在本 checkout 内有效：入口跨目录 require `../zcode/scripts/review.js` 等文件，不解析已安装的同名 skill（`doctor --offline` 会检查这一点）。
- 不替代 Mac 正本的持久 job、排队和重试合同；`mmx-run.js` 的多片合同仍以正本为准。
- 只支持单分片：material 上限 192 KiB。
- **真实 ZCode 在零工具模式下读不到超过 24 KiB 的附件**（实测现象：约 84KB 材料的回执为 `review_schema_mismatch`，模型正文称需"分页读附件"而工具全部被禁；证据存档见运行报告）。真实使用前，ZCode 侧的材料须按 ≤24 KiB 分片（用 zcode-batch 的分片合同）；192 KiB 只是入口自身的上限，对真实 ZCode 不成立。
- 没有进程树监督，也没有 Windows 监督。
- PR #4 对 300 秒限制的缓解是有条件的（依赖本机 `~/.local/bin/mmx` 包装脚本与 `fetch_timeout_guard=custom_launcher` 的路径），本入口不继承该缓解。

---

## 这是什么

`zcode` skill 用 **ZCode CLI** 做文本复核（`/zcode <问题>`、`/zcode review <文件>`、`/zcode challenge <问题>`），`mmx` skill 用 **MMX CLI** 做同步文本复核。两者组成默认的**双模型交叉验证**组合。

| 文件 | 作用 |
|---|---|
| [`zcode-mmx-review.md`](zcode-mmx-review.md) | **默认执行规则**：一轮怎么跑、材料怎么发、结果怎么判、什么时候停 |
| [`provider-agent-review.md`](provider-agent-review.md) | **供应方规则**：外发授权、额度、模型身份核验、验收门禁 |

## 关键规则速览

- **持续授权**：2026-11-15 用户明确授权「进行交叉验证时，无论什么情况都默认授权」。供应方调用、材料外发、额度使用、追加复核与合理重试均视为持续获准，**不再逐轮询问**。本文优先于 skill 中较早的逐次授权要求。
- **默认组合**：ZCode / MMX。两方首轮用相同材料和稳定证据 ID，彼此不接收对方结论。
- **调用方式**：ZCode 单片用 `zcode-run.js start` 的持久 job、多分片用 `zcode-batch.js` 整批并行（Review 模式配证据 ID）；MMX 单片用 `mmx-chat.js --prompt-file` 的同步入口、多分片用 `mmx-batch.js` 整批并行。两方可独立并发。
- **默认时限**：每方 600 秒。ZCode 监督器留 45 秒清理余量；MMX 可用 `MMX_CHAT_REQ_TIMEOUT=600`、`MMX_CHAT_WRAP_TIMEOUT=630`。
- **结果判定**：`COMPLETED` 只表示两方有效完整返回、材料覆盖相同、模型身份可核验且相互独立（当前 GLM 与 MiniMax）。传输/超时/结构校验失败、截断、模型未知或同族时为 `NOT_EVALUATED`。
- **独立性**：以原生传输元数据为准（`receipt.provider` / `receipt.model` / `model_identity_source`），**不采信审核正文里的自称**。不同 CLI 名字不等于模型独立。
- **默认一轮**：有新修改、证据缺口或可修复失败时自行判断补验次数，不再设「超过次数须重新授权」。

## 本机正本

本目录是**记录副本**。实际生效的安装位：

| 内容 | 正本路径 |
|---|---|
| `zcode` skill | 各 harness 的 `skills/zcode/`（macOS：`~/.claude/skills/zcode/`；Windows：`~/.zcode/skills/zcode/` 等） |
| `mmx` skill | 各 harness 的 `skills/mmx/`（同上布局） |
| 本规则文档 | macOS：`/Users/mingtian/.agents/harness/docs/` |

两台机器上 `zcode` 与 `mmx` 都以 junction/符号链接指向本仓库的 `skills/<name>`，仓库内容即唯一基准，改仓库即两端生效。规则文档里的绝对路径链接指向上述**正本**（调用时读的是正本，不是本副本）。要更新本副本，从正本重新同步：

```bash
cp /Users/mingtian/.agents/harness/docs/zcode-mmx-review.md \
   /Users/mingtian/.agents/harness/docs/provider-agent-review.md \
   /Volumes/WorkSSD/Dev/decision-algorithm/skills/zcode-mmx-review/
```

## 校验

`zcode` skill 自带发布清单 `.zcode-release.json`，按 skill 要求「调用前核对文件哈希」。

**哈希按 LF 归一化内容计算**：仓库在 Windows 以 CRLF 检出、macOS 以 LF 检出，按原始字节计算会让一端生成的清单在另一端必然失配。下面的脚本两平台通用（Windows 用 `py -3` 代替 `python3`）：

```bash
cd <repo>/skills/zcode
python3 - <<'PY'
import json, hashlib
from pathlib import Path
root = Path(".")
man = json.loads((root / ".zcode-release.json").read_text())
bad = [r for r, e in man["files"].items()
       if not (root / r).is_file()
       or hashlib.sha256((root / r).read_bytes().replace(b"\r\n", b"\n")).hexdigest() != e]
print("清单校验：", "全部通过" if not bad else f"不符 {bad}")
PY
```

或直接用 skill 自带工具重钉 / 校验：

```bash
node scripts/repin-release.js --dry-run   # 只报告
node scripts/repin-release.js             # 重写清单
```
