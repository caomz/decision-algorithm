# WINDOWS-INSTALL-REPORT.md

**decision-algorithm 在 Windows 上的安装与验收报告**

| 项 | 值 |
|---|---|
| 报告生成日期 | 2026-11-21 |
| 执行主机 | LN-CAOMZ（本机，Windows 11 23H2 内核，x64） |
| 验收对象 | decision-algorithm / zcode / mmx 三个 skill（Windows 侧唯一 Agent = ZCode） |
| **最终状态** | **PARTIAL** |
| **MMX 交叉验证 gate** | **FAIL（FAIL-by-budget 终态）** — 详见 §15 工作日志 |

---

## 1. Windows 版本及架构

| 项 | 实测值 |
|---|---|
| OS | Microsoft Windows NT **10.0.22631.0**（Windows 11 23H2 内核，22631.4602） |
| 架构 | **AMD64 / 64 位**（`$env:PROCESSOR_ARCHITECTURE=AMD64`） |
| PowerShell | **5.1.22621.4391**（Desktop Edition）；另在 PATH 中有 PowerShell 7.6.3，未使用 |
| 执行策略 | MachinePolicy=Undefined，UserPolicy=Undefined，Process=Undefined，**CurrentUser=RemoteSigned**，LocalMachine=Restricted → 有效值 **RemoteSigned** |
| UAC | `EnableLUA=1`（开启）、`ConsentPromptBehaviorAdmin=5`（默认「提示凭据」）→ **本次未修改** |
| 控制台代码页 | 936（GBK） |
| 开发者模式 | 未启用，未修改任何系统安全设置 |
| 进程令牌 | `LN-CAOMZ\caomz`；`IsInRole(Administrator)=False`；完整性级别 **Medium Mandatory Level（S-1-16-8192）** → **全程未提权** |

## 2. Agent 产品和版本

| 组件 | 版本 | 路径 |
|---|---|---|
| ZCode 桌面应用 | **3.19.0**（`ZCODE_APP_VERSION`） | `D:\Program Files (x86)\ZCode\ZCode.exe` |
| ZCode CLI（app-cli） | **3.18.1-46** | `D:\hyperframes-video-mz\node-global\zcode.cmd` → `node_modules/zcode-app-cli/bin/zcode.js` |
| ZCode Runtime | **0.17.1**（= 仓库 wrapper 的 `SUPPORTED_CLI` 硬性要求） | 同上 |
| MMX CLI | **1.0.29** | `D:\hyperframes-video-mz\node-global\mmx.cmd` → `node_modules/mmx-cli/dist/mmx.mjs` |
| npm prefix | 两个 CLI 均在非默认 prefix `D:\hyperframes-video-mz\node-global`（已在用户级 PATH） | — |

**Agent 的 Skill 加载目录**：`C:\Users\AI\.zcode\skills\`（138 个条目，全部为 Junction）。
本次 Agent 会话实际发现并可调用的 skill 即来自该目录：`decision-algorithm`、`mmx`、`zcode` 的 `SKILL.md` 均经由 `C:\Users\AI\.zcode\skills\<name>\SKILL.md` 被加载。

> 未采用任何 Mac 路径（`~/.agents`、`~/.claude`）作为安装目标。`C:\Users\AI\.agents\skills\` 在本机是**既存的共享 skills 仓**（62 个普通目录 + 6 个 junction），本次**未写入、未改动**。

## 3. Git commit SHA

```
基线（GitHub main 最新提交）：e0d6aaddc0f99a07f9d786185686262732b0bece
短 SHA                        ：e0d6aad
合并方式                      ：git pull --ff-only origin main  →  Fast-forward
合并前 HEAD                   ：5bf74a2
```

**原始证据**（`git reflog show main`）：

```
e0d6aad main@{2026-11-21 07:35:25 +0800}: pull --ff-only origin main: Fast-forward
5bf74a2 main@{2026-11-19 08:52:46 +0800}: pull --ff-only origin main: Fast-forward
```

- `git rev-parse HEAD origin/main` → 两者同为 `e0d6aad…`
- `git status -sb` → `## main...origin/main`（无 ahead/behind）
- 合并带来的变更：**77 个文件**（新增 `skills/zcode-mmx-review/` 离线原型 + 更新 `skills/zcode/`）
- **合并与本地既有改动路径的交集 = 0**：
  `git diff --name-only 5bf74a2 e0d6aad -- README.md skills/get-biji/ skills/dario-thinking/ skills/lead-acquisition-coach/` → **0 个文件**。
  快进只重写 incoming 涉及且工作区未改的路径；incoming 未涉及这些路径，故其内容在合并中不可能被写入；`--ff-only` 遇本地修改与 incoming 冲突会直接中止，本次未中止即无冲突。
- 合并前后工作区状态逐行一致（6 个 `M` + 2 个 `??`，内容哈希见 §13.2）。

## 4. Skill 版本

