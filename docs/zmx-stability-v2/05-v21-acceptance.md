# ZMX Stability V2.1 — implementation and acceptance boundary

Date: 2026-11-26 UTC. Repository: `caomz/decision-algorithm`.
Only delivery branch: `fix/zmx-main-timeout-stability-20261125`.
Research and starting HEAD: `a14254fe14f8557edf95190d55f7dcecfe03c725`.

Implementation commit: `7ee762b2c3a1d4f6366e306afa36e9b35772d880` (staged review, guarded fixture jobs, logical
shard cap, version metadata and local transport runner). Integration commit:
`e5dfeeabb1cca20dd0f30bf256a8b47151148468`. The evidence-only follow-up is identified
by the containing Git commit. Use the exact Actions `head_sha` when accepting CI;
a previous green run or this prose alone is not acceptance. The published integration tree is byte-identical to the locally tested tree: `ae3d8f528174ea4265cdc25fb3e978c6bc6b13b6`.

## Delivered behavior

| User requirement | Implementation | Evidence / limit |
| --- | --- | --- |
| ZCode first and immediate primary delivery | Default `primary-first`, atomically published primary checkpoint and stderr ready event before secondary dispatch | Primary checkpoint, request intent, observed input and raw output survive coordinator SIGKILL; no complete-round claim before final records |
| Confirmed primary blocker skips MMX | Only an eligible, bound `confirmed_defect/P1` blocks that material version | Regression asserts zero MMX launches; repaired material requires new version/run |
| MMX concurrency 1 / retries 0 / small logical units | Existing defaults preserved; batch now checks a 16 KiB maximum, configurable 8–16 KiB, with 12 KiB experiment target | Checked bytes are sealed into execution snapshots; oversized units rejected before launch; no automatic semantic splitter or truncation |
| Timeout root cause | Exact installed CLI version option and provenance; controlled local delay/error runner | Actual Node fetch/guard contrast; exact MMX CLI still unavailable and unverified |
| 600 / 630 / 650 seconds | Request/wrapper/batch-supervisor unchanged; token budget remains 524288 | Default assertions and diagnostic metadata; raw transport probe does not test wrapper lifecycle |
| Durable jobs / slots / idempotency / disconnection | Existing Phase 3 reused and hardened; stable submit keys, immutable intent, permanent worker claim, query-only wait/resume, shared cooperative slot | Explicit fixture only, default disabled; UNKNOWN never starts another attempt |
| Three gates and full acceptance | PRIMARY_REVIEW_GATE / SECONDARY_REVIEW_GATE / REVIEW_GATE with existing full dual-model validity and independence rules | Eligible P1 veto survives other-side errors, cancellation or missing receipts |
| Optional complete parallel acceptance | `--strategy dual-parallel` | Same validator and material bindings; no weaker acceptance |
| No real provider/backend and no main/windows write | Fixture-only unified entry and durable admission; offline namespace tests; only named branch published | Actual provider and native lifecycle remain NOT_EVALUATED; Draft PR is not merged |

The durable supervisor flushes output bytes and directory entries before
publishing its completion. A separate confirmation binds the completed record
only after its directory sync succeeds. An injected failure after the completion
link becomes visible still returns UNKNOWN, retains the slot and forbids worker
replay. This is a process/filesystem failure regression, not a physical power
loss, reboot or native Windows/macOS acceptance.

## Fixed-source validation

- Starting CI: [45725729964](https://github.com/caomz/decision-algorithm/actions/runs/45725729964),
  exact `a14254f…`, successful. Node 22.23.5: ZCode 94, MMX 88, cross-review 217.
- Local starting checkout: Node 24.22.3, **399/399 passing**, zero failures/skips,
  in a new user/network namespace with only loopback, a kernel-level unreachable
  external-address probe, and a fresh HOME/environment allowlist.
- The final implementation passed **458/458** combined local Node tests, zero failures/skips (ZCode 94, MMX 127, cross-review 237). Results and log digest are in
  [`local-regression.json`](evidence/local-regression.json). Local Python tests
  were not run because pytest is absent; the existing exact-SHA CI installs and
  runs the root and two skill Python suites inside isolated namespaces.
- Four independently executed and replay-verified gate scenarios are retained
  in [`gate-scenarios.json`](evidence/gate-scenarios.json). Their outputs are
  explicitly fixture results, not paid/external model reviews.
- The full 305-second real Node fetch comparison, raw synthetic transcripts and
  source hashes are in the [timeout report](03-v21-timeout-experiment.md).
- CI retains Linux Node 22.23.5 and Python 3.11 isolated execution. macOS and
  Windows jobs check syntax only, including the added job/slot/probe scripts.
  A green native syntax job is not a native lifecycle PASS.

| Offline scenario | PRIMARY_REVIEW_GATE | SECONDARY_REVIEW_GATE | REVIEW_GATE |
| --- | --- | --- | --- |
| Both valid, default staged scheduling | PASS | PASS | PASS |
| Primary confirmed P1 | FAIL | NOT_EVALUATED (not started) | FAIL |
| Secondary confirmed P1 | PASS | FAIL | FAIL |
| Explicit dual-parallel, both valid | PASS | PASS | PASS |

## Main drift and conflict handling

The target branch still matched the requested research SHA at acquisition.
Separately, current main was `7c5e70a91ffa5797bcd8403c636fc994b1240bdc`, seven
maintenance commits beyond the Phase 0 fork. Its changes were README/review
documents, Python skill validation/tests, and a newly added CI workflow.

Those upstream commits were merged **into the delivery branch only**. The sole
add/add conflict was `.github/workflows/ci.yml`: preserve the candidate's verified
loopback isolation, exact PR-head checkout, bounded jobs and Python coverage;
retain upstream's `actions/checkout`, `setup-node` and `setup-python` v7 upgrades.
Main's own [successful run 45736132006](https://github.com/caomz/decision-algorithm/actions/runs/45736132006)
provides the observed upstream baseline. No upstream validator changes were
rewritten. Neither main nor `windows-zmx-validation-20261121` was updated.

## Remaining gates

| Gate | Current result | Needed evidence |
| --- | --- | --- |
| Real MMX CLI 1.0.29 delay/retry/proxy behavior | NOT_EVALUATED | Already-installed fixed CLI, verified local isolation, actual HTTP counts and transport traces |
| Real supplier review | NOT_EVALUATED | Separate authorization and actual valid bound model receipts |
| Native macOS lifecycle | NOT_EVALUATED | Exact-SHA native exit, disconnect, group cleanup and recovery evidence |
| Native Windows lifecycle | NOT_EVALUATED | Exact-SHA native process/ACL/cleanup and recovery evidence |
| Reboot/power loss persistence | NOT_EVALUATED | Independent native restart/storage failure experiments |
| Default durable activation | DISABLED | Prior native lifecycle and real transport acceptance, then an explicitly reviewed enablement change |

No actual MMX package was available locally. Automatic approval review rejected
`npm view mmx-cli@1.0.29 dist version --json` because its npm-registry access was
outside the authorized local-only experiment. No alternate download route was
attempted. Consequently the work must not be described as proving the real CLI's
hidden retry count or resolving every production timeout.

Current source is reviewable with offline evidence. The next acceptance step is
the fixed real CLI against a controlled local service, followed by the exact-SHA
native lifecycle exercises. Until those gates pass, leave durable defaults and
real backend disabled. UNKNOWN tasks remain query-only.
