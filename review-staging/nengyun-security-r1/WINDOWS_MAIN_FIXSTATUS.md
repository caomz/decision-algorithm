# Current Windows branch: real Skill P1 fixes (R3)

**Scope:** PR #11 review branch only, target \`windows\`. Built upon the current
\`windows\` SHA \`86f0c56dab476545a814d1c852543a4a3ab7e85d\`.
\`main\` and \`windows\` were not written. This document supersedes the
previous R2 "staging-only" scope statement.

## Fixed in this review branch (not released)

| Finding | Code | Guard | Evidence |
|---|---|---|---|
| F3 (P1) | \`skills/mmx/scripts/mmx-batch.js\`, new \`batch-receipt.js\` | Refuse \`status:ok\` when actual process exit is nonzero, signaled or required fields inconsistent | Synthetic pure-helper tests; integrated batch tests added but not run locally |
| F5 (P2) | \`skills/mmx/scripts/mmx-batch.js\` | No raw child stderr tail in the no-stdout public JSON; boolean \`stderr_present\` only | Synthetic canary test in batch suite, not run against full batch locally |
| F7 (P1) | \`skills/get-biji/scripts/lock.js\` | Never steal by age/PID; refuse existing holder with \`SYNC_LOCK_BUSY\`; verify ownership before unlink | Byte-identical GitHub code tested locally, including a real second OS process |

## Outstanding / not fixed in this PR

F1 installer ordinary-file deletion or failed link switch;
F2 dependency preflight and error status;
F4 POSIX process-group cancellation;
F6 ZCode cleanup unknown;
F8 MMX 24h age-based temp clean;
F9 ZCode timeout retry and uncertain process descendants.

Windows \`zcode-mmx-review\` graceful cancellation is also not addressed.
The R2 runner remains optional and has **not** been integrated into original
MMX, ZCode, get-biji, ZMX or Nengyun entries.

## Compatibility trade-off: crash residue

On Windows/Linux the \`get-biji\` portable holder now remains after an abnormal
process death; the next run fails with \`SYNC_LOCK_BUSY\` until the holder is
separately examined and safely removed by an authorized operator. Never
auto-delete it based on age, PID text, or a timeout. Do not manually delete a
holder while any related process or browser action may still be running.

Normal success, lock contention, public API and error name remain unchanged.
No account, token, authentication source or business parser was modified.
There is no verified Windows ACL or local filesystem durability evidence.

## Synthetic test evidence (performed, not Windows)

Executor: Linux x64 / Node.js v22.16.0.

- \`node --test skills/mmx/tests/batch-receipt.test.js\`: locally
  executed equivalent byte-identical helper, **8/8 PASS**.
- A synthetic Node test harness against the **byte-identical**
  \`skills/get-biji/scripts/lock.js\`: **5/5 PASS**, including two
  independent OS processes, age jump and owner mismatch.
- Helper GitHub blob SHA: \`d2aa51c785df8a4585338d885397cc4b8b09fd3f\`.
- Lock GitHub blob SHA: \`fd67c93c1ca49f90a7bf2f4034f96d7f4f9dd77b\`.
- **Full MMX and get-biji suite on checked-out repository:** NOT_PERFORMED
  (isolated executor cannot clone GitHub).
- **Windows-native actual tests and original installed Skills:** NOT_EVALUATED.
- **Production provider, SMS, browser, credentials:** NOT_AUTHORIZED / NOT_PERFORMED.

Tests committed under \`skills/mmx/tests/\` and \`skills/get-biji/tests/\`
remain to be run on the real repository checkout.

### PowerShell - offline checkout validation

From a clean clone of this PR HEAD, without running any real provider:

\`\`\`powershell
node --version
node --test .\skills\mmx\tests\batch-receipt.test.js
node --test .\skills\mmx\tests\mmx-batch.test.js
node --test .\skills\get-biji\tests\lock.test.cjs
\`\`\`

Test isolation: synthetic prompt files and fake wrapper only; use an
operator-approved non-production temp directory. Capture TAP exit status,
Windows build, Node version and any FAIL/SKIP, with secrets redacted.

## Reviewer gates

\`STANDALONE_COMPONENT_TEST=PASS(13/13, Linux)\`
\`FULL_REPOSITORY_TEST=NOT_PERFORMED\`
\`WINDOWS_COMPATIBILITY=NOT_EVALUATED\`
\`CROSS_SKILL_RUNTIME_STABILITY=PARTIAL\`
\`ORIGINAL_SKILL_INTEGRATION=NOT_EVALUATED\`
\`INDEPENDENT_AGENT_APPROVAL=NOT_PERFORMED\`
\`PRODUCTION_READINESS=NOT_APPROVED\`

No auto-merge, no force-push, no release or deployment.