| Skill | 权威版本 | 来源 | 文档中的版本（漂移） |
|---|---|---|---|
| zcode | **1.5.0** | `skills/zcode/scripts/zcode-chat.js` 的 `const VERSION`（`.zcode-release.json` 由其派生，`doctor --offline` 据此比对） | `SKILL.md` frontmatter = 1.4.0，`README.md` = 1.4.0 |
| mmx | **2.4.0** | `skills/mmx/scripts/mmx-chat.js` 的 `const VERSION` | `SKILL.md` = 2.6.0，`README.md` = 2.4.0 / 2.5.0 |
| decision-algorithm | `skills/decision-algorithm/meta.json` = `v2` | — | — |
| zcode-mmx-review | `ENTRY_VERSION` 0.1.0（**非 skill**） | 见下 | — |

> **版本漂移是上游仓库既有问题**（macOS 同样存在），非本次安装造成。两方模型均独立指出此项为 P2 advisory。

> **`skills/zcode-mmx-review/` 按设计不是 skill**：其 README 第 3 行明写「本目录是**交叉验证规则文档**（非 skill，无 `SKILL.md`，不会被一键安装器当成可安装项）」。因此本次**未**将其安装为 skill —— 这不是安装遗漏，强行安装等于修改上游源码，本次禁止。

## 5. 安装路径

**正式安装器**：`scripts/install_skills.py`（仓库唯一正式安装器）
**执行命令**：

```powershell
python scripts/install_skills.py --apply --target zcode --skill zcode --skill mmx --skill decision-algorithm
```

**执行结果**（退出码 0）：

```
平台         scope     skill                   状态                     操作
zcode        personal  decision-algorithm      已链接到本仓库           noop
             personal  mmx                     已链接到本仓库           noop
             personal  zcode                   已链接到本仓库           noop
```

> **本次安装对 Agent 配置目录的实际写操作数 = 0**（三行均为 noop，`apply_row` 对已正确链接的条目立即返回、不落盘）。

**安装后路径拓扑**：

```
C:\Users\AI\.zcode\skills\decision-algorithm  (Junction) → D:\python_code\github_my\decision-algorithm\skills\decision-algorithm
C:\Users\AI\.zcode\skills\mmx                 (Junction) → D:\python_code\github_my\decision-algorithm\skills\mmx
C:\Users\AI\.zcode\skills\zcode               (Junction) → D:\python_code\github_my\decision-algorithm\skills\zcode
```

**目录盘点（安装前 = 安装后）**：TOTAL=**138**，JUNCTION=**138**（非 Junction 0），悬空目标 **0**，`CREATED_TODAY(2026-11-21)=**0**`，CreationTime 跨度 2026-11-16..2026-11-18；Target 分布 `.trae-cn 91 / .workbuddy 21 / .agents 10 / .skills-manager 8 / 本仓库 6 / hyperframes-video-mz 2`。

**未覆盖、未删除、未新增任何既有 Skill、CLI 或数据**；本次会话的全部写操作落点为系统临时目录与本报告文件。

**安装器写面（代码级枚举，`scripts/install_skills.py`）**：第 151 行 `link.parent.mkdir`（仅在需创建链接时）、第 161 行 `cmd /c mklink /J`、第 176 行 `os.rmdir`（删链接）、第 322 行 `shutil.move`（**仅 `--relink` 重指时**把实体目录移为备份）。本次未用 `--relink`。
**Windows 链接实现**：先 `os.symlink_to`，Windows 下 `OSError` → 回退 `subprocess.run(["cmd","/c","mklink","/J",link,target])`，返回 `"junction"`。

## 6. CLI 版本

```
$ zcode --version
zcode-app-cli 3.18.1-46
zcode-runtime 0.17.1        ← wrapper 的 SUPPORTED_CLI = "0.17.1"，精确匹配

$ mmx --version
mmx 1.0.29
```

两个 CLI 均为 PATH 上的 **npm `.cmd` shim**，wrapper 以 `shell:false` + `node <entry>` 方式调用（`.cmd` 文本不交给 shell）。实测 `resolveLaunch(zcode.cmd)` 解析为：

```
command = D:\Program Files\nodejs\node.exe
entry   = D:\hyperframes-video-mz\node-global\node_modules\zcode-app-cli\bin\zcode.js
```

**同名目录跳过验证**：PATH 上存在 `D:\Program Files (x86)\zcode`（即 ZCode 应用目录，大小写不敏感命中）。wrapper 的 `findCli()` 用 `fs.statSync(file).isFile()` 过滤，实测返回 `cli_missing` 而非 `unsupported_launcher` → **跳过逻辑生效**。

## 7. 依赖检查

| 依赖 | 状态 | 说明 |
|---|---|---|
| Node.js | ✅ v22.20.0（npm 10.9.3） | `node --test` / `node:test` 原生框架，无需额外依赖 |
| Python | ✅ 3.12.10 | `scripts/install_skills.py`；pytest 9.1.1 可用 |
| ZCode CLI | ✅ 3.18.1-46 / runtime 0.17.1 | 满足 `SUPPORTED_CLI` |
| MMX CLI | ✅ 1.0.29 | npm prefix `D:\hyperframes-video-mz\node-global` |
| 认证（ZCode） | ✅ | `C:\Users\AI\.zcode\v2\provider_config.json` 存在（4097 B）；wrapper 经 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 共享凭据数据根（`shared_auth_data=true`），不复制凭据内容 |
| 认证（MMX） | ✅ | `mmx auth status` → method=api-key，source=config.json（`C:\Users\AI\.mmx\config.json`，217 B）。**本次全程未读取、未输出任何密钥值** |
| 执行策略 | ✅ 非阻塞 | 验收链路 `.ps1/.cmd/.bat` 计数 = 0，全部走 `.js` + `node` |
| 提权 | ✅ 不需要 | 全程 Medium 完整性级别、非管理员 |

