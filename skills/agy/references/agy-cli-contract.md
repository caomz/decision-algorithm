# AGY CLI contract used by this skill

This is a compatibility note, not a copied manual. Re-check it against the installed binary and official documentation when AGY behavior changes.

## Verified baseline

- Local binary checked on 2026-09-04: `/Users/mingtian/.local/bin/agy`
- Local version: `1.1.26`
- Compatibility checked on 2026-10-04: CLI `1.2.16`; the owner's existing profile reports `init.permission_mode=always-proceed`. The owner explicitly authorized accepting this mode; the read-only tool/path audit still applies.
- Compatibility checked on 2026-11-01: CLI `1.4.12`. With `--json-schema`, the stream ends with a `tool` step named `finish` (state `ACTIVE`) whose parameters carry the answer, then a passive step of type `finish`. The older runner rejected both as unknown and also matched `SKILL.md` inside the answer text. The runner now keeps the `finish` call in the tool trace and requires its parameters to be an object, but does not apply the allowlist or path audits to it: its parameters are output text, not file or command access. The owner approved this adaptation on 2026-11-01.
- CLI `1.4.12` reports API failures with a payload-free `error_message` step before a `result` whose `status` is `ERROR` (seen 2026-11-01: `API error (attempt 2): request failed: … streamGenerateContent?alt=sse": EOF` after about 514 seconds and 49 reads). The runner treats `error_message` as passive, so the run fails as `CLI_ERROR` from the result status instead of being mislabelled `POLICY_VIOLATION`. Do not retry automatically; long, read-heavy reviews are the most exposed, so cap file reads in the prompt.
- CLI `1.4.12` prints `warning: --mode plan has no effect while slash command expansion is disabled.` to stderr. The runner still passes both flags, so on this version read-only behaviour rests on the prompt boundary and the tool audit, not on plan mode.
- Silent truncation observed with CLI `1.4.12`: a 211 KB prompt was cut after about 191.6 KB (UTF-8) with no error event; only the model's answer mentioned it. Keep prompts under about 180 KB, put the most important data first, and split larger reviews into batches.
- Compatibility checked on 2026-11-17: CLI `1.5.10`. The `stream-json` `init` and `result` events omit a `model` field; the runner passes a private `0600` `--log-file` on live turns, extracts the resolved session model from `model_config_manager.go` / `model_resolver.go` (ignoring `llm_monitor.go` background tier lines) as `model_identity_source="runtime.cli_log"`, and unlinks the temporary log immediately after parsing. To prevent `cmux.app` PATH wrappers from hijacking `agy`, default binary resolution prefers `~/.local/bin/agy`, skips `/cmux.app/Contents/Resources/bin/` entries, and sets `CMUX_ANTIGRAVITY_HOOKS_DISABLED=1`. Because `summary_fingerprint` binds the exact Python interpreter hash, generate and verify summary canary attestations with the same managed Python interpreter used at runtime (prefer Python 3.11+).
- Official headless documentation: <https://www.agy.dev/docs/cli/headless/>
- Official sandbox documentation: <https://www.agy.dev/docs/cli/sandbox/>
- Official execution-mode documentation: <https://www.agy.dev/docs/cli/modes/>

Run these read-only probes before diagnosing version drift:

```bash
command -v agy
agy --version
agy --help
```

Do not run `agy update` or install a different version automatically.

## Headless protocol

The runner sends exactly one NDJSON input line to stdin:

```json
{"event":"user","message":{"content":"<prompt>"}}
```

It invokes AGY with:

```text
--input-format stream-json
--output-format stream-json
--mode plan
--sandbox
--disable-slash-commands
--print-timeout <inner deadline>
```

Do not pass `-p`/`--print` when using streaming input. Add `--json-schema <path>`, `--model <slug>`, `--effort <level>`, or `--conversation <uuid>` only when requested by the caller.

The default outer deadline is 600 seconds and the default AGY inner deadline is 540 seconds. When tests or callers shorten the outer deadline, the runner derives a shorter inner value. The live 1.1.26 streaming smoke test completed successfully with `--print-timeout`, so the flag is supported on this headless path.

