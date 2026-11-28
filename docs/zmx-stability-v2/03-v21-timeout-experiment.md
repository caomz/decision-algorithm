# V2.1 — MMX timeout diagnosis and controlled transport evidence

This work extends the Phase 0–2 implementation on research baseline
`a14254fe14f8557edf95190d55f7dcecfe03c725`. It does not enable a real review
backend, make a provider request, or activate persistent jobs by default.
The containing commit and its CI identify the candidate; the transport evidence
also binds its exact probe and guard bytes independently by SHA-256.

## Fixed defaults and implemented diagnosis

| Layer | Preserved default | Evidence / limitation |
| --- | --- | --- |
| Request | 600 seconds | Wrapper passes the effective value to the CLI. |
| Wrapper | 630 seconds | Independently observed local deadline; cleanup is bounded separately. |
| Batch supervisor | 650 seconds | Existing `wrapper + 20` default is unchanged. |
| MMX batch concurrency | 1 | Persisted in the batch plan and final receipt. |
| Automated retries | 0 | One launch per shard; provider-internal retries remain a separate unknown. |
| Output token budget | 524288 | Unchanged; no reduction to make a timeout disappear. |
| Logical input target | 12 KiB | Experimental starting point within 8–16 KiB, measured as UTF-8 bytes. |
| Maximum prepared prompt | 16 KiB | `--shard-max-bytes 8192..16384` selects an experimental cap. Smaller meaningful units are accepted. |

`mmx-batch.js` rejects an oversized prepared prompt before reserving a batch or
launching a wrapper. It does **not** silently truncate or mechanically cut text:
the caller must regenerate task-focused logical units and retain complete
instructions, relevant dependencies, evidence IDs and coverage. The bytes that
pass the size check are the same bytes snapshotted and hashed for execution, even
if the source file is subsequently edited. Per-shard byte lengths are recorded
alongside existing material, request and configuration bindings.

The optional `--expected-cli-version 1.0.29` is forwarded from batch to wrapper
and refuses an unknown launcher or a different installed package version before
invocation. The normal receipt records `cli_identity` (local package metadata
version plus entry-file digest). This is local provenance, not a cryptographic
publisher attestation or evidence that a fake package is a genuine CLI. Existing
installs are not upgraded or modified.

`fetch_timeout_guard=preloaded` means its private initialization acknowledgement
was observed. It does not establish that the CLI retained that dispatcher for
all requests. Environment/config proxies can replace it; `proxy_limited`,
`custom_launcher`, `guard_missing`, and `undici_not_found` are limitations, not
successful transport verification. A selected guard that fails initialization
still exits before the CLI entry is evaluated. A CLI network error near 300s
remains an inference until compared with direct transport observations.

## Controlled runner

`skills/mmx/scripts/mmx-timeout-experiment.js` runs only inside an already
isolated Linux network namespace whose only interface is loopback and which has
no IPv4 default route. It uses a new private HOME/config/temp, a synthetic local
key, and a server bound to `127.0.0.1`. It downloads nothing. Even its internal
fetch-child mode rejects an external URL. Proxies, user credentials, and host
Node startup hooks are not inherited.

There are two explicitly separate suites:

- `node-fetch`: the real Node fetch implementation, with and without the actual
  repository guard using an explicitly selected already-installed undici copy.
  This can establish Node transport behavior, **not MMX CLI behavior**.
- `mmx-cli`: an already-installed package whose name is `mmx-cli`, exact version
  is `1.0.29`, and bin stays inside its package. Its own undici dependency is
  resolved locally. The runner never installs, upgrades, or changes the CLI.

Case groups are `headers` (default), `body`, `errors`, and `all`. The header and
body controls delay completion by 305000ms by default, beyond the 300s transport
boundary while keeping the request deadline at 600s. Error controls return HTTP
429/500 or reset the connection. The default actual-CLI header group also runs
the error controls. Actual CLI cases are serial; independent Node-fetch controls
may run together to avoid multiplying a five-minute diagnostic wait. Those
fetch probes are not MMX provider jobs.

The raw transport experiment bypasses the production wrapper deliberately, so
its `wrapper_timeout_ms` is `null`: it cannot be used as a 630s wrapper lifecycle
acceptance. The runner has a finite 650s subprocess supervisor, bounded 8s cleanup,
process-group signal attempts, and completion independent of pipe closure. It
reports observed exit separately from unknown descendant cleanup. It saves
bounded raw synthetic stdout/stderr, exact hashes, request count/timing/body
hashes, runtime versions, and guard initialization. No real prompt or credential
is included in this experiment.

The intended commands, **inside verified loopback isolation**, are:

```bash
node skills/mmx/scripts/mmx-timeout-experiment.js \
  --suite node-fetch --case-group all \
  --undici-path /absolute/path/to/already-installed/undici/index.js \
  --delay-ms 305000 --out /new/private/experiment-directory

node skills/mmx/scripts/mmx-timeout-experiment.js \
  --suite mmx-cli --cli-root /absolute/path/to/already-installed/mmx-cli \
  --case-group all --delay-ms 305000 \
  --out /new/private/mmx-cli-experiment-directory
```

An existing output directory is refused to preserve evidence. A shorter
`--delay-ms` is a fixture/smoke check and sets `threshold_300s_exercised=false`;
it cannot establish the 300s boundary. A CLI that sends zero local requests is
reported as transport `NOT_EVALUATED` and retry `INCOMPLETE_NOT_EVALUATED`, even
if its process exits cleanly. No observed retry in a few scenarios does not
establish zero retries for all possible faults.

## Execution evidence

The final probe is run from an immutable local copy matching the repository
runner and guard bytes. Its isolated run, raw transcripts and exact results are
recorded under [`evidence/mmx-node-fetch-305s/`](evidence/mmx-node-fetch-305s/).
The Node process uses `v24.22.3`, bundled undici `7.30.2`, and the guard uses the
already-installed npm undici `6.28.0`. This is a Linux Node transport contrast;
it does not substitute for the user's macOS Node/CLI acceptance.

Final run created at `2026-11-26T03:02:12.038Z` (UTC); its own `plan.json`
contains the authoritative timestamp. All seven cases reached the controlled
server exactly once, and all subprocess exits were observed. The exact results
are:

| Controlled case | Observed duration | Result | Requests |
| --- | ---: | --- | ---: |
| Delayed headers, unguarded | 301.579 s | `UND_ERR_HEADERS_TIMEOUT` | 1 |
| Delayed headers, guard initialized | 305.208 s | HTTP 200, complete body | 1 |
| Stalled body, unguarded | 301.575 s | `UND_ERR_BODY_TIMEOUT` | 1 |
| Stalled body, guard initialized | 305.200 s | HTTP 200, complete body | 1 |
| HTTP 429 control | 0.180 s | HTTP 429 observed | 1 |
| HTTP 500 control | 0.184 s | HTTP 500 observed | 1 |
| Connection reset control | 0.187 s | `UND_ERR_SOCKET` | 1 |

This demonstrates the 300s header/body timers and the guard's effect for the
recorded Node/undici combination. HTTP 429/500 are expected error controls; a
Node-fetch subprocess printing their HTTP status with exit 0 is not a model
review PASS. The request counts do not establish an actual MMX CLI retry policy.
Earlier exploratory probes are not substituted for this final run.

Probe SHA-256:
`540a5ac02c5b4b20dbd14cfb8f6e51a77d06223598b25b7e9c61d1674a18e928`.
Guard SHA-256:
`d242a47aa6342f378d225939da7c76a09127e27e2ecabc96aab4200a35202941`.
`SHA256SUMS` covers every archived result, acknowledgement and raw transcript;
raw stdout/stderr hashes also agree with each case receipt. Neither the report
nor its integrity hashes authenticate a remote supplier. The evidence archive
contains only synthetic local test data; temporary home/config files were not
copied.

## Actual CLI acquisition and remaining acceptance

No `mmx` CLI was installed on PATH, and inspection of available local workspace
and runtime files found no `mmx-cli` package to run. An attempted read-only
`npm view mmx-cli@1.0.29 dist version --json` was rejected by automatic approval
review: it would contact `registry.npmjs.org`, outside the user's loopback-only
experiment constraint, and that external request was not authorized. The action
was not retried through a different network path or tool. No provider request
or CLI installation was made.

Therefore the fixed **actual MMX CLI** 300s comparison, its real transport stack,
proxy behavior, and internal HTTP retry policy remain **NOT_EVALUATED**. The
runner is supplied to collect those observations with an already-available
exact CLI in an authorized isolated environment. Current observations do not
justify a real-backend or durable-job default, and an UNKNOWN job must not be
resubmitted automatically.

## Regression scope

Meaningful additions cover the UTF-8 shard cap before launch, immutable checked
bytes despite later file edits, unchanged deadlines/token budget/retry defaults,
exact version mismatch with zero invocation, unknown launcher refusal, probe
isolation/output-directory refusal, fixed-version runner checks, and zero-HTTP
CLI runs that cannot claim real transport or retry verification. The complete
MMX suite initially passed 125/125; the subsequently added zero-request
regression and all four diagnostic tests passed. The final containing commit's
CI remains the authoritative full regression result.
