# Phase 1 — MMX timeout guard integration (candidate, PARTIAL)

Parent candidate: 8337ae6a8069686fa287b175d0e8f1deea9c227c. Source: [PR #7 immutable head](https://github.com/caomz/decision-algorithm/commit/20b69e5a8c3beab8e40cd3036827405075eb4928); historical control: [PR #4](https://github.com/caomz/decision-algorithm/commit/cfe7b568740768624667152500c6c8171f2ca8d3). Bind execution evidence to the containing commit via git rev-parse HEAD and Actions head SHA.

## Implemented source changes
- Exact reviewed guard blob (335f057386e1f528a76bb7b2ba918fe6a6a1b9d4); private initialization acknowledgement, exit 78 before CLI evaluation if preload fails, worker inheritance handling. Package entry/npm shim resolution, proxy/config and custom launcher limitations, /v1 normalization and 404 diagnosis, thinking-only max_tokens classification.
- Reuse PR #7 runtime code on the identical main parent blob; preserve main cleanEnv imports and release fixture filters by applying exact hunks, not whole old files. Deterministic fixture cancellation synchronization replaces the newer main's fixed 300ms sleep.
- Added monotonic execution and cleanup durations, independently observed exit code/signal, local exit observation, explicitly unknown tree cleanup when stopping, queue_wait_ms=0 for this nonqueued entry, actual CLI/wrapper duration arguments and null supervisor duration. Cleanup timer 4s is a grace timer; Windows taskkill has separate 2s bounds. Wrapper expiration is observed; a CLI-reported timeout is inferred; exit 6 and elapsed time alone do not establish HTTP root cause. No fabricated queue/supervisor diagnosis.
- Explicit signal rejection even if a child wrote success JSON. Existing release manifest must contain the guard.
- Preserved finite existing request/wrapper configuration and bounded cleanup timer; no broad timeout extension. Profile and env ceiling inherited from existing Node timer-range validation. Phase 2 must bound batch supervisor and verify cleanup independently.

## Validation / missing evidence
Candidate runtime tests have not yet completed. Existing PR #7 fake CLI tests and new telemetry fixture are in the isolated Linux CI. Command: node --test skills/mmx/tests/mmx-chat.test.js (within .github/scripts/zmx-isolated-test.sh). Historical #4 real CLI 305s report is not current evidence. The fixed real CLI transport and true 300s control are not available in this container (GitHub DNS failed); no installed user CLI or credentials accessed.

T01 / T02: NOT_EVALUATED (real fixed CLI transport, delayed headers and body stall).
T03: fixture tests added from #7; actual HTTP-count verification NOT_EVALUATED.
T04: proxy/custom launcher/undici limitations exercised in reused fixture tests, current CI pending.
T05: batch actual exit checks still Phase 2.
T14 / T15: NOT_EVALUATED, native execution and external request proof missing.
T16: real backend not enabled. REAL_PROVIDER=NOT_EVALUATED.

## Risk and rollback
No claim of real-provider resolution; proxy dispatchers can override the preload. Historical guard disables undici's two per-transport timers only under the outer request/wrapper bounds. Unknown transport failures remain unknown. Legacy batch retry defaults remain unchanged until Phase 2, so this candidate is not suitable for paid use. Do not install this candidate into a live managed Skills root or activate durable jobs. Revert this phase commit alone if needed, do not alter main/windows. 