Healthy output has one `init` event, zero or more `step_update` events, and exactly one terminal `result` event. The terminal result carries `conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, and `usage`. With `--json-schema`, it also carries `structured_output` and `json_schema`. Runner stdin/stdout/stderr and both subprocess pipes are explicitly UTF-8.

Known terminal statuses are `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING`, and `RUNNING`. Only `SUCCESS` is accepted. Unknown values are protocol errors.

When resuming, `response` is current-turn text but `usage`, `num_turns`, and duration are cumulative for the conversation.

## Tool audit

`step_update.step_type == "tool"` exposes `tool_name` and `tool_info`. For an ordinary explicit review, name each approved path with `--allow-read`. The audit recognizes the documented local file/list/name-search/content-search tools, checks their argument schemas, and compares resolved targets to the exact allowlist inside the active workspace. Content reads and searches require an approved regular file. Access to `SKILL.md` or `/skills/`, unknown parameters, external URIs, tool execution, and subagents fail closed.

Passive `user_input`, `agent_response`, `checkpoint`, `finish`, and `error_message` steps are accepted. The terminal `finish` tool may carry answer data as an object. Ordinary reviews accept known `request-review`, `strict`, and `always-proceed` modes. Summary mode requires the observed mode `strict` and rejects any recorded tool request other than terminal output.

## Summary-only runtime canary

`--summary-only --schema review-v1.schema.json --safety-attestation <path>` creates a fresh private workspace with session-only denial settings and a workspace `PreToolUse` guard. The settings deny file reads/writes, commands, network and MCP. The hook denies all actual tool actions, including child agents, and accepts only a correctly shaped terminal `finish` callback. The runner checks the stream and deny log afterward. See [CLI permissions](https://antigravity.google/docs/permissions/#cli-fine-grained-permissions) and [PreToolUse](https://antigravity.google/docs/hooks/#pretooluse).

`--check-summary --safety-attestation <path>` checks the current runner, executable and runtime policy without a model call. The owner-only attestation binds a real canary to the launcher, its local `agy.real` companion when present, the Python interpreter, runner code, and active policy configuration hashes.

For an authorized runtime acceptance:

1. Run the installed runner with `--prepare-summary-canary --schema review-v1.schema.json`. This offline command produces a private synthetic fixture directory and an exact invocation in `canary.argv`.
2. Run that invocation once with the reported working directory and NDJSON input file. Capture the reported output files privately and record the actual CLI exit code. The probe requests only synthetic fixture actions. If running the tool probes could exceed the authorized scope, keep the guard unavailable.
3. Following a zero exit, run `--verify-summary-canary <canary.cwd> --safety-attestation <new-private-path>`. The verifier requires same-conversation denial records for read, write, command and subagent, intact fixture/control files, no write markers, and no evidence of completed tool execution. Missing attempts or incompatible CLI behavior leave summary mode unverified.

Offline fake-CLI tests establish the wrapper and hook wiring. The runtime attestation requires independent live evidence from the actual CLI; test fixtures are kept outside operational state.

## Security limitations

- `--mode plan` makes the agent prefer read-only analysis; it is not an OS security boundary.
- `--sandbox` restricts terminal commands but leaves the active workspace writable.
- `--dangerously-skip-permissions` approves writes and commands and must never be used.
- `--disable-slash-commands` reduces skill expansion but does not replace the prompt boundary or tool audit.

For runtime tutorial checks, the host—not AGY—executes each user-approved command in an isolated scratch copy and returns the evidence to the same AGY conversation.

## Failure handling

- Authentication errors: ask the user to start interactive `agy` and complete login. Do not inspect or print Keychain contents.
- Model errors: show `agy models`; do not silently substitute another model.
- Quota/rate-limit/billing errors: stop without retrying.
- Permission soft-denial: treat an attempted non-read-only action as a policy violation, even if AGY exits `0`.
- Timeout or malformed/incomplete NDJSON: return `ERROR`; never infer PASS from partial text.
- Keep valid model response data in private receipts. Failure diagnostics use normalized categories and safe details. Consult the complete local receipt for a valid response.
