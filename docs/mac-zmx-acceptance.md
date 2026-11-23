# Mac 专用 ZCode + MMX 安全修复：隔离验收

> 本文件只描述 Mac 修复分支 `cloud/mac-zmx-safety-20261122` 的验收操作。不会自动修改 `main`、用户的 WorkSSD 发布正本、Keychain、登录配置或任何共享 skill 软链接。Windows 10 适配另有工作流，本文件不替它验收。

## 1. 事实与阻断

- Mac 历史安装正本由用户现场记录为 `e0d6aad`，开发目录曾为 `f052716` 且有未提交文件。这不是本次账号对 Mac 本机的实时取证。
- 已在新分支修复 Batch 安全默认值、ZCode 审核票资格、回执独占发布、ZCode Job 快照与取消结果保存，并针对 MMX Job 增强本地 runtime 绑定。受管安装树尚未替换。
- MAC-06 已接入 `review-run.js run --backend real`。2026-11-23 在本机 macOS arm64、Node 26.13.1、ZCode 0.17.1、mmx 1.0.29 上完成单包验收。GLM-5.3-Flash 和 MiniMax-M3.1-Flash 分别从同一份合成材料准确读回随机值，两票有效，轮次 `COMPLETED`、裁决 `PASS`。离线 `verify` 返回 `integrity=ok`、`replay=match`。
- Stage 4 的 macOS hosted runner 并非用户 Mac。315 秒代理长请求、Keychain、真实模型、各 harness 发现情况均必须本机另验收。
- MAC-08 的完整渲染 prompt 通过私有 `--attach` 文件投递，argv 只含固定短句。上述 MAC-06 实机回执在零工具调用下读回了仅存在于小包中的合成值。本次观测覆盖该小包，归档保留其渲染字节数和摘要。
- **B0-PREP 代理勘误**：仓库 `skills/mmx/scripts/mmx-chat.js::cliLaunch` **保留**代理环境及 CLI 配置的 proxy，检测到代理只记录 `proxy_limited`；它剥离的是 `MINIMAX_BASE_URL` 末尾的 `/v1`，**不是代理剥离**。旧自定义 bash 包装器的代理处理属于另一条执行链，不能套用到仓库 wrapper。
- **B0-PREP Guard 勘误**：`fetch-timeout-guard.js` 仅设置 undici dispatcher 的 `headersTimeout:0/bodyTimeout:0`，初始化 `applied` **不是网络出站拦截或地址/端口授权证明**；`preloaded` 也不能证明真实 CLI 后续没有替换 dispatcher。
- **验收范围切分**：315 秒 **Node 合成回环** ≠ **实际 mmx-cli 经过仓库 wrapper 的回环** ≠ **真实供应商请求**；三者必须单独计数、单独标记，不互推 PASS。历史 Mac 报告的 315 秒是合成 Node 对照，不是 B0 真实 CLI 已通过。
- MAC-06 的模型身份分别取自 ZCode 的 `runtime.model_request` 事件和 MMX 的 `response.model`，轮次记录列出实际模型族和各侧资格。
- **Node 范围**：Mac 报告中 Node v24.15.0 的完整 487 项回归与 Node v26.13.1 的单一统一审核套件 247/247 必须分开归档；**Node 26 的 247 项不代表第二 Node 完整 487 项通过**。
- **B0 独立门禁**：参见 [B0-PREP 证据范围、原生隔离调查和待批 B0-RUN 单](mac-b0-prep.md)。没有真实监听的禁止端口 canary、完整子进程/凭据/代理隔离证明前，`MAC09_REAL_CLI_LOOPBACK=BLOCKED`、`AUTHORIZATION=NOT_GRANTED`。无需为这些勘误重跑旧 487 项或重复 315 秒。

## 2. 隔离克隆（不改本机已安装 skill）

在 Mac 的 zsh 终端运行：

```bash
set -e
AUDIT_ROOT="$(mktemp -d "$HOME/zmx-mac-isolated.XXXXXX")"
git clone --single-branch --branch cloud/mac-zmx-safety-20261122 \
  https://github.com/caomz/decision-algorithm.git "$AUDIT_ROOT/source"
cd "$AUDIT_ROOT/source"
git rev-parse HEAD | tee "$AUDIT_ROOT/HEAD.txt"
git status --short
node --version
```

把 HEAD 原样记录在独立目录；如果远程分支在验收期间移动，停止并重新核验 SHA。**不要**在原本带 13 个未提交文件的开发目录直接 `git reset --hard`、`git pull` 或 `install_skills.py --apply --relink`。

先记录旧安装实际位置和软链接，绝不在核查期间修改：

