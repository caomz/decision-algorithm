# R2 Windows Skills runtime isolation: scope, actual entrypoints, offline evidence

## Status and boundary

This R2 work changes **only** `review-staging/nengyun-security-r1/` in the
GitHub review branch. The repository's historical Windows ZMX branch and all
business Skills remain untouched. The runner is an optional standalone API/CLI,
not an installed Skill or an integrated MMX/ZCode/Nengyun production wrapper.

## Read-only source inventory before writing

PR #11 was checked as Draft, base `windows` at
`c954e2c08c8db0c0b488aaf1681db55810e8fb38`, head R1 at
`188b221feecc6c5616590fa7e81afc887f5ba66c`, merge-base equal to that
base. The 17 original PR files were additions exclusively under this staging
folder. The extracted R1 source was verified byte-for-byte by Git blob SHA
against the GitHub source for key modules before testing. A full fresh Git
checkout is unavailable in the isolated Linux executor (GitHub DNS unavailable).

Actual repository entrypoints inspected read-only on R1:

| Item | Observed contract / isolation concern | Change |
| --- | --- | --- |
| `skills/mmx/SKILL.md`, `scripts/mmx-chat.js` | Node wrapper spawns CLI, owns a temporary directory, honors existing model/profile and timeout rules | None |
| `skills/mmx/scripts/mmx-batch.js` | Bounded sub-process concurrency and wrapper-based receipts | None |
| `skills/zcode/SKILL.md`, `scripts/zcode-chat.js` | Own HOME/cwd isolation and CLI/receipt behavior | None |
| `skills/zcode/scripts/zcode-run.js` | Detached persistent job supervisor; may own descendant processes | None |
| `skills/zcode/scripts/zcode-batch.js` | Batch worker pool with retry/receipt rules | None |
| `scripts/install_skills.py` | Install/linking command with explicit --apply | None |
| `scripts/windows-zmx-check.*` | Not present in staging `windows` ref used for this PR; historical branch frozen | None || Original `nengyun-auto-login-test` entrypoints | Not present in this GitHub repo | NOT_EVALUATED |

Actual installed Windows build, Node, PowerShell, MMX/ZCode versions, home paths,
ACLs and browser sessions cannot be read from this cloud executor: **UNKNOWN**.
Repository Skill docs report version 2.6.0 for MMX and 1.4.0 for ZCode; these
are repository metadata, not installed version measurements.

## Required per-Skill resource manifest before opt-in use

| Field | Required mapping |
| --- | --- |
| `skillId` | Stable non-secret identifier, not the sole lock key |
| `entry`, `args` | Original wrapper file and exact argv, without shell interpolation |
| `cwd` | Original working directory; never replace it with the run directory |
| `env` | Optional *non-sensitive* additions only; protected auth and HOME paths cannot be overridden |
| `runRoot` | Approved writable run-root; runner creates an exclusive `runDir` below it |
| `lockRoot` | The **same existing local directory** for every cooperating Skill process |
| `resources` | Explicit file targets and stable browser session identity, with unknown sharing rejected |
| `timeoutMs` | Explicit execution deadline; no automatic retry |
| `assumeNoDescendants` | Requires separate evidence that the worker leaves no child processes; otherwise a lock remains held after a run with shared resources |

Supported resource rules: a uniquely owned run file need not be listed as a
shared resource; read-only files can be shared; **every other writable target
and shared browser session must be declared**. A lock file is keyed by the
canonicalized target path or a verified session identity, **never by skillId**.
Unknown resource relations must not be approved for concurrent use.

The lock root must be an operator-approved local directory with verified Windows
ACL; the library cannot prove those ACLs from Unix mode values. Network paths,
unknown reparse aliases, target symlinks and hardlinks fail closed or remain
unsupported. The lock filename and sorted acquisition order are stable between
cooperating processes. A crashed holder leaves a lock that is **never stolen
on age**. This may block the same resource pending supervised recovery, while
independent resource keys continue.

## Offline opt-in example (fictional file paths only)

Save a *non-secret* manifest in an isolated test directory. A manifest is local
runtime input, not a file to add to a public release. Adapt paths only after
reviewing the real entrypoint and actual shared resources:

```json
{
  "skillId": "SyntheticSkill",
  "entry": "C:\\sandbox\\fake-skill.js",
  "cwd": "C:\\sandbox",
  "args": ["example", "arg with spaces"],
  "env": { "SYNTHETIC_MARK": "test-only" },
  "runRoot": "C:\\sandbox\\runs",
  "lockRoot": "C:\\sandbox\\locks",
  "resources": [
    { "type": "file", "path": "C:\\sandbox\\shared-output.json" },
    { "type": "browser", "sessionId": "synthetic-session-a" }
  ],
  "timeoutMs": 20000,
  "lockWaitMs": 10000,
  "assumeNoDescendants": false
}
```

`assumeNoDescendants=false` means the lock stays blocked without tree proof,
by design. Set it to true only after independently validating a child has no
surviving descendants. Existing MMX/ZCode wrappers may spawn children, so do
**not** simply set it to true for them.