## 8. 离线测试

### 8.1 预检与静态检查

| 检查 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 统一预检 | `review-run.js doctor --offline` | 0 | **20 行全 ok**，末行 `doctor: ok (offline)`；`--json` 形式 `status=ok`、`real_api=not_called` |
| 语法检查 | `node --check` × 9（zcode 5 + mmx 3 + review-run 1） | 全 0 | 全部通过，输出为空 |
| 安装器回归 | `python -m pytest tests -q` | 0 | **11 passed** |
| 金样测试 | `node --test skills/zcode/tests/review-golden.test.js` | 0 | **5/5 通过** |
| fixture 闭环 | `run --backend fixture --scenario both-pass` | 0 | `review_gate=PASS`；`verify --run` → `integrity=ok`、`replay=match` |
| fixture 失败语义 | `run --backend fixture --scenario zcode-fail` | 1 | `review_gate=FAIL`（预期非 0） |
| 保留值拒绝 | `run --backend real` | 2 | `the real backend is not enabled in this version`；**不创建 out 目录** |
| 非法场景 | `--scenario <不存在>` | 2 | usage error；**不创建 out 目录** |
| 版本自检 | 4 个 `--version` | 全 0 | zcode-chat **1.5.0** / zcode-batch 1.0.0 / mmx-chat **2.4.0** / mmx-batch 1.0.0 |

### 8.2 单元 / 契约测试（**不是全绿，如实列出**）

| 测试文件 | 通过 | 失败 | 跳过 | 退出码 | 判定 |
|---|---|---|---|---|---|
| `skills/zcode/tests/review-golden.test.js` | 5 | 0 | 0 | 0 | ✅ |
| `skills/zcode/tests/zcode-chat.test.js` | 47 | 0 | 3 | 0 | ✅（3 跳过均为 POSIX/macOS 专属） |
| `skills/zcode/tests/zcode-batch.test.js` | 25 | 0 | 0 | 0 | ✅ |
| `skills/mmx/tests/mmx-chat.test.js` | 36 | 0 | 0 | 0 | ✅ |
| `skills/mmx/tests/mmx-batch.test.js` | 18 | 0 | 0 | 0 | ✅ |
| `skills/mmx/tests/mmx-clean-temp.test.js` | 6 | 0 | 0 | 0 | ✅ |
| `skills/zcode-mmx-review/tests/delivery-zcode.test.js` | 7 | 0 | 0 | 0 | ✅ |
| `skills/zcode-mmx-review/tests/review-run.test.js` | 51 | **1** | 0（另 54 cancelled） | **1** | ❌ **真实 Windows 产品级限制** |
| `skills/zcode-mmx-review/tests/packet-v2.test.js` | 80 | **19** | 0 | **1** | ❌ **检出伪影**（LF 化后 99/99 通过） |
| `skills/zcode-mmx-review/tests/delivery-mmx.test.js` | 1 | **3** | 0 | **1** | ❌ **fixture 可移植性缺陷** |

**三类失败的根因与性质（均经根因实验证明）**：

1. **`review-run.test.js`（真缺陷）** — 唯一失败断言「SIGTERM mid-run cancels but preserves the bound FAIL」expected 2 / actual null。
   根因实测：Windows 上 `child.kill('SIGTERM')` 直接 `TerminateProcess`，子进程 `process.on('SIGTERM')` 处理器**不执行**（实测 `handler_ran=false`），父进程只见 `close(code=null, signal='SIGTERM')`；一个永不 settle 的 promise 使 `node:test` 事件循环提前解析，**级联取消**余下 54 例（单独重跑后段套件通过：1 pass / 退出码 0）。
   产品级含义：对真实 runner 发 SIGTERM 时**不写 result.json**，`review-run.js` 的优雅取消 / 退出码 2 路径在 Windows 上不可达。
2. **`packet-v2.test.js`（检出伪影）** — 19 个 diff 形状完全一致，唯一差异是 expected 多一个尾随 `\r`。
   根因：仓库**无 `.gitattributes`** 且全局 `core.autocrlf=true` → `.numstat` 真值 fixture 被检出成 CRLF，测试按 `\n` 切分未归一化。
   反证：把 `skills/{zcode,mmx,zcode-mmx-review}` 复制到树外并字节级转 LF 后重跑 → **99 通过 / 0 失败**。
3. **`delivery-mmx.test.js`（fixture 缺陷）** — 3 例均为 `ENOENT` 打开 `<tmp>/mmx-dump.json`。
   根因：fixture 只安装**无扩展名**的 `mmx`，而 `mmx-chat.js` 的 `findMmx()` 在 win32 只探测 `.exe/.cmd/.bat` → 返回 null → 回执 `cli_missing`，假 CLI 从未启动。
   生产路径不受影响：真实 `mmx.cmd` 已被 `npmShimEntry` 正确解析为 `shell:false`（§11 真实调用佐证）。

