# 获客学习与实战教练 · Skill v1.0

基于用户上传的《经纬10月线下课线索获客笔记整理》，制作的可复用学习与实战辅助包。重点是教会你判断“谁会买、为什么现在买、为什么选择你”，再指导内容、承接和复盘；不是爆款标题生成器。

## 开始使用

**在支持本地 Skills 的工具中**：将整个 `lead-acquisition-coach` 文件夹放进该工具配置的 Skills 目录，保留 `SKILL.md` 与相对路径。具体目录和加载方法由使用环境决定，本包不假定某个固定安装路径。本次仅生成文件，没有安装到你的设备。

**在可读取附件的对话中**：上传完整压缩包，要求先读取 `SKILL.md`，再按任务读取 `references`。不能解压的环境可上传解压后的相关 Markdown 文件。只粘贴 `SKILL.md` 不会自动带入参考资料。

下面是自然语言触发示例，不是已注册的系统命令：

> 使用 lead-acquisition-coach，带我学习获客核心。先教第一课，用课程案例和我的 AI 业务举例，每轮留一个练习，不要直接替我完成作业。

> 使用 lead-acquisition-coach，诊断这段获客内容。先说它想吸引谁、处于什么购买阶段、缺什么证据，再给修改建议。

> 使用 lead-acquisition-coach，基于这些真实客户聊天记录提炼成交时刻。区分原话、我的解释和待验证假设。

> 使用 lead-acquisition-coach，按我的学习记录继续，先复习上次的薄弱点。

## 文件导航

| 文件 | 用途 |
|---|---|
| [SKILL.md](SKILL.md) | 教练角色、触发条件、执行规则和边界 |
| [课程核心](references/01-course-core.md) | 五客、四把锁、四信、消费旅程与关键区别 |
| [学习路径](references/02-learning-path.md) | 10 个学习单元、每课练习与验收 |
| [教练工作流](references/03-coaching-workflows.md) | 学、练、诊、策、写、复六种模式 |
| [诊断与证据](references/04-diagnostics-and-evidence.md) | 卡点判断、线索口径、归因与验证 |
| [你的业务上下文](references/05-user-context-and-ai-examples.md) | 已知与未知、候选 AI 服务、内容练习 |
| [来源索引](references/06-source-map.md) | 原文节次、精确行号、可核对摘录 |
| [案例与题库](references/07-case-bank-and-questions.md) | 案例拆解、迁移练习、教练判分依据 |
| [第一课](第一课-获客核心与成交时刻.md) | 可直接开始的课程与作业 |
| `assets/` | 业务简报、访谈、内容卡、证据、实验与学习记录模板 |
| [完整原稿](sources/course-notes.md) | 保留上传笔记原文；配图在同目录附件文件夹 |
| [验收场景](tests/acceptance-cases.md) | 检查 Skill 是否忠于来源、是否诚实诊断 |

## 怎样持续学习

推荐先用第一课做一次练习，再按反馈进入下一课，不按日历强行推进。你应逐渐能复述、辨别、应用，最后拿真实反馈来修正；这四件事不是同一个水平。

将 [学习记录模板](assets/08-learning-state.md) 另存为自己的记录。每轮学习后保留：已练的知识点、自己的答案、主要错误、修订、下一步。新会话提供该记录即可恢复进度，不依赖未确认的长期记忆，也没有自动授课安排。

## 来源与改编说明

本包只以用户上传笔记作为课程依据，没有重新听原始录音，没有独立核验案例业绩，没有读取此前贴文中的个人本地路径或三条外部课程链接。原稿声明其自身做过逐字稿整理；我们引用的是这份整理版。

**课程内容**沿用五客等原术语，见 S01–S33 来源点；**学习单元、评分、模板、实验字段和 AI 业务示例**是本包新增的教学或应用设计，均不属于讲师原定作业。没有使用外部研究来替换课程。

第十一节的反 AI 立场原样保留于来源中。使用 AI 辅助学习、归类和检查，是用户要求下的改编，不能说成讲师认可。原稿中绝对化判断、营销成绩和行业专业说法保留为课程观点或案例口径，不作为事实保证。

源文件 SHA-256、字节数及来源信息见 [source-manifest.json](sources/source-manifest.json)。可用下面的本地命令核对和定位原文，无需联网：

```bash
python scripts/read_source.py --verify
python scripts/validate_package.py
python scripts/read_source.py --lines 1980:1998
python scripts/read_source.py --search "买单前" --context 2 --limit 4
```

本包包含你提供的完整课程笔记及配图，供个人学习使用；对外转发或商用原始材料前，应确认相应许可。
