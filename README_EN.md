<div align="center">

# Decision Algorithm Skill

> *"Making major life decisions doesn't rely on momentary passion, but on a repeatable decision algorithm."*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-blue.svg)](https://python.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Skill-blueviolet)](https://claude.ai/code)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-Standard-green)](https://agentskills.io)

<br>

Facing career choices, investment decisions, entrepreneurial judgments, relationship dilemmas, or financial planning?<br>
Do you often feel stuck, hesitant, and unsure how to decide?<br>

**Based on 20 years of decision research by 老喻 (Lao Yu), integrating Expected Value + Kelly Criterion + Bayes Theorem**<br>
Helps you build a correctable decision闭环 (feedback loop) and become the master of your destiny

<br>

[Core Framework](#core-framework) · [Installation](#installation) · [Usage](#usage) · [Examples](#examples) · [Algorithm Library](#algorithm-library) · [Detailed Installation](INSTALL.md) · [**中文**](README.md)

</div>

---

## Core Framework

This Skill is based on the **EKB Decision Algorithm Framework**:

| Dimension | Tool | Solves |
|-----------|------|--------|
| 1D | Win Rate + Odds | What's the probability of winning? How much do you win/lose? |
| 2D | Expected Value | Is this decision worth making? |
| 3D | Kelly Criterion | How much resources should you invest? |
| 4D | Bayes Theorem Update | How to adjust judgment based on new information? |

### Core Principles

- **Only do things with positive expected value**
- **Never invest what you can't afford to lose**
- **Start now, update continuously**
- **Don't test human nature, set rules in advance**
- **Competence circle matters more than being smart**
- **Stay at the table**

---

## Installation

### Claude Code

> **Important**: Claude Code looks for skills in `.claude/skills/` under the git repository root.

```bash
# Install to current project (run in git repository root)
mkdir -p .claude/skills
git clone https://github.com/YOUR_USERNAME/decision-algorithm-skill .claude/skills/decision-algorithm

# Or install globally (available in all projects)
git clone https://github.com/YOUR_USERNAME/decision-algorithm-skill ~/.claude/skills/decision-algorithm
```

### OpenClaw

```bash
git clone https://github.com/YOUR_USERNAME/decision-algorithm-skill ~/.openclaw/workspace/skills/decision-algorithm
```

### Dependencies (Optional)

```bash
pip3 install -r requirements.txt
```

---

## Usage

### Direct Questions

The Skill automatically responds to decision-related questions:

```
Should I quit my job and start a business?
Should I make this investment?
I'm torn about breaking up
Is this risk big?
How should I allocate funds?
```

### Specify Analysis Depth

| Mode | Example | Behavior |
|------|---------|----------|
| Quick | "Help me quickly evaluate this decision" | Only positive/negative expected value |
| Deep | "Analyze this in detail" | Full 7-step process |
| Specific | "Use Kelly Criterion to calculate my investment" | Focus on single tool |

### Script Tools

```bash
# Extract algorithm cards from course materials
python scripts/extract_course_algorithms.py --input course_transcript.txt --output knowledge/course_rules.json

# Generate complete SKILL.md
python scripts/generate_skill.py --action build --knowledge knowledge/course_rules.json

# Validate SKILL.md quality
python scripts/validate_skill.py --report

# Version management
python tools/version_manager.py --action list --skill-dir .
python tools/version_manager.py --action backup --skill-dir .
python tools/version_manager.py --action rollback --skill-dir . --version v2
```

---

## Examples

### Scenario 1: Quitting Job to Start a Business

```
User      ❯ I'm torn about quitting my job to start a business

Skill     ❯ Don't rush into the纠结. Let's do the math:
             What's the probability of your startup succeeding?
             How much will you make if it succeeds? How much will you lose if it fails?
             Plug these three numbers in — whether the expected value is positive or negative will be clear.

             If you can't estimate these numbers yourself — you're not ready yet.
```

### Scenario 2: Stock Losses

```
User      ❯ This stock is down 30%, should I cut losses?

Skill     ❯ You want to hold it not because you believe in it, but because you don't want to admit the loss —
             This is the disposition effect. Forget your purchase price and re-evaluate:
             If you had this much cash today, would you buy this stock?
             If the answer is no, you should leave.
```

### Scenario 3: Impulsive All-In

```
User      ❯ This opportunity is so rare, I want to All in

Skill     ❯ The rarer the opportunity seems, the calmer you should be.
             Kelly Criterion tells us, no matter how good the project, you can only invest a portion of your capital.
             All-in heroes look cool, but those who stay at the table get to wait for the next good hand.
```

---

## Algorithm Library

Core decision algorithms from the course, use as needed:

| Algorithm | Core Idea | Use Case |
|----------|-----------|----------|
| 先小人后君子 | Rationality before morality. Set decision rules and firewalls in advance | Partnerships/collaboration |
| 二阶理性 | The real mission of decisions is to maximize the probability of continuous improvement | All major decisions |
| 复利再认识 | Compound interest requires repeated positive expected value with scalability | Long-term investment |
| 处置效应 | People tend to sell winning assets too early while holding losing ones | Stop loss/letting go |
| 屁股决定脑袋 | Behavior is constrained by position, interests, and risk exposure | Understanding motives |
| 满意主义 | 54% scoring rate can still make you #1 in the world | Decision paralysis/perfectionism |
| 思维格栅证伪 | Use multiple thinking models to falsify your own views | Major decisions/self-check |
| 幸福者退让原则 | Giving way when in a superior position is often the better strategy | Conflict resolution |
| 价值投资三原则 | Buying companies not stocks / Using Mr. Market / Safety margin | Investment decisions |
| 遍历性原则 | Even positive expected value requires enough repetitions to materialize | Venture capital/All-in |
| 胶带纸思维 | Get a simple rough solution running first, then iterate | Startups/product |
| 奥卡姆剃刀 | If not necessary, do not add entities | Over-complex solutions |
| 弃子争先 | Give up local interest for overall initiative | Resource constraints |
| 冗余求生 | Good systems have redundancy as insurance against uncertainty | Risk prevention |
| 极大极小原理 | Choose the best outcome in the worst-case scenario | Zero-sum games |
| 可证伪性 | Think about when you're wrong first | Self-checking |
| 黑天鹅应对 | Don't predict black swans, benefit from unexpected events | Risk prevention |
| 机会成本 | The true cost of any decision is the best alternative you gave up | Resource allocation |
| 对冲思维 | How to still win when decisions go wrong | Risk hedging |
| 选择vs努力 | Choice determines direction, effort determines speed | Career planning |

---

## Features

### Decision Workflow

```
Decision Problem → Mindset Screening → Win Rate/Odds → Expected Value → Kelly Criterion → Bayes Update → Structured Advice
```

### Six Decision Traps

| Trap | Core Behavior |
|------|---------------|
| Overthinking Trap | Constantly flipping sides, lacking effective decision ability |
| Inertia Trap | Making decisions based on past habits rather than rational analysis |
| Delegation Trap | Believing delegation equals giving up decision power |
| Certainty Trap | Pursuing certainty is itself the biggest uncertainty |
| Success Trap | Past success becomes a shackle for future choices |
| AI Trap | Letting external systems replace your decision agency |

### Output Structure

Every decision analysis follows this structure:

```markdown
## Decision Analysis

### Decision Type
[Investment/Career/Relationship/Consumption/Other]

### Mindset Diagnosis
- Trap Identification: [Is the user trapped in a decision trap?]
- Game Theory: [Any interest conflicts or bias?]
- Key Blind Spots: [Factors the user might ignore]

### Framework Analysis
- Win Rate Estimate / Odds Assessment / Expected Value Judgment
- Ergodic Check / Investment Suggestion / Information Gap

### Decision Suggestion
[Structured suggestion with specific action steps]

### Risk Warning
[Worst case + response strategy]
```

---

## Project Structure

This project follows the [AgentSkills](https://agentskills.io) open standard:

```
decision-algorithm-skill/
├── SKILL.md              # Skill entry point (official frontmatter)
├── work.md               # Part A: Decision Workflow
├── persona.md            # Part B: Decision Advisor Persona (6-layer structure)
├── meta.json             # Metadata
├── prompts/              # Prompt templates
│   ├── extraction.md     #   Course knowledge extraction
│   └── analysis.md       #   Decision analysis template
├── tools/                # Python tools
│   ├── decision_calculator.py  # Expected Value/Kelly calculator
│   ├── skill_writer.py         # Skill file management
│   └── version_manager.py       # Version management
├── scripts/              # Scripts
│   ├── extract_course_algorithms.py  # Extract algorithm cards from course
│   ├── generate_skill.py             # Generate complete SKILL.md
│   └── validate_skill.py             # Validate SKILL.md quality
├── knowledge/            # Knowledge base
│   └── course_rules.json # Structured course knowledge
├── docs/
│   └── PRD.md            # Product requirements document
├── requirements.txt
├── INSTALL.md            # Detailed installation guide
└── LICENSE
```

---

## Notes

- **This Skill does not provide definitive answers**, only analysis frameworks and structured suggestions
- **The final choice is always the user's own**
- Clearly refuse anything involving illegal activities
- Inform about negative expected value for pure gambling/lotteries
- Inform about insufficient confidence for speculation beyond reasonable analysis

---

## Star History

<a href="https://www.star-history.com/?repos=titanwings%2Fdecision-algorithm-skill&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=titanwings/decision-algorithm-skill&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=titanwings/decision-algorithm-skill&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=titanwings/decision-algorithm-skill&type=date&legend=top-left" />
 </picture>
</a>

---

<div align="center">

MIT License © [titanwings](https://github.com/titanwings)

</div>
