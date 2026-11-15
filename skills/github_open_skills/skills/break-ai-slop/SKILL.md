---
name: break-ai-slop
description: >-
  Break AI Slop — calibrate complex work with concrete expert criteria.
  Extracts tacit knowledge, surfaces hidden failure modes, and distills the one constraint that decides success or failure.
  Use on explicit request or complex tasks that need a domain-specific failure check; skip simple edits and routine questions.
  Triggers: 'break-ai-slop', 'anti-slop', 'slopbreak', 'slop check',
  '行家模式', '专家预检', '防止AI水货', '别给我水货', '认真做',
  '先想清楚再做', '这个别敷衍', '高质量输出'.
license: MIT
---

# Break AI Slop

AI slop = mass-produced, generic, shallow output that technically answers the question but lacks real expertise. It comes from the AI's default behavior: pattern-matching against training data instead of reasoning from domain-specific knowledge.

This skill forces a cognitive calibration before execution. Not "think step by step" — but **"become the right person, then do the right thing."**

---

## The Protocol

Apply the four checks below when explicitly requested or when a complex task benefits from them. Share only a brief decision summary: the relevant expertise, one concrete risk, and an acceptance criterion. Keep private deliberation internal. For simple edits, routine questions, or a request for brevity, proceed directly without a mandatory four-part preamble.

### Step 1: Locate the Real Expert

> In the real world, who actually does this well — and in what context?

Do NOT answer with "an XX expert" or "a senior XX professional." That's a costume, not a person.

Be specific: **what scene, what background, what kind of experience.** A person who has done this hundreds of times, made mistakes, built intuition, and now operates with a feel for the work that no textbook captures.

Then extract their **tacit knowledge**:
- What experience, instincts, and judgment criteria do they rely on?
- What signals make them immediately alert?
- What seemingly reasonable approaches would they NEVER use — and why?
- What unwritten rules separate their work from a novice's?

### Step 2: Visualize the Typical Failure

> When a novice or a generic AI does this, what does the failure actually look like?

Do NOT say "not deep enough" or "not accurate enough." Those are meta-descriptions, not failures.

Describe the **concrete, visible output** of failure:
- What does the wrong result look like? (Be specific enough that someone could recognize it)
- Why does this error happen? (What assumption or shortcut causes it?)
- Where exactly does it go wrong? (Which step, which judgment call?)

### Step 3: Find the Deep Failure

> Assume you've avoided all common mistakes AND applied the expert's tacit knowledge. If the result is STILL wrong, what's the root cause?

This is the hardest step. Common errors are surface-level. The deep failure is structural:
- Is the **goal** wrong? (Solving the wrong problem)
- Is a **premise** wrong? (Hidden assumption that seems obvious but isn't)
- Is the **evaluation criteria** wrong? (Optimizing for the wrong metric)
- Is there an **invisible constraint**? (Something not stated but critical)
- Did you **misread what the user actually needs**? (They asked for X but need Y)

### Step 4: Distill the Core Constraint

> Based on Steps 1-3, what is the ONE constraint that determines success or failure?

Compress everything above into a single, actionable constraint. Use it as a task-specific acceptance criterion within the user’s goal, existing authorization, and host instructions; it does not override them.

Format: **"The core constraint is: [one sentence]."**

---

## Execution Rules

1. **Scale the check to the task.** Do not turn a simple action into a separate calibration exercise.
2. **Share conclusions and evidence.** Give concise criteria, assumptions, and risks when useful; do not expose private step-by-step deliberation.
3. **Respect existing scope and authority.** The core constraint cannot authorize new tools, spending, writes, or external actions.
4. **If you can't identify a deep failure in Step 3, say so honestly.** "I don't see a deep failure here" is better than fabricating one.
5. **Revisit only material changes.** Update the affected criteria when the task changes; avoid repeating an unchanged preamble.

