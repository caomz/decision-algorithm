# 在 Mac 上用 ZCode 和 MMX 审核文件

双击项目根目录的 **Mac交叉验证.command**。在文件选择器里选一份已脱敏的 `.md`、`.txt` 或审核包 `.json`。确认选择后，程序把材料分别发给本机已登录的 ZCode 和 MMX，并在终端显示模型名称、裁决和结果目录。首次试用可以选择同一目录下的《示例审核材料.md》。

Markdown 或 TXT 可以直接写要核对的问题和原始材料。JSON 文件使用项目的审核包格式。每片完整提示词（含指令、材料和 schema）上限为 24 KiB。长材料先计算完整覆盖所需的片数；命令行通过 `--max-shards` 授予上限，Finder 会显示本轮片数并请你确认。默认每个模型最多审核一片。最多可规划 32 片，原始包和规范材料的规划上限为 512 KiB，实际容量还取决于重复的目标、约束和转义开销。

## 从终端运行

在项目目录执行：

```bash
./Mac交叉验证.command --dry-run "示例审核材料.md"
./Mac交叉验证.command "示例审核材料.md"
```

长文件可以先预检，再按显示的实际片数授权。例如预检显示 2 片时：

```bash
./Mac交叉验证.command --dry-run --max-shards 32 "长材料.md"
./Mac交叉验证.command --max-shards 2 --timeout-seconds 600 --max-tokens 524288 "长材料.md"
```

长材料默认按全文问题审核。即使两侧收齐所有片段，局部结论也不足以证明全文没有重复或两张表逐项对应。此时顶层内容裁决保留 `NOT_EVALUATED`，你仍能阅读每片发现。若问题确实可以逐片独立判断，例如“每行记录都含有批次号”，可在 JSON 中显式设置 `goal.acceptance_scope` 为 `per_shard` 并写明条件。TXT 或 Markdown 也可加 `--shard-local` 将本次审核限定为片段内的错误。

两片最多派发四次模型请求。每个请求在原生传输中领取一次许可，并核对上游请求的输出 Token 上限；模型无法接受该上限或启动器无法验证时，审核可能提前终止。输入字节、输出 Token 和请求数是客户端能核验的预算；实际账单按供应商账户计价。需要限制金额时，使用可核验的供应商账户额度。

Mac 上自定义 MMX shell 启动器如果无法证明实际执行链，程序会在派发前停止。可以仅为这轮选择已安装、已核验的 npm CLI，例如追加 `--mmx-bin-dir "$HOME/.npm-global/bin"`。此操作只为 MMX 子进程选择路径。使用前核对你的代理和账户路线；Finder 也会在切换前询问。

第一条在本地检查材料，第二条会发起一轮真实审核。也可以传入其他文件的绝对路径。使用 `--results-dir "/路径/到目录"` 可选择归档位置，默认保存在 `~/Library/Application Support/Decision Algorithm/Reviews` 下。每次真实运行都会创建新的结果目录。

## 查看审核结果

双击使用时，审核结束后 Finder 会显示本轮的 **审核摘要.txt**。终端也会打印它的完整路径。该文件列出两侧模型、投票和建议。同目录下的 `run/result.json` 保存结构化结论，`run/zcode-stdout.json` 与 `run/mmx-stdout.json` 保存原始回执。要重新检查已有结果，运行：

```bash
./Mac交叉验证.command --verify "/本轮运行目录的完整路径"
```

复验只读取本地归档。审核退出码 0 表示 `PASS`，1 表示存在有效 `FAIL`，2 表示无法完成评价、输入错误或运行错误。`round_status=COMPLETED` 表示两方都完成有效复核。多片运行的输入和覆盖计划在 `run/coverage/`，各片原始回执在 `run/parts/`。整轮结论要求每片双侧输入绑定、回执复验和验收条件覆盖；需要跨片证据才能判断的条件应报告证据缺口。遇到中断时先查看该轮归档，未知状态不会触发重发。

## 本机依赖

启动器使用本机 Node.js 及已登录的 `zcode`、`mmx` 原生 CLI。项目自带这两侧的审核 wrapper、投票规则与复验工具。运行 `./Mac交叉验证.command --help` 可查看用法，运行以下命令可检查项目文件及发布清单。

```bash
node skills/zcode-mmx-review/scripts/review-run.js doctor --offline --json
```
