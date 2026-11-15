# Tools

本目录包含决策算法 Skill 的 Python 工具脚本。

## 工具列表

### decision_calculator.py

决策计算器 - 计算期望值、凯利公式和完整分析报告。

```bash
# 计算期望值
python tools/decision_calculator.py --ev -p 0.3 -g 100000 -l 20000

# 计算凯利公式
python tools/decision_calculator.py --kelly -p 0.4 -o 3

# 完整分析
python tools/decision_calculator.py --full -p 0.3 -g 100000 -l 20000 --capital 500000
```

**参数说明：**
- `--ev`: 仅计算期望值
- `--kelly`: 仅计算凯利公式
- `--full`: 完整分析（期望值 + 凯利公式 + 建议）
- `--probability, -p`: 胜率 (0-1)
- `--gain, -g`: 收益金额
- `--loss, -l`: 损失金额
- `--odds, -o`: 赔率（赢/亏比）
- `--capital`: 总资金（用于计算具体投入金额）
- `--conservative`: 使用凯利的一半（保守策略）
- `--very-conservative`: 使用凯利的四分之一（非常保守策略）

### skill_writer.py

Skill 文件管理工具 - 列出和验证已生成的 Skill。

```bash
# 列出所有 Skill
python tools/skill_writer.py --action list

# 验证 Skill
python tools/skill_writer.py --action validate --skill decision-algorithm
```

### version_manager.py

版本管理器 - 管理 Skill 文件的版本存档和回滚。

```bash
# 列出历史版本
python tools/version_manager.py --action list --skill-dir .

# 备份当前版本
python tools/version_manager.py --action backup --skill-dir .

# 回滚到指定版本
python tools/version_manager.py --action rollback --skill-dir . --version v2

# 清理旧版本
python tools/version_manager.py --action cleanup --skill-dir .
```
