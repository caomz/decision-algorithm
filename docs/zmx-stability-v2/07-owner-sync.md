# 正本同步清单（OWNER_ACTION_REQUIRED）

状态：**待所有者执行**。合并本分支不会更新 macOS 正本；`skills/zcode-mmx-review/README.md` 声明本目录是记录副本，生效正本在所有者的 harness 目录。执行前保留正本本地定制，**不得盲目覆盖**；如正本含本清单未覆盖的本地修改，先合并再同步。

| 仓库文件（记录副本，LF） | 生效正本（macOS） | 仓库副本 SHA-256（LF 字节） |
| --- | --- | --- |
| `skills/zcode-mmx-review/zcode-mmx-review.md` | `~/.agents/harness/docs/zcode-mmx-review.md` | `a3e39b485c353b6053ac8f7b026391483844a0800ae35b16a204ab393255bf21` |
| `skills/zcode-mmx-review/provider-agent-review.md` | `~/.agents/harness/docs/provider-agent-review.md` | `c182788ef204e88f504f8425cae5c8b967f782d574ec83b5a99ae198f559bfea` |

哈希对应本清单所在提交的仓库副本（LF）。正本如按 CRLF 或含本地定制，先按 `skills/zcode-mmx-review/README.md` 校验一节的 LF 归一口径比较**内容**，再决定是否覆盖；运行材料的实际字节哈希不得为兼容换行而归一化。

步骤（macOS）：

1. `diff ~/.agents/harness/docs/zcode-mmx-review.md <repo>/skills/zcode-mmx-review/zcode-mmx-review.md`，逐块确认差异仅为本轮 V2.2 文案；正本本地定制先迁移进仓库副本或保留在正本并记录。
2. 备份正本（`cp -p` 到带日期的备份名）。
3. 覆盖：`cp <repo>/skills/zcode-mmx-review/zcode-mmx-review.md ~/.agents/harness/docs/zcode-mmx-review.md`（另一份同理）。
4. 核对：`shasum -a 256` 两份正本与上表一致（正本按其实际字节；如行尾不同，用上述归一口径核对内容后按本表记录实际字节哈希）。
5. 新开一个宿主会话加载规则，确认 V2.2 的三层重试口径与宿主调用合同生效。

完成前，宿主加载的仍是旧规则：这与本分支代码的行为不一致，属于已知的发布缺口，由所有者关闭。
