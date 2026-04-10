# 详细安装说明

## 前置要求

- Python 3.9+
- Claude Code 或 OpenClaw 环境
- （可选）OpenAI API Key，用于课程材料自动提取

## 安装步骤

### 1. 克隆仓库

```bash
# 安装到当前项目
mkdir -p .claude/skills
git clone https://github.com/YOUR_USERNAME/decision-algorithm-skill .claude/skills/decision-algorithm

# 或安装到全局
git clone https://github.com/YOUR_USERNAME/decision-algorithm-skill ~/.claude/skills/decision-algorithm
```

### 2. 安装依赖（可选）

```bash
cd decision-algorithm-skill
pip3 install -r requirements.txt
```

### 3. 验证安装

```bash
# 验证 SKILL.md 结构
python scripts/validate_skill.py --report

# 列出可用 Skill
python tools/skill_writer.py --action list
```

### 4. 配置 OpenAI API（可选）

如果需要从课程材料自动提取算法卡片：

```bash
export OPENAI_API_KEY="your-api-key-here"
```

## 使用方式

### 在 Claude Code 中使用

安装完成后，在 Claude Code 中直接提问：

```
我要不要辞职创业？
```

Skill 会自动使用 EKB 决策框架进行分析。

### 使用脚本工具

#### 从课程材料提取算法

```bash
python scripts/extract_course_algorithms.py \
  --input course_transcript.txt \
  --output knowledge/course_rules.json \
  --mode auto
```

#### 生成完整 SKILL.md

```bash
python scripts/generate_skill.py \
  --action build \
  --base-dir .
```

#### 验证 SKILL.md 质量

```bash
python scripts/validate_skill.py --report
```

#### 决策计算器

```bash
# 计算期望值
python tools/decision_calculator.py --ev -p 0.3 -g 100000 -l 20000

# 计算凯利公式
python tools/decision_calculator.py --kelly -p 0.4 -o 3

# 完整分析
python tools/decision_calculator.py --full -p 0.3 -g 100000 -l 20000 --capital 500000
```

## 故障排除

### 验证失败

如果 `validate_skill.py` 报告验证失败，检查：

1. SKILL.md 是否包含完整的 YAML frontmatter
2. Part A 和 Part B 是否都存在
3. 核心公式（期望值、凯利、贝叶斯）是否正确

### 脚本运行错误

确保 Python 版本 >= 3.9：

```bash
python3 --version
```

### Windows 编码问题

脚本已内置 Windows 编码处理，如果仍有乱码问题，设置环境变量：

```powershell
$env:PYTHONIOENCODING="utf-8"
```
