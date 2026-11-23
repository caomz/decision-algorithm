"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { strictJson } = require("../../zcode/scripts/review.js");
const { buildCoveragePlan, writePlan, verifyPlan, evaluateCoverage, MAX_SHARDS } = require("./shard-coverage.js");
const { buildRunPacket, packetFrom, verifyRun, LIMITS } = require("./review-run.js");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const encoded = value => Buffer.from(JSON.stringify(value) + "\n", "utf8");
const save = (file, bytes) => fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
const mkdir = dir => fs.mkdirSync(dir, { mode: 0o700 });
const runnerFile = path.join(__dirname, "review-run.js");
const fields = ["constraints", "assumptions", "uncovered"];

function read(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("expected a regular archive file: " + path.basename(file));
  return fs.readFileSync(file);
}
function json(file) { return strictJson(read(file).toString("utf8")); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function realDir(dir) {
  assert(fs.lstatSync(dir).isDirectory(), "expected a non-linked directory: " + path.basename(dir));
  return fs.realpathSync(dir);
}
function codeHash() {
  return { sharding: hash(read(__filename)), coverage: hash(read(require.resolve("./shard-coverage.js"))) };
}

// The canonical material is pretty-printed JSON. Embedded newlines inside any
// source string are escaped. Latin-1 gives these structural matches byte offsets.
function sourceRows(materialBytes) {
  const pattern = /^    \{\n      "id": "([A-Za-z0-9_.-]+)",\n      "text": .*\n    \}/gm;
  return Array.from(materialBytes.toString("latin1").matchAll(pattern),
    m => ({ id: m[1], start: m.index, end: m.index + m[0].length }));
}
function coverageLine(shard, plan) {
  return "Shard coverage " + shard.id + ": " + plan.acceptance_ids.join(", ");
}
function makePacket(source, plan, segment, materialBytes, rows, roundId) {
  const part = materialBytes.subarray(segment.start_byte, segment.end_byte).toString("utf8");
  const ids = rows.filter(row => row.start < segment.end_byte && segment.start_byte < row.end).map(row => row.id);
  const scopeInstruction = source.goal?.acceptance_scope === "per_shard"
    ? "The packet author declares that every acceptance criterion is independently decidable on each shard. "
    : "The packet requests whole-document acceptance. Report only locally supported findings; completion of this excerpt cannot establish the whole-document verdict. ";
  const instruction = scopeInstruction + "Review the exact UTF-8 excerpt below with the repeated goal and context. " +
    "It may begin or end inside an evidence item. A missing item outside this excerpt is not evidence of absence. " +
    "Do not certify a cross-excerpt comparison, dependency, or claim whose necessary evidence is unavailable. " +
    "If such a gap blocks an acceptance criterion, return a P1 evidence_gap. " +
    "Only when ALL supplied acceptance criteria can be evaluated for this excerpt and it satisfies them, " +
    "end the standard first summary line with '; Not checkable: none.' and add this exact standalone line: " +
    coverageLine(segment, plan);
  const metadata = { round_id: roundId, shard: segment.id, shards: plan.shards.length, start_byte: segment.start_byte,
    end_byte: segment.end_byte, sha256: segment.sha256, material_sha256: plan.material_sha256, source_ids: ids };
  const packet = { facts: [{ id: segment.id, text: "Fragment metadata " + JSON.stringify(metadata) + "\n\n" + part }] };
  for (const key of fields) if (source[key]) packet[key] = [...source[key]];
  packet.constraints = [...(packet.constraints || []), instruction];
  if (source.goal) packet.goal = source.goal;
  return encoded(packet);
}

function prepareShardedReview(packetBytes, { maxShards = 1, roundId = "0".repeat(32) } = {}) {
  assert(typeof roundId === "string" && /^[a-f0-9]{32}$/.test(roundId), "invalid shard review round ID");
  assert(Number.isSafeInteger(maxShards) && maxShards >= 1 && maxShards <= MAX_SHARDS, "invalid maximum shard count");
  const limit = LIMITS.realAttachmentMaxBytes;
  // Start with the largest possible payload, then find the largest tested
  // fragment size that fits actual rendering (including JSON escaping).
  let low = 1024, high = limit;
  const first = buildCoveragePlan(packetBytes, { chunkBytes: high });
  const source = packetFrom(packetBytes.toString("utf8"));
  const rows = sourceRows(first.materialBytes);
  let best;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    let candidate;
    try { candidate = buildCoveragePlan(packetBytes, { chunkBytes: size }); }
    catch (error) {
      if (!String(error.message).includes("more than 32 shards")) throw error;
      low = size + 1;
      continue;
    }
    const { plan, materialBytes } = candidate;
    if (plan.shards.length > maxShards) {
      low = size + 1;
      continue;
    }
    const packets = plan.shards.map(shard => makePacket(source, plan, shard, materialBytes, rows, roundId));
    const promptBytes = packets.map(packet => Buffer.byteLength(buildRunPacket(packet).prompt));
    if (promptBytes.every(bytes => bytes <= limit)) {
      best = { plan, packets, promptBytes, roundId, shardCount: plan.shards.length, shardBytes: size,
        acceptanceScope: source.goal?.acceptance_scope ?? "whole_document" };
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  assert(best, "the complete goal, context and fragments cannot fit the 24 KiB limit within the authorized --max-shards budget");
  return best;
}

function checkBudget(timeoutSeconds, maxTokens) {
  assert(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= LIMITS.timeoutMin &&
    timeoutSeconds <= LIMITS.timeoutMax, "invalid shard timeout");
  assert(Number.isSafeInteger(maxTokens) && maxTokens >= 1 &&
    maxTokens <= LIMITS.defaultMaxTokens, "invalid per-request output-token budget");
}
function requestRecord(prepared, maxShards, timeoutSeconds, maxTokens, nativeEntries) {
  const { plan, shardCount } = prepared;
  assert(["zcode", "mmx"].every(side => /^[a-f0-9]{64}$/.test(nativeEntries?.[side])), "missing native entry fingerprints");
  return { format: 1, backend: "real", sharded: true, round_id: prepared.roundId, packet_sha256: plan.packet_sha256,
    native_entries: nativeEntries,
    max_shards: maxShards, shard_count: shardCount, max_requests: 2 * shardCount,
    max_total_output_tokens: 2 * shardCount * maxTokens,
    // Includes the longest supported slot and cleanup grace periods.
    max_wall_seconds: shardCount * (timeoutSeconds + 180 + 20),
    timeout_seconds: timeoutSeconds, max_tokens: maxTokens, code: codeHash() };
}
function childBudgetMatches(request, parent) {
  return request.backend === "real" && request.timeout_seconds === parent.timeout_seconds &&
    request.max_tokens === parent.max_tokens && isDeepStrictEqual(request.native_entries, parent.native_entries);
}

function inspectPart(dir, expected, shard, plan, parent) {
  realDir(dir);
  assert(read(path.join(dir, "packet.json")).equals(expected), shard.id + ": wrong authorized packet");
  const dispatch = json(path.join(dir, "dispatch.json"));
  assert(dispatch.shard === shard.id && dispatch.packet_sha256 === hash(expected), shard.id + ": dispatch does not match");
  const exit = json(path.join(dir, "exit.json"));
  const run = path.join(dir, "run");
  const basic = { id: shard.id, sha256: shard.sha256, exit, providers: {}, round_status: "NOT_EVALUATED",
    review_gate: "NOT_EVALUATED", attestations: {} };
  if (fs.existsSync(run)) realDir(run);
  if (!fs.existsSync(path.join(run, "record-manifest.json"))) {
    assert(exit.code === 2 || exit.signal || exit.spawn_error, shard.id + ": missing completed child archive");
    return { ...basic, state: "incomplete" };
  }
  assert(read(path.join(run, "packet.json")).equals(expected), shard.id + ": substituted child packet");
  const verified = verifyRun(run);
  assert(verified.exit_code === 0 && verified.replay === "match" && verified.backend === "real",
    shard.id + ": child archive did not replay with the real backend");
  assert(childBudgetMatches(json(path.join(run, "request.json")), parent), shard.id + ": child budget mismatch");
  const result = json(path.join(run, "result.json"));
  assert(exit.code === result.exit_code && exit.signal === null && !exit.spawn_error, shard.id + ": child process exit mismatch");
  const attestations = {};
  for (const side of ["zcode", "mmx"]) {
    const summary = result.providers[side].review?.summary ?? "";
    const lines = summary.split(/\r?\n/);
    attestations[side] = /^Checked: .+; Not checkable: none\.$/.test(lines[0].trim()) &&
      lines.slice(1).some(line => line.trim() === coverageLine(shard, plan));
  }
  return { ...basic, state: "verified", providers: result.providers, attestations,
    round_status: result.round_status, review_gate: result.review_gate, child_cancelled: result.cancelled === true };
}
function aggregate(prepared, parts, stop) {
  const { plan } = prepared;
  const records = parts.map(part => {
    const providers = {};
    for (const [side, vote] of Object.entries(part.providers)) {
      providers[side] = vote.gate === "PASS" && !part.attestations[side] ? { ...vote, gate: "NOT_EVALUATED" } : vote;
    }
    return { shard_id: part.id, shard_sha256: part.sha256, providers };
  });
  const cancelled = stop.cancelled || parts.some(part => part.child_cancelled);
  const coverage = evaluateCoverage(plan, records, { cancelled });
  const complete = !cancelled && parts.length === plan.shards.length &&
    parts.every(part => part.round_status === "COMPLETED");
  // Only the packet author can declare that applying each criterion to all
  // excerpts proves the same criterion for the complete document.
  if (coverage.review_gate === "PASS" && prepared.acceptanceScope !== "per_shard") {
    coverage.review_gate = "NOT_EVALUATED";
    coverage.exit_code = 2;
  }
  return { format: 1, backend: "real", sharded: true, shard_count: plan.shards.length,
    acceptance_scope: prepared.acceptanceScope, delivery_complete: complete,
    round_status: complete ? "COMPLETED" : "NOT_EVALUATED", review_gate: coverage.review_gate,
    exit_code: coverage.exit_code, cancelled, coverage, shards: parts,
    note: prepared.acceptanceScope === "per_shard"
      ? "The packet declares shard-local acceptance; PASS requires complete verified coverage for each criterion."
      : "Whole-document acceptance requires a full-document review. Shard results and complete delivery are recorded independently." };
}

function replay(dir) {
  dir = realDir(dir);
  const coverageDir = realDir(path.join(dir, "coverage"));
  assert(verifyPlan(coverageDir).integrity === "match", "coverage plan or source material is corrupt");
  const request = json(path.join(dir, "sharded-request.json"));
  checkBudget(request.timeout_seconds, request.max_tokens);
  const packetBytes = read(path.join(coverageDir, "packet.json"));
  assert(typeof request.round_id === "string", "missing shard review round ID");
  const prepared = prepareShardedReview(packetBytes, { maxShards: request.max_shards, roundId: request.round_id });
  assert(isDeepStrictEqual(prepared.plan, json(path.join(coverageDir, "coverage-plan.json"))), "coverage plan differs from the authorized partition");
  const expectedRequest = requestRecord(prepared, request.max_shards, request.timeout_seconds, request.max_tokens, request.native_entries);
  assert(isDeepStrictEqual(request, expectedRequest), "request differs from the packet, budget or sharding code");
  const runs = realDir(path.join(dir, "parts"));
  const names = fs.readdirSync(runs).sort();
  assert(isDeepStrictEqual(names, prepared.plan.shards.slice(0, names.length).map(shard => shard.id)), "unexpected, duplicated or out-of-sequence shard");
  const parts = names.map((id, i) => inspectPart(path.join(runs, id), prepared.packets[i], prepared.plan.shards[i], prepared.plan, request));
  const stop = json(path.join(dir, "round-end.json"));
  assert(typeof stop.cancelled === "boolean" && stop.dispatched === names.length, "invalid round termination record");
  assert(stop.cancelled || names.length === prepared.shardCount ||
    (parts.length && parts[parts.length - 1].round_status !== "COMPLETED"), "missing shards after a completed child");
  return aggregate(prepared, parts, stop);
}

function topDigests(dir, result) {
  const files = ["sharded-request.json", "round-end.json", "result.json", "coverage/coverage-plan.json"];
  for (const part of result.shards) {
    const prefix = "parts/" + part.id + "/";
    for (const name of ["dispatch.json", "exit.json", "packet.json"]) files.push(prefix + name);
    if (part.state === "verified") files.push(prefix + "run/record-manifest.json");
  }
  return Object.fromEntries(files.map(name => [name, hash(read(path.join(dir, name)))]));
}
function verifyShardedReview(dir) {
  try {
    const replayed = replay(dir);
    const saved = json(path.join(dir, "result.json"));
    const manifest = json(path.join(dir, "record-manifest.json"));
    assert(isDeepStrictEqual(manifest, { format: 3, backend: "real", sharded: true, files: topDigests(dir, replayed) }),
      "sharded manifest or record digest mismatch");
    assert(isDeepStrictEqual(saved, replayed), "sharded verdict differs from verified children");
    return { integrity: "ok", replay: "match", exit_code: 0, backend: "real", sharded: true,
      replayed: { round_status: replayed.round_status, review_gate: replayed.review_gate, cancelled: replayed.cancelled } };
  } catch (error) {
    return { integrity: "corrupt", replay: null, exit_code: 2, problems: [error.message] };
  }
}

// Signal a cooperative child runner, which owns both native wrappers. If it
// cannot reach a terminal state, retain the attempt as unknown. Never restart.
function executeChild(dir, options, onSpawn) {
  const args = [runnerFile, "run", "--backend", "real", "--packet", path.join(dir, "packet.json"),
    "--out", path.join(dir, "run"), "--timeout-seconds", String(options.timeoutSeconds),
    "--max-tokens", String(options.maxTokens)];
  if (options.mmxBinDir) args.push("--mmx-bin-dir", options.mmxBinDir);
  return new Promise((resolve, reject) => {
    const stderr = fs.openSync(path.join(dir, "runner.stderr"), "wx", 0o600);
    let child;
    try {
      child = spawn(process.execPath, args, { detached: process.platform !== "win32",
        shell: false, stdio: ["ignore", "ignore", stderr] });
    } catch (error) {
      reject(error);
      return;
    } finally { fs.closeSync(stderr); }
    let spawnError = null;
    child.once("error", error => { spawnError = error.code ?? error.message; });
    child.once("close", (code, signal) => resolve({ code, signal, spawn_error: spawnError }));
    onSpawn(child);
  });
}
async function runShardedReview({ packetBytes, out, maxShards = 1, timeoutSeconds = LIMITS.defaultTimeout,
  maxTokens = LIMITS.defaultMaxTokens, mmxBinDir, nativeEntries }) {
  checkBudget(timeoutSeconds, maxTokens);
  const prepared = prepareShardedReview(packetBytes, { maxShards, roundId: randomBytes(16).toString("hex") });
  const request = requestRecord(prepared, maxShards, timeoutSeconds, maxTokens, nativeEntries);
  out = path.resolve(out);
  mkdir(out);
  save(path.join(out, "sharded-request.json"), encoded(request));
  writePlan(packetBytes, path.join(out, "coverage"), { chunkBytes: prepared.shardBytes });
  const root = path.join(out, "parts");
  mkdir(root);
  let active, cancelled = false, dispatched = 0, force;
  const cancel = () => {
    cancelled = true;
    if (!active || active.exitCode !== null || active.signalCode !== null || force) return;
    const target = active;
    target.kill("SIGTERM");
    force = setTimeout(() => {
      try {
        if (process.platform === "win32") target.kill("SIGKILL");
        else process.kill(-target.pid, "SIGKILL");
      } catch (error) { if (error.code !== "ESRCH") process.stderr.write("child cleanup could not be confirmed\n"); }
    }, 20000);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, cancel);
  const deadline = setTimeout(cancel, request.max_wall_seconds * 1000);
  try {
    for (const shard of prepared.plan.shards) {
      await new Promise(resolve => setImmediate(resolve));
      if (cancelled) break;
      const dir = path.join(root, shard.id);
      mkdir(dir);
      const packet = prepared.packets[shard.index - 1];
      save(path.join(dir, "packet.json"), packet);
      save(path.join(dir, "dispatch.json"), encoded({ shard: shard.id, packet_sha256: hash(packet) }));
      dispatched++;
      const exit = await executeChild(dir, { timeoutSeconds, maxTokens, mmxBinDir }, child => { active = child; });
      active = null;
      clearTimeout(force);
      force = null;
      save(path.join(dir, "exit.json"), encoded(exit));
      const part = inspectPart(dir, packet, shard, prepared.plan, request);
      if (cancelled || part.round_status !== "COMPLETED") break;
    }
    save(path.join(out, "round-end.json"), encoded({ dispatched, cancelled }));
    const result = replay(out);
    save(path.join(out, "result.json"), encoded(result));
    save(path.join(out, "record-manifest.json"), encoded({ format: 3, backend: "real", sharded: true, files: topDigests(out, result) }));
    return result;
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    for (const signal of signals) process.removeListener(signal, cancel);
  }
}

module.exports = { prepareShardedReview, runShardedReview, verifyShardedReview };
