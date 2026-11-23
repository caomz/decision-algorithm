# ZCode / MMX cloud execution baseline

This document records the cloud-first delivery boundary for the existing
ZCode + MMX cross-review system. It is not an installation instruction.

## Fixed scope

- Stage 0: cross-platform, offline CI (this change).
- Stage 1: validate and integrate the existing MMX fetch timeout PR #4.
- Stage 2: coordinate MMX concurrency across independent batches and back off on 429.
- Stage 3: make long-running and batch jobs recoverable without blind resubmission.
- Stage 4: enforce complete shard / acceptance-criterion coverage.
- Stage 5: enable a guarded real ZCode + MMX backend in `review-run.js`.

MCode is explicitly **out of scope**. Leave its existing files unchanged.

## Verified starting point

- GitHub main at planning time: `011a4848e4b40284d63b77e03b09705cd1a12778`.
- PR #4, `mac-backport/mmx-pr1`, is open and contains the existing
  macOS-tested fetch 300-second guard; it is **not** yet part of main.
- At this baseline, `review-run.js run --backend real` was disabled. Stage 5
  adds an opt-in single-packet invocation and replayable per-side receipts.
  See the unified runner README for usage and the Mac acceptance guide for live verification.
- Local Mac worktree, installed launchers, account quotas, and proxy route are
  not visible to cloud GitHub tooling. Do not infer local deployment status.

## CI contract

`.github/workflows/zmx-offline.yml` runs isolated Node.js 22 checks on
Ubuntu, macOS, and Windows. It deliberately does not install provider CLIs,
retrieve user credentials, change the model endpoints, or contact paid APIs.

Run equivalent tests locally from the repository root:

```bash
node --test skills/zcode/tests/*.test.js
node --test skills/mmx/tests/*.test.js
node --test skills/zcode-mmx-review/tests/*.test.js
node skills/zcode-mmx-review/scripts/review-run.js doctor --offline --json
```

A green cloud run attests the included offline contracts only. The final
production gate requires separately observed Mac runtime, proxy, authentication,
and real provider receipts. Do not merge a stage just because fixture tests pass.

## Change gates

Each stage must use a dedicated PR, preserve `review-v1`, record baseline
and regression results, and provide a revert path. No modifications to main,
local credential files, or existing macOS installation paths are performed by
these cloud-only PRs.
