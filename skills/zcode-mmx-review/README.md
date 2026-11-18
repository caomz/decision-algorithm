# zcode-mmx-review · ZCode/MMX 双模型交叉验证执行规则

> 本目录是**交叉验证规则文档**（非 skill，无 `SKILL.md`，不会被一键安装器当成可安装项）。
> 配套的 skill 本体在同级的 [`../zcode/`](../zcode/) 与 [`../mmx/`](../mmx/)。

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