```powershell
node .\scripts\ny_runtime_cli.js inspect --spec .\runtime-spec.synthetic.json
node .\scripts\ny_runtime_cli.js run --spec .\runtime-spec.synthetic.json
node --test
node .\scripts\ny_windows_probe.js
```

The CLI preserves business stdout/stderr bytes and original process exit code
on normal completion. Wrapper errors use stderr-only **error codes** and code
125; this wrapper-specific behavior is not yet an established legacy contract.
`inspect` performs metadata-only analysis, not a real `--check` login probe.
Running `run` with `--check` in child args fails *before* creating a runDir.

Unsupported launch path: `.cmd/.bat` cannot be safely quoted for arbitrary
arguments without a Windows-validated bridge; R2 returns
`EUNVERIFIED_CMD_BRIDGE`, and does not use `shell:true`. `.ps1` uses
PowerShell `-NoProfile -NonInteractive -File` without changing execution policy.
Original stdout **stream timing**, interactive stdin, native Win32 process tree
containment, terminal escape behavior and `.cmd` quoting are **NOT_EVALUATED**.

## Exit/timeout and file-state semantics

- Normal child close: `FINISHED` with original stdout/stderr bytes and exit code
  *only* when the operator-provided single-process contract is acceptable for
  the resource set. Otherwise `RESOURCE_UNCERTAIN` retains the lock.
- Timeout/cancel: terminate only the direct owned child. Retain locks until it
  is confirmed stopped; with unknown descendants return `RESOURCE_UNCERTAIN`.
- Lock wait exhausted: `ERESOURCE_BUSY`; never kill a holder or take over old
  markers. If ownership verification fails, leave the marker intact.
- A failed owned JSON write: `UNCHANGED_FAILURE` only if the original bytes
  are verified or the original was absent. `INDETERMINATE` retains the lock,
  blocks dependent tasks and never restores an old record automatically.
- Owned run artifacts are left available for inspection unless `cleanupOwned`
  was requested and the process and locks have been safely released. Cleanup
  operates only on this run's unique directory.
- No production config, cookie, browser, profile, Job, or installed Skill is
  touched by any test, and no provider requests are performed.

## Offline evidence matrix (T01–T14)

| ID | Evidence in this isolated package | Boundary |
| --- | --- | --- |
| T01 | Sequential A-B-A with different cwd/runDir/env | Offline Node child process PASS |
| T02 | Independent resource keys and real cross-process parallel barrier | Offline Linux PASS |
| T03 | Same writable file and browser key serialized; independent OS-process lock workers | Offline Linux PASS |
| T04 | Duplicate Skill starts serialize on a shared resource | Offline Linux PASS |
| T05 | Old lock marker is not stolen; sorted multi-resource ordering | Offline Linux PASS |
| T06 | Failure and cancellation of one worker leave independent B running | Offline Linux PASS |
| T07 | Unknown surviving child retains shared lock, second worker rejected | Offline Linux PASS |
| T08 | Owned JSON create/replace/injected failures, verified original preserved, unknown retains lock | Offline Linux PASS; OS crash/Windows replace NOT_EVALUATED |
| T09 | Chinese/space/quote/special argument boundaries for Node; PS1 spawn classification | Offline Linux PASS; Windows PS1/cmd NOT_EVALUATED |
| T10 | CLI bytes and exit=7 unchanged, no diagnostics on business stdout | Offline Linux PASS; actual MMX/ZCode behavior NOT_EVALUATED |
| T11 | Read-only inspect performs no app write or process spawn; --check run rejected | Offline Linux PASS; original `--check` NOT_EVALUATED |
| T12 | Existing strict logger/distribution tests with synthetic sensitive fixtures | Offline Linux PASS; final real distribution NOT_EVALUATED |
| T13 | Same browser key serializes; independent keys don't block; timeout unknown retains | Offline Linux PASS; real CDP sessions NOT_EVALUATED |
| T14 | MMX/ZCode docs and wrappers inspected read-only; no shared files modified | Original Skills full runtime regression NOT_EVALUATED |

Run `node --test` from this directory to reproduce the above. The executor
uses Linux Node v22.16.0; Windows filesystems, ACL, COM/PowerShell behavior,
process trees, long paths, junctions and actual installed CLI versions remain
**NOT_EVALUATED**. A passing process-termination test is not power-loss proof.

## Independent review and merge gate

For each actual Agent, record `BASE_SHA`, current `HEAD_SHA`, role, real model
identity, `path:line`, evidence, P1/P2, and verdict. A single assistant taking
six viewpoints is not an independent multi-agent review.

**Required gates:** `STANDALONE_OFFLINE_TEST`, `WINDOWS_COMPATIBILITY`,
`CROSS_SKILL_RUNTIME_STABILITY`, `BUSINESS_BEHAVIOR_REGRESSION`,
`ORIGINAL_SKILL_INTEGRATION`, `MULTI_AGENT_REVIEW`, `PRODUCTION_READINESS`.
No single offline PASS upgrades any other status. The Draft PR is for review
only. Do not merge, deploy, or touch production credentials without a new,
separate authorization and the missing Windows/native integration evidence.
