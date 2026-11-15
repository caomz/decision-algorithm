# decision-algorithm · 决策算法

> *"做重大人生决策不靠一时的热情，而靠可重复的决策算法。"*

基于老喻20年决策研究成果，融合 **期望值 + 凯利公式 + 贝叶斯定理（EKB框架）**，帮助你建立可纠错的决策闭环。

---

## 📁 目录结构

```
decision-algorithm/
├── SKILL.md              # ⭐ 核心 Skill 入口（自包含 EKB 决策框架）
├── meta.json             # Skill 元数据（触发词、平台、入口）
├── tools/                # 运行时计算工具
│   └── decision_calculator.py  # 期望值/凯利公式计算器
├── knowledge/
│   └── course_rules.json       # EKB 蒸馏规则（开发知识库，非课程原文）
├── integrations/hermes/        # Hermes decision-finalizer 插件
├── dev/                  # 开发期工件（不影响运行）
│   ├── scripts/                # validate / generate / extract 脚本
│   └── prompts/                # 课程→Skill 制作提示词模板
├── test-prompts.json     # 测试用例
└── results.tsv           # 优化效果记录
```

---

## 🎯 使用方式

安装后直接提问：

```
我该不该辞职创业？
这笔投资该不该做？
纠结要不要分手
该怎么分配资金？
人生方向很迷茫
```

### 计算器工具

```bash
# 期望值计算
python3 tools/decision_calculator.py --ev -p 0.3 -g 100000 -l 20000

# 凯利公式
python3 tools/decision_calculator.py --kelly -p 0.4 -o 3

# 完整分析
python3 tools/decision_calculator.py --full -p 0.3 -g 100000 -l 20000 --capital 500000
```

---

## 📚 核心框架

| 维度 | 工具 | 解决的问题 |
|------|------|-----------|
| 一维 | 胜率 + 赔率 | 赢的概率和回报是多少？ |
| 二维 | 期望值 | 这个决策值不值得做？ |
| 三维 | 凯利公式 | 该投入多少资源？ |
| 四维 | 贝叶斯更新 | 如何根据新信息调整判断？ |

运行时零外部依赖（Python 3.10+ 标准库）；研究环节依赖宿主环境的 WebSearch 类工具。
