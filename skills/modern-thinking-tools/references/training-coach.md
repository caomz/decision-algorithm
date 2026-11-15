# 思维工具训练协议

本模式帮助学习者自己识别、解释、应用工具。必要时直接教学；不把训练变成寻求实际帮助的门槛。用户要求现实决策建议时回顾问模式。

## 首轮与续练

- 首轮先判断用户是否接触过目标工具；上下文已有事实即可采用。默认从 `T025`、`T032`、`T036` 选择一个；一次训练最多关注三个工具。
- 用户主动进入训练时运行 `python3 skills/modern-thinking-tools/scripts/training_record.py summary` 读取到期工具。首次启动用 `start --tool-id T025 --tool-id T032 --tool-id T036`，保存返回的 `session_id`。
- 跨任务仅在用户明确说“续练/继续训练”时调用 `resume`。无记录时从新的简短练习开始，不能推断旧对话已持久化。
- 私有记录默认在 `/Users/mingtian/.local/share/modern-thinking-tools/`。任何写入返回 `saved:false`、退出非零或权限异常时说“未保存”，当前对话仍可继续。
- 用户要求暂停记录：`set-recording --enabled off`；恢复：`set-recording --enabled on`。不复制到 `MEMORY.md`、GetNote 或社媒稿件，不创建提醒。

## 训练证据

针对 1—3 个唯一工具，每个工具发两条非私密查询：`<课程正式名称> 定义 机制 应用` 和 `<课程正式名称> 适用边界 问答 反例 误区`。使用 `retrieve_evidence.py --stage training`，逐个传 `--tool-id`。真实案例须抽象化；查询中不含个人原话、学习记录或项目路径。

读取 evidence 的 `training_coverage`：每项必须对应召回到的、未截断的本地完整课程章节，才可写 `ready`。若缺失或 GetNote 失败，明确“GetNote 检索降级”，按 `training_fallback` 或课程目录读取本地章节，区分本地依据与召回结果。同一次训练保留证据包；仅目标工具、源版本或证据可用性变化时重新检索。OpenClaw 插件自动注入时复用它，不重复发请求。

## 一次只练一个问题

1. 已学过：先出一题不标工具名称的新情境，标注“合成练习案例”，请用户说明观察到的事实、可选工具、适用边界和下一步。**未收到回答前不给提示或答案。**
2. 用户答后，先指出推理依据与缺失信息，再依请求分级提示：一级只问应观察的事实；二级才给候选工具或关键问题；三级给来源支持的示范，并换题再次尝试。用户说“不会”可从一级开始；新概念先示范，免猜谜。
3. 提示等级 `0` 仅表示独立尝试；用了 1—3 级提示必须记“辅助完成”。用户直接要答案立即给，不假装完成训练。
4. 分别反馈机制理解、情境识别、边界辨别、行动设计、证据更新。每维只标 `supported`、`needs_work`、`unknown` 和一句依据。允许合理多解、信息不足和不需套模型；AI 低置信度时追问，不用总分宣称掌握。
5. 真实应用需先记“准备做什么、哪种证据会改变想法”，随后才能追加结果。不得把用户回忆的事前想法伪装成事前记录。案例原话仅留在当前对话，不存数据库。

OpenClaw 对练习题在末尾写机器可读的非私密标记：`<!-- modern-thinking-training ref=case_TOKEN hint=0 tool=T025 -->`，替换为匿名题目引用、实际提示等级和工具编号。插件用它保持同任务题目状态；没有标记时不能声称已保存题目。Codex/Claude 也可沿用相同标记。

OpenClaw 对用户尝试给出五维反馈后，再附一条结构化标记，由插件自动记入私有账本：`<!-- modern-thinking-feedback ref=case_TOKEN tool=T025 summary=mechanism_clear hint=0 mechanism=supported recognition=supported boundary=unknown action=unknown updating=unknown -->`。五维只允许 `supported`、`needs_work`、`unknown`；总结码只允许 `mechanism_clear`、`boundary_missing`、`needs_example`、`insufficient_information`、`other_reasoning_gap`。证据不足写 `unknown`。缺标记不补造练习成绩，明确告知未保存。Codex/Claude 使用下面同一 helper 写入。

## 记录命令

下面仅存匿名代码，不传私人叙述：

```bash
python3 skills/modern-thinking-tools/scripts/training_record.py start --tool-id T025 --tool-id T032 --tool-id T036
python3 skills/modern-thinking-tools/scripts/training_record.py record --session-id SESSION_ID --event-id ANSWER_ID --tool-id T025 --kind answer --question-ref case_01 --summary-code attempt_pending_review
python3 skills/modern-thinking-tools/scripts/training_record.py record --session-id SESSION_ID --event-id EVENT_ID --tool-id T025 --kind feedback --question-ref case_01 --summary-code mechanism_clear --hint-level 0 --mechanism supported --recognition supported --boundary needs_work --action unknown --updating unknown --provenance observed_practice
python3 skills/modern-thinking-tools/scripts/training_record.py resume --session-id SESSION_ID
python3 skills/modern-thinking-tools/scripts/training_record.py summary --markdown
```

`event-id` 重试时复用同一值；引用和决策代码只能是简短英文匿名 token。`precommit` 使用同一 `--question-ref`、`--decision-code` 与 `--counterevidence-code`；`outcome` 对应同一引用并使用 `--result-code`，仅追加。观察到的练习表现、用户自述真实应用、AI 推断分别使用 `observed_practice`、`user_report`、`ai_inference`。未回答不能写有效反馈，未收到结果不能写真实应用成功。

## 节奏与检查

每轮约 15 分钟，可随时结束。默认间隔是 1、3、7、14 天：有提示或边界不清时回到短间隔；独立完成且边界合理再延长。第 1 天无提示基线，第 2—4 天单工具，第 5—10 天混合与低风险真实应用，第 11—14 天延迟新题。十四天只检查初步改善和能否坚持，不承诺掌握。

每次复盘分别检查：无提示识别是否改善、是否减少提示、是否改变现实动作。不能以笔记数量、口播稿流畅、单题答对或短期结果推断长期能力。逐次只加入一个新工具，保留旧工具间隔练习。