> 注：`skills/zcode-mmx-review/tests/**` 未被仓库根 README 的验证清单收录，但本次已全量执行。

## 9. Windows 专项测试

| # | 测试项 | 判定 | 关键实测证据 |
|---|---|---|---|
| T1 | **路径分隔符 / 空格 / 非 ASCII** | ✅ PASS | 在 `…\Temp\winacc 真实 空格\`（含中文+空格）下：`zcode-chat.js --version` → `{"status":"version","version":"1.5.0"}` 退出码 0；中文路径的 prompt 被真实读取（后续才在 `usage_error`/`unsupported_launcher` 处失败，证明读取成功）；中文 prompt 原文完整上 argv |
| T2 | **MSYS 风格路径拒绝** | ✅ PASS | `MSYS_NO_PATHCONV=1` 传 `/c/Users/AI/x.txt` → `usage_error:"prompt path is MSYS-style; convert it with cygpath -w…"`，退出码 1，`cli_invoked=false`（未触模型） |
| T3 | **进程退出码** | ✅ PASS | zcode-chat：无参→0(usage JSON)、文件不存在→1(file_missing)、`--version`→0、review 缺 ids→1、`--timeout-seconds 0`→1；review-run：doctor→0、`--backend real`→2、非法 scenario→2（后两者均不创建 out 目录）。stdout「恰好一个 JSON」：zcode 全部路径成立；mmx 除 `--version`（源码声明的纯文本兼容例外）外成立；review-run 的 usage 错误走 stderr、stdout 为空 |
| T4 | **Node 子进程 / npm shim** | ✅ PASS | `resolveLaunch(zcode.cmd)` → node + `zcode-app-cli/bin/zcode.js`；其 `--version` 输出 `zcode-runtime 0.17.1` = SUPPORTED_CLI；PATH 同名目录被跳过（→ `cli_missing`）；zcode 与 review-run 全部 spawn 点 `shell:false`，`taskkill` 以 argv 数组传入，无 cmd.exe 拼接 |
| T5 | **符号链接 / junction** | ✅ PASS | 安装器 `create_link()` 真实返回 `"junction"`；`mklink /J` 退出码 0；PowerShell 识别 `LinkType=Junction`、`Attributes` 含 `ReparsePoint`；删除 junction 后**源目录数据完好**。另：Node `lstat` 对 junction 返回 `isSymbolicLink()=true`，`checkInstall()` 能识别 junction 篡改（无 Windows 盲区） |
| T6 | **CRLF/LF 与 SHA256** | ✅ PASS | 无 `.gitattributes`，全局 `core.autocrlf=true`，`git ls-files --eol` 显示 `i/lf w/crlf`；Python 与 Node `hashFile()`（同一 CRLF→LF 归一化算法）三方结果一致且等于 manifest；`checkInstall()` 在全 LF 与全 CRLF 两份检出副本上**均通过**，而原始字节 sha256 确实不同 → 一份清单两平台通用 |
| T7 | **权限 / 执行策略 / 文件锁** | ✅ PASS | 有效执行策略 RemoteSigned，验收链路 `.ps1/.cmd/.bat` 计数 0 → 不构成阻塞；受管文件置只读后 `checkInstall()` 仍通过（已还原属性）；Node 自持句柄不阻塞删除（FILE_SHARE_DELETE），第三方 .NET `FileShare.Read` 独占句柄阻塞删除（EBUSY） |
| T8 | **进程树终止 / 超时** | ✅ PASS | win32 分支均为 `taskkill /PID n /T /F` + `shell:false`。实测 wrapper `--timeout-seconds 1` → `status:"timeout"`、退出码 1、`cleanup_confirmed:true`，**子进程与孙进程均已死亡**；`terminateTree` / `terminateChildTree` 直接调用均返回 true 并清掉整棵树 |

**已识别的 Windows 隐患（均不阻断本次验收）**：

- PS 5.1 对 junction 执行 `Remove-Item`（不带 `-Recurse`）抛 `NullReferenceException` 且不删除（安装器用 Python `os.rmdir`，不受影响）
- `taskkill` 兜底正则 `/could not be found|not found/i` 只认英文，中文系统消息匹配不上（由前置 `process.kill(pid,0)` 的 ESRCH 探测兜底）
- `install_skills.py` 的 `subprocess(text=True)` 未指定 encoding，代码页 936 下 mklink 的 GBK 输出在**失败路径**可能残缺（仅影响诊断信息质量）

## 10. ZCode 真实调用

**第 3 轮（最终轮）原始回执**（`artifacts_dir=C:\Users\AI\AppData\Local\Temp\winacc 真实 空格\zcode-out-v3`）：

```json
{"status":"ok","cli_invoked":true,"exit_code":0,"signal":null,"complete":true,
 "model":"GLM-5.3","model_identity_source":"runtime.model_request",
 "stop_reason":"stop","truncated":false,
 "provider":"account:bigmodel-individual-coding-plan","cli_version":"0.17.1",
 "cleanup_confirmed":true,"review_gate":"PASS","tool_requests":0,"tool_calls":0,
 "usage":{"source":"provider","modelRequestCount":1,"inputTokens":9621,
          "outputTokens":11906,"totalTokens":21527,"reasoningTokens":0},
 "session_id":"sess_80bbea57-8ff9-405f-9278-58fbc97bf3b2",
 "trace_id":"2d525a72-30b7-47e5-a622-5b6d3a8ef065",
 "turn_id":"turn_9d7156f2-89ce-4ad2-99a5-f3ca0632b86c"}