```bash
for d in "$HOME/.zcode/skills" "$HOME/.agents/skills" \
  "$HOME/.codex/skills" "$HOME/.minimax/skills" "$HOME/.claude/skills"; do
  for name in zcode mmx; do
    [ ! -e "$d/$name" ] && [ ! -L "$d/$name" ] && continue
    ls -ld "$d/$name"
    readlink "$d/$name" || true
  done
done
```

## 3. 零收费离线回归（从克隆的仓库根目录）

```bash
node --check skills/zcode/scripts/zcode-chat.js
node --check skills/zcode/scripts/zcode-run.js
node --check skills/zcode/scripts/zcode-batch.js
node --check skills/mmx/scripts/mmx-chat.js
node --check skills/mmx/scripts/mmx-batch.js
node --check skills/mmx/scripts/mmx-job.js
node -e "require('./skills/zcode/scripts/zcode-chat.js').checkInstall();"
node --test skills/zcode/tests/*.test.js
node --test skills/mmx/tests/*.test.js
node --test skills/zcode-mmx-review/tests/*.test.js
node skills/zcode-mmx-review/scripts/review-run.js doctor --offline --json
git diff --check
```

本次代码提交已更新 `skills/zcode/.zcode-release.json`；**不要**为了通过检查而在用户 Mac 安装目录执行无审计的重钉。若 `checkInstall()` 失败，停止安装、追查实际文件与 SHA 差异。

## 4. CLI 和运行时发现检查（不请求模型）

```bash
command -v zcode || true
command -v mmx || true
zcode --version
mmx --version
node skills/zcode/scripts/zcode-chat.js --version
node skills/mmx/scripts/mmx-chat.js --version
node skills/zcode/scripts/zcode-batch.js --version
node skills/mmx/scripts/mmx-batch.js --version
```

ZCode 目标 runtime 是 `0.17.1`；Mac 曾报告 mmx-cli `1.0.29`，须以本机实际 `mmx --version` 为准，不能用旧记录替代。Mac 只读 ZCode 权限模式默认 `plan`，不启用通用工具。无法解析 CLI、认证未就绪或配置代理路径不明时，不继续收费验收。

## 5. 真实模型与长任务测试（需新的明确授权）

MAC-06 通过隔离 checkout 的统一入口派发。准备非敏感短材料，令 `PACKET` 指向审核包、`NEW_RUN_DIR` 指向一个尚未创建的目录，从 checkout 根目录执行：

```bash
node skills/zcode-mmx-review/scripts/review-run.js run --backend real --packet "$PACKET" --out "$NEW_RUN_DIR"
node skills/zcode-mmx-review/scripts/review-run.js verify --run "$NEW_RUN_DIR"
```

每侧各发起一次；核对原始 stdout、独立进程退出码、模型身份来源、终态、材料绑定和裁决。单侧内容 `FAIL` 也可构成有效审核。长任务、回环、持久 job 和各 harness 的独立验收另见下列条目。

- ZCode：确认原生 `zcode-runtime 0.17.1`、`ZCODE_CLI_MODE=plan`、零工具调用、Keychain 可用，不将密钥或长正文复制到 argv。
- MMX：验证响应中的真实 MiniMax 模型身份，代理状态 `fetch_timeout_guard`，纯思考/截断/404/429 时绝不自动重发。仅在实际回环本地测试服务、实际 mmx-cli 和用户同意的时长下做 315 秒合成请求。
- Job：使用新目录，确认 `start/status/verify`、源文件在 start 后被修改/删除、双 worker、取消、异常退出、快照损坏时不会重放。旧任务目录只检查，永不清理 `worker.lock` 或未知 slot。
- Harness：逐个验证 ZCode、OpenClaw、Gemini、Codex、MiniMax Code、Claude Code 的**实际**发现及一次准许的运行；软链存在本身只算路径检查。未安装、未登录或 CLI 不可用就标记 `NOT_EVALUATED`，不要伪造 PASS。

## 6. 发布与回退

仅在隔离目录离线回归、原生 CLI、受管文件清单、真实单次请求、取消和恢复均通过且用户再次确认后，才能规划与现有 WorkSSD 正本的原子切换；本分支的 GitHub 提交不构成切换授权。

保留原安装目录与清单、已存在的 Job/slot/归档及用户未提交修改；已知 Mac 现场报告为 53 项，但每轮须以本机只读现测为准，不清理或重置。代码回滚使用新提交 `git revert <具体 SHA>`，不强推、不自动合并、不重启远端状态未知的请求。若证据不完整、真实审核未实现、未实机验证，则发布结论 `NOT_EVALUATED` 或 `FAIL`，不得称为 Mac 全流程生产就绪。
