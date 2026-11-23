# zcode skill

ZCode CLI 的文本复核封装支持单轮 chat、review、challenge。当前 SKILL / wrapper 版本 **1.6.1**，目标 ZCode runtime CLI `0.17.1`。Mac 请求预算绑定到经过传输审计的 bundle 字节，升级原生 CLI 后应核对传输实现并更新指纹。单次调用的原生请求预算证据记在 `native_request_budget`。

> **1.5.2 MAC-08（隔离源码修复）**：chat/review/challenge 统一用 `--attach` 发送完整 `buildPrompt` 渲染后的私有 UTF-8 文件，argv 只保留短指令，不再有 24 KiB 小输入泄漏。离线 fake CLI 验证了正文、schema 与 E IDs、哈希、拒绝回退和禁用工具；**真实 ZCode 0.17.1 对附件的模型输入消费尚未验证**，不得视作真实供应商或敏感材料验收通过。Mac 正本未切换。
>
> **1.4.0 修复**：`--prompt` 走 argv 撞 Windows 命令行 ~32 KiB 上限会 `spawn ENAMETOOLONG`（大材料复核直接失败）。超过 24 KiB 的 prompt 改为 `--attach` 传私有文件，argv 只保留短指令。
>
> **1.3.0 新增** `scripts/zcode-batch.js` 分片批量入口：有界并发池并行执行多片 `zcode-chat.js`，聚合传输层与内容级（review_gate）双 gate；默认每片最多一次请求，只有当次显式传入 `--allow-paid-retry` 才可能发生第二次收费调用。单片与易断线场景仍用 `zcode-run.js`。

## 合并来源

本 skill 由两套平台版本合并而来，此前各自独立演进：

| 来源 | 提交 | 平台 | 贡献 |
|---|---|---|---|
| Mac 正本记录 | `f052716` | macOS arm64 | `plan` 权限模式、单行 `--version` 解析、Keychain 认证桥接 |
| Windows 适配 | `b11300e` | Windows x64 | `guarded` 权限模式、两行 `--version` 解析（`zcode-app-cli` + `zcode-runtime`） |

合并后两个平台共用**同一份代码和同一份 `.zcode-release.json`**。

## 两台机器的安装形态

| 平台 | 安装位 | 更新方式 |
|---|---|---|
| Windows | 各 harness 的 `skills/zcode/` 都是指向本仓库的 junction（`~/.zcode`、`~/.agents`、`~/.claude`、`~/.codex`、`~/.minimax`、`~/.openclaw` 等） | 改本目录即两端生效，无需重钉清单 |
| macOS | `~/.claude/skills/zcode/` 等安装位 | 同步本目录后用 `node scripts/repin-release.js` 重钉清单 |

两端的清单内容相同（哈希按 LF 归一化计算），差别只在更新动作：Windows 的 junction 自动跟随仓库，macOS 需要显式同步并重钉。

## 两处必须统一的差异

### 1. 权限模式

CLI 接受 `build, edit, plan, yolo, guarded`，本 wrapper 只用两个只读模式：

| 平台 | 默认模式 | 依据 |
|---|---|---|
| macOS / Linux | `plan` | Mac 端既有验收结论（`provider-agent-review.md`） |
| Windows | `guarded` | Windows 端既有适配（`b11300e`） |

`ZCODE_CLI_MODE` 可显式覆盖为 `plan` 或 `guarded`，其它值直接拒绝（`usage_error`）。实际使用的模式记入每次运行的 `launch.json`，回溯时以该文件为准。

```text
ZCODE_CLI_MODE=plan node scripts/zcode-chat.js --prompt-file <file>
```

### 2. 发布清单的行尾

仓库在 Windows 上以 CRLF 检出、在 macOS 上以 LF 检出。若按原始字节计算哈希，一端生成的清单在另一端必然失配，`checkInstall()` 会以 `install_mismatch` 直接阻断模型调用。

因此清单哈希统一按 **LF 归一化**内容计算：

```text
sha256(file.replace(/\r\n/g, "\n"))
```

同一份清单在两个平台双向有效。

> 实测：Windows 工作区 `SKILL.md` 去 CR 后哈希 `e7c2062c817f633758b40bf4fc345fb992c46eb550fe95fa226ee521e23ae627`，与 Mac 清单中的哈希逐字符相同——两端文件内容本就一致，差异仅在行尾。

## 更新后必须重钉清单

改动任何受管文件后，清单按设计失效，`checkInstall()` 会拒绝调用。重钉：

```text
node scripts/repin-release.js          # 重写 .zcode-release.json
node scripts/repin-release.js --dry-run # 只报告不写入
```

**Mac 正本同步了 wrapper 变更后，同样必须重钉**，否则安装副本会报 `install_mismatch`。

清单只收本 skill 发布的文件类型：`.md`、`.js`、`.cjs`、`.json`、`.yaml`，后缀区分大小写。隐藏条目（`.DS_Store`、`._*`、`.git`）、`__pycache__`、`node_modules` 和其他类型的文件不入清单，并在 stderr 逐条列出，所以系统或工具写入的元数据不会让 `checkInstall()` 自锁。新拷贝出的副本还没有清单时，同样能完整重钉。

## Windows 适配要点

以下几处在合并时补齐，均由真实运行验证：

- **PATH 上的同名目录**：`D:\Program Files (x86)\zcode` 是应用安装目录。`findCli` 现在只接受普通文件，跳过目录（Windows 的目录也会通过 `accessSync(X_OK)`）。
- **npm shim**：Windows 的 `zcode.cmd` 与 POSIX 的无扩展名 `zcode` 都是 npm 生成的包装脚本。`resolveLaunch` 解析出其中的 `node_modules/<pkg>/bin/<entry>.js`，用 `process.execPath` 启动真实入口，**不执行任何 shell**。非 npm 形态的 `.cmd/.bat` 仍返回 `unsupported_launcher`。
- **进程树终止**：进程已自然退出时 `taskkill` 返回"找不到进程"。此时先探测 PID 存活，已退出即记为清理确认，不留清理缺口。
- **Keychain 桥接**：仅 macOS 生效。Windows 无符号链接权限时该用例跳过，其余断言（跨平台惰性、查询失败）仍执行。

## 验证

```text
node --check scripts/zcode-chat.js
node --check scripts/review.js
node --check scripts/zcode-run.js
node --check scripts/zcode-batch.js
node --check scripts/repin-release.js
node --test tests/zcode-chat.test.js
node --test tests/zcode-batch.test.js
node --test tests/repin-release.test.js
node scripts/zcode-chat.js --version
node scripts/zcode-batch.js --version
```

## 平台验收状态

| 层级 | macOS arm64 | Windows x64 |
|---|---|---|
| 静态检查 | 已执行 | 已执行 |
| 离线测试（49 项） | 已执行 | 已执行：46 通过 / 0 失败 / 3 跳过 |
| 真实模型调用 | 已执行（`GLM-5.3-Flash`） | 已执行（`GLM-5.3`，`mode=guarded`，`tool_calls=0`） |

跳过项为 POSIX 专属：进程树终止、Keychain 链接、wrapper 猝死信号捕获。
