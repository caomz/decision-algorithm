"use strict";
// Phase 2: same helper in each independently installed Skill.
// Mac exclusive archive + Windows cooperative cancellation and exit checks.
// No local evidence is promoted to remote termination or exactly-once proof.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const CAP = 16 * 1024 * 1024;
const CLEANUP_MS = 8000;
const hash = b => createHash("sha256").update(b).digest("hex");
const json = o => JSON.stringify(o, null, 2) + "\n";

// Explicit offline fixture contract for the per-shard wrapper. An override is
// honoured only when ZMX_OFFLINE_FIXTURE=1 is set together with an absolute
// regular file inside the declared fixture root (after realpath) and its
// SHA-256. In offline mode nothing is ever defaulted: a missing, empty,
// relative, escaping or mismatched wrapper is refused before an archive is
// reserved or a process starts. Outside offline mode an override is an
// error, so a test can never reach the production wrapper by omission.
function resolveWrapper(env, side, defaultWrapper) {
  const key = side.toUpperCase() + "_BATCH_WRAPPER";
  const override = env[key];
  const refuse = why => { throw Object.assign(new Error(`offline fixture wrapper refused: ${why}`), { code: "ZMX_FIXTURE_CONTRACT" }); };
  if (env.ZMX_OFFLINE_FIXTURE !== "1") {
    if (override !== undefined) throw Object.assign(new Error(`${key} requires ZMX_OFFLINE_FIXTURE=1`), { code: "ZMX_FIXTURE_CONTRACT" });
    return defaultWrapper;
  }
  if (typeof override !== "string" || !override) refuse("wrapper path missing");
  if (!path.isAbsolute(override)) refuse("wrapper path must be absolute");
  const root = env.ZMX_FIXTURE_ROOT, expected = env.ZMX_FIXTURE_SHA256;
  if (typeof root !== "string" || !path.isAbsolute(root)) refuse("fixture root missing or not absolute");
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) refuse("wrapper digest missing");
  let stat;
  try { stat = fs.lstatSync(override); } catch { refuse("wrapper not found"); }
  if (stat.isSymbolicLink() || !stat.isFile()) refuse("wrapper is not a regular file");
  const real = fs.realpathSync(override);
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) refuse("wrapper escapes the fixture root");
  if (hash(fs.readFileSync(real)) !== expected) refuse("wrapper digest mismatch");
  return real;
}
function claimArchive(file, side) {
  // Even callers without --receipt-file get a private, crash-retained archive.
  // Never silently run an unarchived billed request.
  if (file === null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), side + "-batch-evidence-"));
    file = path.join(root, "receipt.json");
  }
  // O_EXCL prevents following symlinks and overwriting existing evidence.
  // The reserved file is intentionally left in place after any failure.
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    const dir = file + ".shards";
    fs.mkdirSync(dir, { mode: 0o700 });
    return { fd, file, dir };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function saveShardReceipt(archive, index, receipt) {
  if (!archive) return;
  const file = path.join(archive.dir, String(index).padStart(3, "0") + ".json");
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(receipt, null, 2) + "\n", null, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function finishArchive(archive, envelope) {
  if (!archive) return;
  try {
    fs.writeSync(archive.fd, JSON.stringify(envelope, null, 2) + "\n", null, "utf8");
    fs.fsyncSync(archive.fd);
  } finally { fs.closeSync(archive.fd); }
}
function archiveErrorCode(err) {
  return typeof err?.code === "string" ? err.code : "IO";
}

function sourceBytes(file) {
  const real = fs.realpathSync(file), before = fs.lstatSync(real);
  if (!before.isFile() || before.size > 48 * 1024 * 1024) throw new Error("invalid input");
  const fd = fs.openSync(real, "r");
  try {
    const a = fs.fstatSync(fd);
    if (a.dev !== before.dev || a.ino !== before.ino || a.size !== before.size) throw new Error("input changed");
    const bytes = fs.readFileSync(fd), b = fs.fstatSync(fd);
    if (bytes.length !== a.size || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) throw new Error("input changed");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeOnce(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function limitSeconds(n) { return Number.isSafeInteger(n) && n >= 1 && n <= 86400; }

function createBatch({ side, args, shards, fixedArgs, configFiles, supervisorSeconds, parseReceipt }) {
  const concurrency = args.concurrency ?? 1;
  const batchSeconds = args.batchTimeout ?? Math.min(86400,
    Math.ceil(shards.length / concurrency) * (supervisorSeconds + CLEANUP_MS / 1000) + 5);
  if (!limitSeconds(supervisorSeconds) || !limitSeconds(batchSeconds)) throw new Error("invalid deadline");
  const archive = claimArchive(args.receiptFile, side);
  const owner = fs.lstatSync(archive.dir);
  const ensureArchive = () => {
    const st = fs.lstatSync(archive.dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== owner.dev || st.ino !== owner.ino) throw new Error("archive replaced");
  };
  const batchId = randomUUID(), jobs = [], config = [];
  const active = new Set(), results = new Array(shards.length);
  const started = performance.now();
  let failed = null, stopping = null, batchTimer, halting = null, halted = null;
  try {
    for (const item of configFiles) {
      const bytes = item.bytes ?? sourceBytes(item.file), file = path.join(archive.dir, item.name);
      ensureArchive(); writeOnce(file, bytes);
      config.push({ flag: item.flag, file, sha256: hash(bytes) });
    }
    const effectiveArgs = [...fixedArgs];
    for (const item of config) effectiveArgs.push(item.flag, item.file);
    for (const [i, shard] of shards.entries()) {
      ensureArchive();
      const bytes = sourceBytes(shard.real), digest = hash(bytes), label = String(i).padStart(3, "0");
      const dir = path.join(archive.dir, label + ".input");
      fs.mkdirSync(dir, { mode: 0o700 });
      const file = path.join(dir, path.basename(shard.file)); writeOnce(file, bytes);
      const attemptId = randomUUID(), shardId = label + "-" + digest.slice(0, 16);
      const request = { format: 1, batch_id: batchId, provider: side, shard_id: shardId, attempt_id: attemptId,
        material_sha256: digest, config_sha256: config[0]?.sha256 ?? null, argv: effectiveArgs, retry_policy: "none" };
      jobs.push({ i, shard, label, file, attemptId, shardId, digest, effectiveArgs,
        requestSha: hash(json(request)), cancelFile: path.join(dir, "cancel.request") });
    }
    ensureArchive();
    writeOnce(path.join(archive.dir, "plan.json"), json({ format: 1, batch_id: batchId,
      provider: side, retry_policy: "none", concurrency, supervisor_timeout_ms: supervisorSeconds * 1000,
      batch_timeout_ms: batchSeconds * 1000, cleanup_timeout_ms: CLEANUP_MS,
      config: config.map(x => ({ flag: x.flag, file: path.basename(x.file), sha256: x.sha256 })),
      argv: jobs[0]?.effectiveArgs ?? [], shards: jobs.map(j => ({ shard_id: j.shardId, attempt_id: j.attemptId,
        material_sha256: j.digest, request_sha256: j.requestSha, snapshot: path.relative(archive.dir, j.file),
        request_state: "NOT_STARTED" })) }));
  } catch (err) { fs.closeSync(archive.fd); throw err; }

  function stop(reason) {
    if (stopping) return;
    stopping = reason;
    for (const cancel of active) cancel(reason);
  }
  function prefix(j) {
    return { shard: j.shard.label, prompt_file: j.shard.file, shard_id: j.shardId,
      attempt_id: j.attemptId, material_sha256: j.digest, request_sha256: j.requestSha,
      retried: false, retry_reason: null, retry_policy: "none" };
  }
  function runAttempt(j, wrapper) {
    const attemptStart = performance.now(), identity = prefix(j);
    ensureArchive();
    // Intent precedes spawn. If the terminal file is absent or corrupt after a
    // crash, the request is UNKNOWN and must never be automatically replayed.
    // In-memory intent cannot become NOT_STARTED if the archive is replaced.
    j.intentWritten = true;
    writeOnce(path.join(archive.dir, j.label + ".started.json"),
      json({ ...identity, request_state: "UNKNOWN", state: "launch_intent" }));
    return new Promise(resolve => {
      let child, done = false, reason = null, stopAt = null, rootExited = false;
      let code = null, signal = null, closed = false, overflow = false, stderrPresent = false, spawned = false;
      let bytes = 0, chunks = [], deadline, escalation, hardDeadline;
      let signalSent = false, forceAttempted = false;
      // The wrapper root leads a private process group on POSIX. Whether that
      // group is gone is the only descendant fact this supervisor can observe
      // itself. The production wrappers start the CLI in a further group of
      // its own and report that group as local_tree_cleanup in their receipt.
      // Neither fact covers descendants that left these groups, or the
      // remote provider.
      const grouped = process.platform !== "win32";
      const ownedGroup = () => {
        if (!grouped) return "not_applicable";
        if (!child?.pid || !rootExited) return "not_checked";
        try { process.kill(-child.pid, 0); return "present"; }
        catch (error) { return error.code === "ESRCH" ? "absent" : "unknown"; }
      };
      const expectedConfig = config[0]?.sha256 ?? "";
      const env = { ...process.env, ZMX_BATCH_ATTEMPT_ID: j.attemptId,
        ZMX_BATCH_MATERIAL_SHA256: j.digest, ZMX_BATCH_CONFIG_SHA256: expectedConfig, ZMX_BATCH_CANCEL_FILE: j.cancelFile };
      const errorReceipt = (status, error) => ({ status, complete: false, review_gate: "NOT_EVALUATED", error });
      const stoppedReceipt = () => errorReceipt(reason === "cancelled" ? "cancelled" :
        reason === "output_limit" || reason === "archive_error" ? "child_error" : "timeout", reason);
      let settling = false, survivorObserved = false;
      function finish(receipt, captureHash = null, binding = false, structure = false) {
        if (done) return;
        // A member of the batch-owned group that outlives the wrapper root is
        // cleaned up first, within a bounded grace, so the recorded lifecycle
        // describes the settled state rather than the instant the root exited.
        if (grouped && !reason && !settling && ownedGroup() === "present") {
          settling = true; survivorObserved = true;
          clearTimeout(deadline);
          const stopSettling = Date.now() + CLEANUP_MS;
          const kill = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); forceAttempted = true; } catch {} }, 1500);
          const poll = setInterval(() => {
            if (ownedGroup() !== "present" || Date.now() >= stopSettling) { clearTimeout(kill); clearInterval(poll); finish(receipt, captureHash, binding, structure); }
          }, 25);
          return;
        }
        done = true;
        clearTimeout(deadline); clearTimeout(escalation); clearTimeout(hardDeadline);
        active.delete(cancel);
        const ended = performance.now();
        const transport = !reason && closed && rootExited && code === 0 && signal === null && binding &&
          structure && receipt.status === "ok" && receipt.complete === true && receipt.truncated === false;
        // Lifecycle evidence is reported apart from transport evidence.
        //   confirmed   the wrapper ended normally with a bound, structurally
        //               valid envelope, its root exit and pipe close were
        //               observed, the batch-owned group is gone, and on POSIX
        //               the wrapper reported its own CLI group absent (or
        //               reported no CLI group at all).
        //   unconfirmed anything else: a supervisor timeout or cancellation, a
        //               wrapper that died without a usable envelope, a group
        //               member that is still alive, or an unknown CLI group.
        // Such a shard is never followed by a new launch in this batch.
        const wrapperGroup = receipt.local_tree_cleanup ?? "not_reported";
        const group = ownedGroup();
        const normalEnd = !reason && rootExited && closed && binding && structure && [0, 1].includes(code);
        // A group member that outlived the wrapper root was observed; a later
        // kill does not turn that execution into a safe completion.
        const confirmed = normalEnd && !survivorObserved && (group === "absent" || group === "not_applicable") && (!grouped ||
          wrapperGroup === "posix_group_absent" || wrapperGroup === "not_reported" || wrapperGroup === "not_checked");
        resolve({ ...receipt, ...identity, request_state: rootExited && closed && !reason ? "LOCAL_TERMINAL" : "UNKNOWN",
          root_exit_observed: rootExited, pipe_close_observed: closed,
          owned_process_group: group, wrapper_cli_group: wrapperGroup, survivor_observed: survivorObserved,
          local_cleanup: confirmed ? "confirmed" : "unconfirmed",
          lifecycle_validation: confirmed ? "PASS" : "NOT_EVALUATED",
          lifecycle_scope: "observed root exit, pipe close and batch-owned group only; detached groups and the remote provider are outside this check",
          provider_remote_state: "UNKNOWN", binding_status: binding ? "VERIFIED_LOCAL" : "UNVERIFIED",
          structure_validation: structure ? "PASS" : "NOT_EVALUATED",
          transport_validation: transport ? "PASS" : "NOT_EVALUATED",
          wrapper_exit_code: code, wrapper_signal: signal, wrapper_exit_observed: rootExited,
          wrapper_close_observed: closed, wrapper_spawn_observed: spawned,
          supervisor_timeout_ms: supervisorSeconds * 1000, supervisor_cleanup_timeout_ms: CLEANUP_MS,
          supervisor_timeout_origin: reason === "supervisor_timeout" ? "supervisor" : reason === "batch_timeout" ? "batch" : reason ?? "none",
          supervisor_signal_sent: signalSent, supervisor_force_attempted: forceAttempted,
          local_wrapper_exit: rootExited ? "OBSERVED" : "UNKNOWN",
          supervisor_tree_cleanup: "UNKNOWN", stderr_present: stderrPresent, capture_truncated: overflow,
          captured_stdout_sha256: captureHash, raw_receipt_file: receipt.status === "ok" && captureHash && binding && structure ? j.label + ".raw.json" : null,
          queue_wait_ms: Math.max(0, Math.round(attemptStart - started)),
          supervisor_execution_ms: Math.max(0, Math.round((stopAt ?? ended) - attemptStart)),
          supervisor_cleanup_ms: stopAt === null ? 0 : Math.max(0, Math.round(ended - stopAt)),
          duration_seconds: (ended - attemptStart) / 1000 });
      }
      function cancel(why) {
        if (done || reason) return;
        reason = why; stopAt = performance.now();
        // On Windows Node's SIGTERM is not cooperative; use the private marker.
        try { writeOnce(j.cancelFile, "cancel\n"); } catch {}
        if (child && !rootExited && process.platform !== "win32") {
          try { signalSent = child.kill("SIGTERM"); } catch {}
        }
        escalation = setTimeout(() => {
          // A root that already exited does not end the cleanup: members of
          // the batch-owned group may still be alive, so escalate unless that
          // group is gone. On Windows the tree can only be walked while the
          // root is alive, so an exited root leaves the cleanup unconfirmed.
          if (!child) return;
          if (rootExited && (!grouped || ownedGroup() === "absent")) return;
          forceAttempted = true;
          if (process.platform === "win32") {
            try {
              const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
                { stdio: "ignore", shell: false, windowsHide: true });
              killer.on("error", () => {});
              const t = setTimeout(() => { try { killer.kill(); } catch {} }, 2000);
              t.unref(); killer.on("exit", () => clearTimeout(t)); killer.unref();
            } catch {}
          } else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
          }
        }, 5000);
        hardDeadline = setTimeout(() => {
          if (child) {
            if (!rootExited) { forceAttempted = true; try { child.kill("SIGKILL"); } catch {} }
            finish(stoppedReceipt());
            child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          } else finish(stoppedReceipt());
        }, CLEANUP_MS);
      }
      active.add(cancel);
      try {
        child = spawn(process.execPath, [wrapper, "--prompt-file", j.file, ...j.effectiveArgs],
          { stdio: ["ignore", "pipe", "pipe"], env, shell: false, windowsHide: true, detached: process.platform !== "win32" });
      } catch { finish(errorReceipt("child_error", "could not spawn wrapper")); return; }
      child.on("spawn", () => { spawned = true; });
      child.on("exit", (c, s) => { rootExited = true; code = c; signal = s; });
      child.stdout.on("data", chunk => {
        if (done || reason) return;
        const n = Math.min(chunk.length, CAP - bytes);
        if (n > 0) { chunks.push(chunk.subarray(0, n)); bytes += n; }
        if (n < chunk.length) { overflow = true; cancel("output_limit"); }
      });
      child.stderr.on("data", chunk => { if (chunk.length) stderrPresent = true; });
      child.on("error", () => { if (!spawned) finish(errorReceipt("child_error", "wrapper spawn failed")); });
      child.on("close", (c, s) => {
        if (done) return;
        closed = true; code = c; signal = s;
        if (c !== null || s !== null) rootExited = true;
        if (reason) {
          // Keep the bounded cleanup running while owned-group members are
          // still alive; the escalation and hard deadline settle it.
          if (grouped && ownedGroup() === "present") return;
          finish(stoppedReceipt());
          return;
        }
        const raw = Buffer.concat(chunks); chunks = [];
        const digest = hash(raw);
        if (!raw.length) { finish(errorReceipt("child_error", "wrapper produced no stdout envelope"), digest); return; }
        let receipt;
        try { receipt = parseReceipt(new TextDecoder("utf-8", { fatal: true }).decode(raw).trim()); }
        catch { finish(errorReceipt("child_error", "wrapper stdout was not valid JSON"), digest); return; }
        if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || typeof receipt.status !== "string") {
          finish(errorReceipt("child_error", "wrapper envelope is not a JSON object with a status"), digest); return;
        }
        const binding = receipt.batch_attempt_id === j.attemptId && receipt.batch_material_sha256 === j.digest &&
          (receipt.batch_config_sha256 ?? "") === expectedConfig;
        const validCompletion = (receipt.complete === true && receipt.truncated === false) ||
          (receipt.complete === false && receipt.truncated === true);
        // PR #11: actual exit + explicit completeness; legitimate zero-exit
        // truncated replies remain incomplete, never a transport PASS.
        if (signal !== null || !rootExited || ![0, 1].includes(code) ||
            (receipt.status === "ok" && (code !== 0 || receipt.exit_code !== 0 || !validCompletion ||
              receipt.cli_invoked !== true || typeof receipt.text !== "string" || !receipt.text.trim() ||
              typeof receipt.model !== "string" || !receipt.model.trim() || !binding))) {
          finish(errorReceipt("child_error", "wrapper exit, binding or required receipt fields did not agree"), digest, binding); return;
        }
        if (side === "mmx" && receipt.status === "ok" && (receipt.observed_exit_code !== 0 ||
            receipt.observed_signal !== null || receipt.local_process_exit_observed !== true)) {
          finish(errorReceipt("child_error", "MMX CLI observed outcome contradicted successful receipt"), digest, binding); return;
        }
        if (side === "zcode" && receipt.status === "ok" && receipt.signal !== null) {
          finish(errorReceipt("child_error", "CLI signal contradicted successful receipt"), digest, binding); return;
        }
        if (receipt.status === "ok") {
          // Save the exact captured success/partial reply before the separate
          // process evidence record. Invalid or error stdout is never copied.
          try { ensureArchive(); writeOnce(path.join(archive.dir, j.label + ".raw.json"), raw); }
          catch (err) {
            failed = archiveErrorCode(err);
            finish(errorReceipt("child_error", "raw receipt archive write failed"), digest, binding);
            stop("archive_error");
            return;
          }
        }
        finish(receipt, digest, binding, true);
      });
      deadline = setTimeout(() => cancel("supervisor_timeout"), supervisorSeconds * 1000);
      if (stopping) cancel(stopping);
    });
  }
  async function run(wrapper) {
    let next = 0;
    batchTimer = setTimeout(() => stop("batch_timeout"), batchSeconds * 1000);
    async function worker() {
      while (!stopping && !failed && !halting) {
        const i = next++;
        if (i >= jobs.length) return;
        try { results[i] = await runAttempt(jobs[i], wrapper); ensureArchive(); saveShardReceipt(archive, i, results[i]); }
        catch (err) { failed = archiveErrorCode(err); stop("archive_error"); }
        // A shard whose local cleanup is unconfirmed is not followed by a
        // new launch. Shards already in flight are left alone and nothing is
        // replayed; shards never started are reported as such.
        if (results[i]?.local_cleanup === "unconfirmed") halting = "cleanup_unconfirmed";
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker)); }
    finally { clearTimeout(batchTimer); }
    for (const j of jobs) if (!results[j.i]) results[j.i] = { ...prefix(j), status: "not_started",
      request_state: j.intentWritten ? "UNKNOWN" : "NOT_STARTED",
      transport_validation: "NOT_EVALUATED",
      ...(halting ? { not_started_reason: halting, lifecycle_validation: "NOT_EVALUATED" } : {}) };
    if (halting) halted = halting;
    return results;
  }
  function finalize(envelope) {
    envelope.receipt_file = archive.file;
    envelope.batch_id = batchId;
    Object.assign(envelope.batch, { supervisor_timeout_ms: supervisorSeconds * 1000, batch_timeout_ms: batchSeconds * 1000,
      cleanup_timeout_ms: CLEANUP_MS, paid_retry_authorized: false, provider_internal_retry: "NOT_EVALUATED", halted });
    if (stopping) {
      envelope.status = stopping === "cancelled" ? "cancelled" : stopping === "batch_timeout" ? "timeout" : "archive_error";
      envelope.transport_gate = "NOT_EVALUATED";
      if (envelope.gate !== "FAIL") envelope.gate = "NOT_EVALUATED";
      envelope.note = "Completed shard receipts retained; uncertain requests must not be replayed.";
    }
    if (halting) {
      envelope.note = "A shard ended with unconfirmed local cleanup; later shards were not started and nothing was replayed.";
    }
    if (failed) { envelope.status = "archive_error"; envelope.archive_error = failed;
      envelope.transport_gate = "NOT_EVALUATED"; if (envelope.gate !== "FAIL") envelope.gate = "NOT_EVALUATED"; }
    try { ensureArchive(); finishArchive(archive, envelope); }
    catch (err) {
      try { fs.closeSync(archive.fd); } catch {}
      envelope.status = "archive_error"; envelope.archive_error = archiveErrorCode(err);
      envelope.transport_gate = "NOT_EVALUATED"; if (envelope.gate !== "FAIL") envelope.gate = "NOT_EVALUATED";
    }
    return envelope;
  }
  return { run, stop, finalize, get halted() { return halted; } };
}
module.exports = { createBatch, limitSeconds, sourceBytes, resolveWrapper };