```

| 验收点 | 证据 |
|---|---|
| 两方均真实执行 | `cli_invoked=true`；`launch.json` 记录 launcher=`zcode.cmd` → entry=`node_modules/zcode-app-cli/bin/zcode.js`（entry_sha256=`9b86cc7e…`），即 PATH 上的真实 npm shim |
| 原生模型身份可核验 | `model=GLM-5.3`，`model_identity_source=runtime.model_request`（来自运行时模型请求，非硬编码）；`provider=account:bigmodel-individual-coding-plan` |
| 回执完整 | 含 status / exit_code / signal / complete / truncated / model / stop_reason / usage / session_id / trace_id / turn_id / cleanup_confirmed / review_gate |
| 输入一致 | wrapper 写入 artifacts 的 `prompt.txt` 与交给 MMX 的 prompt 文件 **sha256 相同**（`25ab8b57…`） |
| 退出码准确 | 进程退出码 **0**；`exit_code=0`、`signal=null` |
| 结构化结果正确 | 回执为单个 JSON 对象；`review` 字段经仓库自带 `validateReview()` 校验 → **`review_gate=PASS`**（0 条 P1，6 条 P2） |
| 未用 fixture 冒充 | 本次走正式 wrapper + 真实 CLI；`--backend real` 被入口明确拒绝（退出码 2）；`tool_requests=0/tool_calls=0`，`mode=guarded`，`denied_tools=63` 项 |

## 11. MMX 真实调用

**第 3 轮（最终轮）原始回执**：

```json
{"requested_model":null,"cli_invoked":true,"status":"ok","exit_code":0,
 "complete":true,"truncated":false,"stop_reason":"end_turn",
 "model":"MiniMax-M3.1-Flash","model_identity_source":"response.model",
 "input_tokens":6349,"output_tokens":32165}
```

回执字段全集：`requested_model, cli_invoked, status, exit_code, text, model, model_identity_source, stop_reason, complete, truncated, input_tokens, output_tokens`。

| 验收点 | 证据 |
|---|---|
| 两方均真实执行 | `cli_invoked=true`；走 `mmx-chat.js` → PATH 上的真实 `mmx.cmd`（1.0.29） |
| 原生模型身份可核验 | `model=MiniMax-M3.1-Flash`，`model_identity_source=response.model`（来自服务端响应字段） |
| 回执完整 | 含 status / exit_code / complete / truncated / model / stop_reason / usage / 完整 text |
| 输入一致 | 与 ZCode 侧 `prompt.txt` **sha256 相同**（`25ab8b57…`） |
| 退出码准确 | 进程退出码 **0**；`exit_code=0` |
| 结构化结果正确 | `text` 内层 JSON 经仓库自带 `validateReview()` 校验 → schema **PASS**，**repo_review_gate=FAIL**（1×P1 + 5×P2） |
| 未用 fixture 冒充 | 同上 |

**两侧独立性（证据边界）**：两侧模型身份来源不同（`runtime.model_request` vs `response.model`）、模型名不同（GLM-5.3 vs MiniMax-M3.1-Flash）、CLI 与鉴权链路不同，构成**两条独立调用链与两个不同报告身份**。严格地说，「排除同一后端复述」属推断而非回执直接证明 —— 此限定已写进验收材料，ZCode 侧亦据此提出 P2 建议（见 §12）。

## 12. 未解决问题

| # | 问题 | 级别 | 性质 | 是否阻断交付 | 修复建议 |
|---|---|---|---|---|---|
| 1 | **Windows 上 `review-run.js` 优雅取消路径不可达**：`child.kill('SIGTERM')` 不派发子进程信号处理器 → 不写 `result.json`、退出码 2 路径不可达，并级联取消 54 个用例 | **P1（MMX） / P2（ZCode）** | **上游真实产品级缺陷**（双方一致确认，经 `handler_ran=false` 实测） | 否（不阻断三个验收 skill 的安装/加载/真实调用），但足以阻止宣称全绿 | 为 win32 实现显式 IPC/控制消息式取消（CTRL_BREAK_EVENT、不带 `/F` 的 taskkill 进程树消息、或终止前落盘 partial `result.json`），以 `taskkill /T /F` 作超时硬清理兜底 |
| 2 | `packet-v2.test.js` 在 CRLF 检出下产生 19 个伪失败 | P2 | 上游检出伪影（仓库无 `.gitattributes`） | 否 | 新增 `.gitattributes`（如 `*.numstat -text` 或统一 `eol=lf`），或测试读取时归一化换行 |
| 3 | `delivery-mmx.test.js` fixture 在 win32 无法被 `findMmx()` 发现 | P2 | 上游测试可移植性缺陷 | 否（生产 `mmx.cmd` 路径已实测覆盖） | fixture 在 win32 落地 `mmx.cmd`，或为 `findMmx()` 增加显式路径/无扩展名探测支持 |
| 4 | `SKILL.md` / `README.md` 版本号滞后于代码常量（zcode 1.4.0 vs 1.5.0；mmx 2.6.0/2.5.0/2.4.0 并存） | P2 | 上游文档漂移（macOS 同样存在） | 否 | 以代码常量为单一事实源，或在 CI 加版本一致性断言 |
| 5 | `install_skills.py` 的 `subprocess(text=True)` 未指定 encoding | P2 | 上游诊断质量缺陷 | 否（仅失败路径） | 显式 `encoding` + `errors="replace"`，失败时附 returncode 与原始字节摘要 |
| 6 | PS 5.1 `Remove-Item <junction>`（不带 `-Recurse`）抛 NRE 且不删除 | P2 | Windows 行为差异 | 否（安装器用 `os.rmdir`） | 文档写明 Windows 清理应使用 `cmd rmdir` 或 `[IO.Directory]::Delete` |
| 7 | `taskkill` 兜底正则只认英文错误消息 | P2 | 本地化隐患 | 否（ESRCH 探测兜底，实测 `cleanup_confirmed=true`） | 以进程存在性/退出码为唯一判定依据 |
| 8 | zcode-chat 的 3 个 POSIX 专属跳过（进程树终止 / Keychain / wrapper 猝死信号捕获）无 Windows 等价自动化用例 | P2 | 覆盖缺口 | 否（T8 已手工实测补偿） | 补 win32 等价用例 |

> **问题 1 的处置说明**：它位于 `skills/zcode-mmx-review/`（按设计非 skill、不在三个验收对象内）。本次验收**不修改上游源码**（基线固定为 `origin/main` 的 `e0d6aad`，修改会破坏基线一致性与可回滚性），故只做报告与修复建议，**不**用「跳过用例」或「打补丁」的方式凑绿。

## 13. SHA256

### 13.1 zcode 发布清单（version 1.5.0，14 文件，LF 归一化，**mismatch = 0**）

| 文件 | sha256 |
|---|---|
| `README.md` | `c97f7e7afee1ad6ac3325321017a58274064cdd83f8ffca154e5589b9d306536` |
| `SKILL.md` | `54f2daa2087883bc5bd83e82fd913e31ab9502e1605bed42b129a85eff8865f0` |
| `agents/openai.yaml` | `e9b77f7b33258700dfae902efc91a4058f7fc76f6d5f675641eb201fb9fd2052` |
| `references/review-v1.schema.json` | `f269a080098ecb4ab34ed8fd5aa4e76206ba662a6358be7fbd5451e9392bc546` |
| `references/verification.md` | `9656289b42976335db8e5a6e366011355bcc17f48501800c0ce095fc630741ef` |
| `scripts/repin-release.js` | `03b66e58ddc551735a9a8293c20b7f38ce4c239acaf8405b28f260b5f47e7c35` |
| `scripts/review.js` | `f4a6a4522bb5d07d48db6b3ac83bda25a08dff5bbd0cde7b05618d54520c9c83` |
| `scripts/zcode-batch.js` | `671169b40b7e56730d6379bcf3e84d1c1918260e9630677d86f2827000609553` |
| `scripts/zcode-chat.js` | `d1a30df85b622a8d35342b645e112917e7a16a6355e2b913039024b10d779c08` |
| `scripts/zcode-run.js` | `23bdc345377e31ccec85a50469edf86c02a4ceced79f01e24edea9d1f94980fe` |
| `tests/fixtures/fake-zcode.cjs` | `a2e5648cdcf8d1fe270c012625553528366d01d89ff4e430424991b8d9a480df` |
| `tests/review-golden.test.js` | `e36ffebea6e6456f6b3c6362eab3429e43fa4beac9cf91e61e9155792ce6d04e` |
| `tests/zcode-batch.test.js` | `4913198418ffe63d8c346dab11b4c6fc05ba6345aa7e4842bb6672e03741e6a0` |
| `tests/zcode-chat.test.js` | `f6ba1485408fede2714edec96c09a595c4a99006092c54844b0bd36be6034b9a` |

`review_sha256 = f4a6a4522bb5d07d48db6b3ac83bda25a08dff5bbd0cde7b05618d54520c9c83`（与 `scripts/review.js` 一致）

### 13.2 仓库工作区既有本地改动（本次**未**触碰，哈希为合并后当前值）

| 文件 | sha256 |
|---|---|
| `README.md` | `e0cbbdc96d30cbe5af3599c4c9c2a87cf7806f9acd50dfed9dddc24d636ca1f8` |
| `skills/get-biji/README.md` | `7d2e43477126571fd74402dfa18c65aafea32c6f1f9f0ab98e7fdb1ea23bdd7d` |
| `skills/get-biji/SKILL.md` | `17255b393d967565994a3453d49323cfe1ffb39c80605d7735a142f3fea6dbcc` |
| `skills/get-biji/package-lock.json` | `e177492e673d85f7f7f35039ccd1b39e1f2d6e6a966a2b7fd93966857f0aa7c3` |
| `skills/get-biji/scripts/api.js` | `f8dabe809c811ad8ad4eb17914f257b725c1498d74f2dad00580202f848f433b` |
| `skills/get-biji/scripts/paths.js` | `95997d7d09ed5b2a4fa6ad1a4c5ad8e61ea7915083b76d1116ee87cfc4ce0010` |

未跟踪目录：`skills/dario-thinking/`（10 文件）、`skills/lead-acquisition-coach/`（46 文件）—— 未修改。

### 13.3 验收过程关键工件

| 工件 | sha256 |
|---|---|
| 提示 v1（MMX 收到） == ZCode artifacts `prompt.txt` | `e99164ea7cb840c8277244296a196e85cbdf6c885fd1e60c28c03b5f072be990` |
| 提示 v2（MMX 收到） == ZCode artifacts `prompt.txt` | `4c2c383ef8a9755adb75bca05153e5db2fa27f87ca1a93b9c7b7486080a696ff` |
| **提示 v3（MMX 收到） == ZCode artifacts `prompt.txt`** | **`25ab8b5769eeb2e2bc04793e10640136975c14bfad4dcab7d0850e35313fdf68`** |
| 材料 v1 / v2 / v3 | `7ba15aed8ed54368f059e8f633905b4b7401ac18d3cf3c3c64edc2f92f2167de` / `de0b5ea3576206493b07c2b09491e2ef937d1062339ef89c3639c74acd95737a` / `7f395a2c50f3a6130233d8b18e9fded8289231358501c4fe992203028d1f8d60` |
| MMX 回执 v1 / v2 / v3 | `82312398c1a33fa024adca2bcf12c90172ee70cfdb0414fad004d151a8c330cb` / `bae79f452a67dc398b08359fade90c8992b7036a2545a083b850d34aaa73ed78` / `3a5eb31bdfbeb207ab1466093b0ec9380e982fcaf6607e3caf0b28ec9595e8f0` |
| ZCode 回执 v1 / v2 / v3 | `c1fec93eaa174b122c214319353570f469efca4b33594723f82cccd6994a9d96` / `8052e758aa5ba61b0a6d595d3d9c41e26a2e693379140c5971701c98e97366c5` / `467c706e838d298c6548e89851f63acc6ee0da0103475feef0c653c5b4aeaeef` |
| `zcode.cmd`（npm shim） | `a81a67361675471bfbf52aba0bbeb70e70b6798dfe81f6303d258a65f05659c2` |
| `mmx.cmd`（npm shim） | `6e6c84f3d449a85508788039257e7b54539371c37511f574ab9b5730e9158259` |
| `zcode-app-cli/bin/zcode.js`（entry） | `9b86cc7e65d8a8f7097cfdd9be1df0e74c8b15bf7e6c15620752929c2cb6215c` |

**证据目录**：`C:\Users\AI\AppData\Local\Temp\winacc 真实 空格\`（含 3 轮材料/提示/回执、ZCode artifacts `zcode-out{,‑v2,-v3}`、fixture 运行目录）。

## 14. 回滚方案

> **本次任务对 Agent 配置目录与仓库工作区的实际写操作数为 0**（安装器三行全 noop；合并为快进且与本地改动路径交集为 0）。因此**回滚是可选的**，以下为完整可执行的撤销路径。

### 14.1 撤销本次快进合并（保留本地既有改动）

```bash
# 合并前提交由 reflog 记录：5bf74a2
git reset --mixed 5bf74a2      # HEAD 回到合并前；工作区文件保留，6 个本地改动不受影响
# 合并新增的 77 个文件会留作未跟踪文件，需手工清理：
#   git clean -nd skills/zcode-mmx-review   # 先 dry-run 确认，再 -fd 删除
```

> ⚠ 不要使用 `git reset --hard` / `git checkout .` / `git clean -fd`（会销毁 6 个本地既有改动与 2 个未跟踪目录）。
> 若希望保留历史但回退内容：`git revert --no-commit e0d6aad aa3adc4`。

### 14.2 撤销 Skill 安装（若未来发生真实链接创建）

```powershell
python scripts/install_skills.py --uninstall --target zcode --skill zcode --skill mmx --skill decision-algorithm
```

只移除指向本仓库的链接，**不动源数据**。若手工清理 junction，请用 `cmd /c rmdir <junction>` 或 `[IO.Directory]::Delete(<junction>)`（**不要**用 PS 5.1 的 `Remove-Item` 不带 `-Recurse`，已知抛 NRE 且不删除）。

### 14.3 清理本次临时工件

```bash
cmd /c rmdir /s /q "C:\Users\AI\AppData\Local\Temp\winacc 真实 空格"
```

### 14.4 移除本报告

```bash
del WINDOWS-INSTALL-REPORT.md
```

### 14.5 不受影响的部分

`C:\Users\AI\.zcode\skills`（138 条）、`C:\Users\AI\.agents\skills`、`C:\Users\AI\.zcode\cli\plugins`、两个 CLI 的 npm 安装、系统执行策略与 UAC 设置 —— **本次均未写入，无需回滚**。

---

## 15. 交叉验证工作日志（全局规则 §5 要求）

| 项 | 内容 |
|---|---|
| 通道 | `mmx` skill → `node C:\Users\AI\.zcode\skills\mmx\scripts\mmx-chat.js --prompt-file <file>`（prompt 仅经文件传递，UTF-8 无 BOM，无 shell 拼接） |
| 第 1 轮（离线验收子任务） | 冒烟 1 次 + 验证 2 次；断言 A1–A13 全部获回应；结论 gate = **PASS**（0 项反驳、0 新增 finding）；自报调用数 2/3 |
| 第 2 轮（本次任务整体交付） | 断言 A1–A8；**3 次调用（v1 → v2 → v3），用满单轮预算 ≤3** |
| 第 2 轮 A 集 | A1…A8（8 条编号断言） |
| 第 2 轮 B 集 | MMX 第三轮逐条回应：A1=同意、A2=反驳[P2]、A3=同意、A4=同意、A5=同意、A6=同意、A7=同意、A8=同意 → **8/8 编号全部回应** |
| 交集 I | 8/8（编号层面）；但 gate 按「反驳与新增 finding 所带级别」计 |
| B\A（MMX 独有 finding） | 6 条：1×`confirmed_defect/P1` + 4×`confirmed_defect/P2` + 1×`evidence_gap/P2` |
| A\B | ∅ |
| 演化 | v1: 4×P1（3 条为证据缺口）→ v2: 2×P1（均证据缺口）→ **v3: 1×P1**（仅剩真实上游缺陷；两条证据缺口 P1 已被 reflog/git 交集/token 完整性/写面枚举等硬证据关闭，A1/A3 转为同意、A2 降为 P2） |
| **终态 gate** | **FAIL** — MMX 第三轮含 1 条 `[P1]`（Windows SIGTERM 优雅取消路径）。已达第 3 次调用上限 → **FAIL-by-budget 终态**，按规则不再开新轮次重置 |
| 仓库侧独立校验 | 用仓库自带 `skills/zcode/scripts/review.js` 的 `validateReview()` 校验 MMX 三轮输出：schema 全部 PASS；repo_review_gate 依次为 **FAIL / NOT_EVALUATED / FAIL** |
| ZCode 侧（对照） | 第 3 轮 `review_gate=**PASS**`，A1–A8 全同意，**0 条 P1**，6 条 P2 |
| 非 `ok`/截断引用 | 无。三轮 MMX 均 `status=ok`、`complete=true`、`truncated=false`、退出码 0 |

**P1 的独立核实（规则要求「外部意见必须核实」）**：MMX 保留的 P1 经本机独立实测确认 —— `child.kill('SIGTERM')` 在 Windows 上不派发子进程信号处理器（`handler_ran=false`）、`close(code=null, signal=SIGTERM)`、不写 `result.json`、退出码 2 路径不可达。**判定：真问题（非误报）**，已列入 §12 问题 1 并给出修复建议。ZCode 对同一条的评级为 P2（理由：已如实披露并计入 PARTIAL、不阻断三个验收 skill），两侧分歧点已在报告中如实并列，未做单方取舍。

---

## 16. 最终结论

### 最终状态：**PARTIAL**

| 验收域 | 结论 |
|---|---|
| A. 安装验收 | ✅ PASS — 正式安装器、路径正确、版本正确、14/14 哈希匹配、无覆盖其他 Skill |
| B. 依赖验收 | ✅ PASS — Node / Python / ZCode CLI / MMX CLI / 认证全部可用 |
| C. 离线验收 | ⚠️ PARTIAL — doctor / 金样 / node --check / pytest / 清单校验全绿；**3 个测试文件在 Windows 失败** |
| D. 真实调用验收 | ✅ PASS — 两侧均真实执行、模型身份可核验、回执完整、输入逐字节一致（sha256 相同）、退出码准确、结构化结果经仓库校验器验证、未用 fixture 冒充 |
| E. Windows 专项回归 | ✅ PASS — T1–T8 全部实测通过 |
| **交叉验证 gate** | ❌ **FAIL**（FAIL-by-budget）— MMX 保留 1 条真实 P1 |

### 明确回答

> **Windows Agent 是否已经可以独立运行 decision-algorithm、ZCode 和 MMX？**
>
> **是。** 三个 skill 均已由仓库正式安装器以 NTFS junction 安装到 Windows 对应的 Agent 加载目录 `C:\Users\AI\.zcode\skills\`，均被 Agent 实际发现并可调用；ZCode 与 MMX 两侧已在 Windows 上完成**真实模型调用**（GLM-5.3 / MiniMax-M3.1-Flash，退出码 0，回执完整，提示逐字节一致，未用 fixture 冒充）。安装、依赖、离线主链路与 Windows 专项回归均通过。
>
> **但不能宣称全绿。** 上游仓库存在 1 项 Windows 真实产品级限制（`skills/zcode-mmx-review` 的优雅取消路径不可达）及 3 个 Windows 测试文件失败、4 项 P2 级上游问题，MMX 交叉验证据此给出 **FAIL** 终态。因此最终状态为 **PARTIAL**，而非 PASS。所有未解决问题与修复建议见 §12，所有回滚路径见 §14。
