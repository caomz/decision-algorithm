#!/usr/bin/env node
"use strict";

// Deterministic, offline audit-material sharding and a fail-closed coverage
// reducer. It does NOT itself call providers or certify a model's reasoning.
// Stage 5 must feed the reducer only sides already checked by evaluateSide()
// against their exact observed shard input; untrusted self-reported booleans
// are not acceptable evidence of delivery.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { strictJson, validateIds } = require("../../zcode/scripts/review.js");
const runner = require("./review-run.js");

const FORMAT = 1;
const DEFAULT_SHARD_BYTES = 16384;
const MIN_SHARD_BYTES = 1024;
const MAX_SHARD_BYTES = 24576;
const MAX_SHARDS = 32;
const MAX_PACKET_BYTES = 512 * 1024;
const MAX_MATERIAL_BYTES = 512 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");

function usage(message) {
  throw Object.assign(new Error(message), { usage: true });
}
function regularBytes(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("archive entry is not a regular file");
  return fs.readFileSync(file);
}
function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function validateShardBytes(size) {
  if (!Number.isSafeInteger(size) || size < MIN_SHARD_BYTES || size > MAX_SHARD_BYTES) {
    usage("shard bytes must be an integer between " + MIN_SHARD_BYTES + " and " + MAX_SHARD_BYTES);
  }
  return size;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// The reducer can validate structure, not the source material's provenance.
// In particular, an absent AC matrix, overlapping offsets, or duplicate IDs
// must never turn an otherwise complete set of receipts into a PASS.
function validatePlan(plan) {
  const invalid = () => { throw new Error("invalid coverage plan"); };
  const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!exactKeys(plan, ["format", "packet_sha256", "material_sha256", "material_bytes",
    "shard_bytes", "required_evidence_ids", "acceptance_ids", "requirements", "shards"]) ||
      plan.format !== FORMAT || !digest(plan.packet_sha256) || !digest(plan.material_sha256) ||
      !Number.isSafeInteger(plan.material_bytes) || plan.material_bytes < 1 ||
      plan.material_bytes > MAX_MATERIAL_BYTES || !Array.isArray(plan.shards) ||
      plan.shards.length < 1 || plan.shards.length > MAX_SHARDS ||
      !Array.isArray(plan.acceptance_ids) || !Array.isArray(plan.requirements)) invalid();
  try {
    validateShardBytes(plan.shard_bytes);
    if (!Array.isArray(plan.required_evidence_ids)) invalid();
    validateIds(Array.from(plan.required_evidence_ids));
  }
  catch { invalid(); }
  if (Array.from(plan.acceptance_ids).some((id, i) => id !== "AC-" + (i + 1) ||
      !plan.required_evidence_ids.includes(id))) invalid();
  if (plan.acceptance_ids.length) {
    // A v2 packet reserves AC-* for the declared acceptance conditions. Do
    // not let a caller omit the last condition and its matrix row while its
    // evidence ID still exists. Legacy v1 fact IDs may use this prefix, but
    // plans with no acceptance conditions can never receive PASS anyway.
    const evidenceAcceptance = plan.required_evidence_ids.filter(id => id.startsWith("AC-"));
    if (evidenceAcceptance.length !== plan.acceptance_ids.length ||
        evidenceAcceptance.some((id, i) => id !== plan.acceptance_ids[i])) invalid();
  }

  let next = 0;
  for (const [i, shard] of plan.shards.entries()) {
    const suffix = String(i + 1).padStart(4, "0");
    if (!exactKeys(shard, ["id", "file", "index", "start_byte", "end_byte", "bytes", "sha256"]) ||
        shard.id !== "S-" + suffix || shard.file !== "shard-" + suffix + ".txt" ||
        shard.index !== i + 1 || shard.start_byte !== next || !digest(shard.sha256) ||
        !Number.isSafeInteger(shard.bytes) || shard.bytes < 1 || shard.bytes > plan.shard_bytes ||
        !Number.isSafeInteger(shard.end_byte) || shard.end_byte !== next + shard.bytes ||
        (i < plan.shards.length - 1 && shard.bytes < plan.shard_bytes - 3)) invalid();
    next = shard.end_byte;
  }
  if (next !== plan.material_bytes) invalid();
  const requirementIds = plan.acceptance_ids.length ? plan.acceptance_ids : ["MATERIAL"];
  if (plan.requirements.length !== requirementIds.length) invalid();
  for (const [i, requirement] of plan.requirements.entries()) {
    if (!exactKeys(requirement, ["id", "required_shards"]) || requirement.id !== requirementIds[i] ||
        !Array.isArray(requirement.required_shards) ||
        requirement.required_shards.length !== plan.shards.length ||
        Array.from(requirement.required_shards).some((id, j) => id !== plan.shards[j].id)) invalid();
  }
}

// Byte offsets are defined on UTF-8, not JavaScript UTF-16 code units.
// Never split a multibyte character, truncate evidence, or silently drop a
// final shard. The original canonical material is reassembled exactly.
function splitUtf8(materialBytes, chunkBytes) {
  const chunks = [];
  let start = 0;
  while (start < materialBytes.length) {
    let end = Math.min(start + chunkBytes, materialBytes.length);
    if (end < materialBytes.length) {
      while (end > start && (materialBytes[end] & 0xc0) === 0x80) end--;
    }
    if (end <= start) throw new Error("cannot find a UTF-8 shard boundary");
    const bytes = materialBytes.subarray(start, end);
    decodeUtf8(bytes);
    const index = chunks.length + 1;
    chunks.push({
      id: "S-" + String(index).padStart(4, "0"),
      file: "shard-" + String(index).padStart(4, "0") + ".txt",
      index,
      start_byte: start,
      end_byte: end,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    if (chunks.length > MAX_SHARDS) usage("material requires more than 32 shards; split into independent audit packets");
    start = end;
  }
  return chunks;
}

function buildCoveragePlan(rawPacketBytes, { chunkBytes = DEFAULT_SHARD_BYTES } = {}) {
  validateShardBytes(chunkBytes);
  if (!Buffer.isBuffer(rawPacketBytes) || rawPacketBytes.length === 0 || rawPacketBytes.length > MAX_PACKET_BYTES) {
    usage("packet must be nonempty bytes within the 512 KiB offline planning limit");
  }
  const packet = runner.packetFrom(decodeUtf8(rawPacketBytes));
  if (packet.changes !== undefined) runner.verifyChanges(packet.changes);
  const material = runner.materialFrom(packet, { skipLimits: true });
  const materialBytes = Buffer.from(material, "utf8");
  if (!materialBytes.length || materialBytes.length > MAX_MATERIAL_BYTES) {
    usage("material exceeds the 512 KiB offline planning limit");
  }
  const ids = runner.evidenceIdsFrom(packet);
  const acceptance = packet.goal?.acceptance?.map((_, i) => "AC-" + (i + 1)) ?? [];
  const shards = splitUtf8(materialBytes, chunkBytes);
  const required = shards.map(shard => shard.id);
  // Each acceptance condition requires BOTH independent reviewers to receive
  // every part of the canonical material. A missing shard blocks the entire
  // condition, even when the model's summary says "Checked: all".
  const requirements = (acceptance.length ? acceptance : ["MATERIAL"]).map(id => ({
    id, required_shards: [...required],
  }));
  const plan = {
    format: FORMAT,
    packet_sha256: hash(rawPacketBytes),
    material_sha256: hash(materialBytes),
    material_bytes: materialBytes.length,
    shard_bytes: chunkBytes,
    required_evidence_ids: ids,
    acceptance_ids: acceptance,
    requirements,
    shards,
  };
  return { plan, materialBytes };
}

function writePlan(rawPacketBytes, output, options) {
  const { plan, materialBytes } = buildCoveragePlan(rawPacketBytes, options);
  const dir = path.resolve(output);
  // Never overwrite an existing archive, even if only partially initialized.
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(dir, "shards"), { mode: 0o700 });
  const save = (file, bytes) => fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  save(path.join(dir, "packet.json"), rawPacketBytes);
  save(path.join(dir, "material.txt"), materialBytes);
  for (const shard of plan.shards) {
    save(path.join(dir, "shards", shard.file),
      materialBytes.subarray(shard.start_byte, shard.end_byte));
  }
  save(path.join(dir, "coverage-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return { status: "planned", directory: dir, material_sha256: plan.material_sha256,
    shards: plan.shards.length, acceptance_conditions: plan.acceptance_ids.length };
}

function verifyPlan(directory, { replay = true } = {}) {
  try {
    const requestedDir = path.resolve(directory);
    if (!fs.lstatSync(requestedDir).isDirectory()) throw new Error("archive is not a directory");
    // Canonicalize legitimate parent aliases (e.g. macOS /tmp), then require
    // the archive's own directories to be real directories, not symlinks or
    // Windows junctions redirecting verification outside this archive.
    const dir = fs.realpathSync(requestedDir);
    const shardDir = path.join(dir, "shards");
    if (!fs.lstatSync(shardDir).isDirectory() || fs.realpathSync(shardDir) !== shardDir) {
      throw new Error("shards directory is redirected");
    }
    const plan = strictJson(decodeUtf8(regularBytes(path.join(dir, "coverage-plan.json"))));
    validatePlan(plan);
    const packet = regularBytes(path.join(dir, "packet.json"));
    const material = regularBytes(path.join(dir, "material.txt"));
    if (hash(packet) !== plan.packet_sha256 || hash(material) !== plan.material_sha256) throw new Error("source digest differs");
    if (replay) {
      const expected = buildCoveragePlan(packet, { chunkBytes: plan.shard_bytes });
      if (JSON.stringify(plan) !== JSON.stringify(expected.plan)) throw new Error("plan differs from packet");
      if (!material.equals(expected.materialBytes)) throw new Error("material differs from packet");
    }
    const names = fs.readdirSync(path.join(dir, "shards")).sort();
    const planned = plan.shards.map(s => s.file).sort();
    if (JSON.stringify(names) !== JSON.stringify(planned)) throw new Error("missing or unexpected shards");
    const actualParts = [];
    for (const shard of plan.shards) {
      const bytes = regularBytes(path.join(dir, "shards", shard.file));
      if (bytes.length !== shard.bytes || hash(bytes) !== shard.sha256) throw new Error("shard digest differs");
      actualParts.push(bytes);
    }
    if (!Buffer.concat(actualParts).equals(material)) throw new Error("shard reassembly differs");
    return { integrity: "match", shards: plan.shards.length,
      acceptance_conditions: plan.acceptance_ids.length, material_sha256: plan.material_sha256 };
  } catch {
    return { integrity: "corrupt", note: "Shard plan and inputs are incomplete or inconsistent; do not audit or declare PASS." };
  }
}

// Input records are trusted only after the calling executor has independently
// verified the wrapper exit, model identity, review-v1, and exact prompt binding.
// This is a pure reducer for that *already-verified* execution data, not a
// public "receipt says eligible" proof.
function evaluateCoverage(plan, records, { cancelled = false } = {}) {
  validatePlan(plan);
  if (!Array.isArray(records) || typeof cancelled !== "boolean") {
    throw new Error("invalid coverage execution records or cancellation state");
  }
  const byId = new Map(plan.shards.map(shard => [shard.id, shard]));
  const seen = new Map();
  const extras = [];
  let validFail = false;
  for (const record of records) {
    const shard = record && byId.get(record.shard_id);
    if (!shard || record.shard_sha256 !== shard.sha256) {
      extras.push(typeof record?.shard_id === "string" ? record.shard_id : "invalid");
      continue;
    }
    const z = record.providers?.zcode;
    const m = record.providers?.mmx;
    if (z?.eligible === true && z.material_bound === true &&
        z.model_family === "glm" && z.gate === "FAIL") validFail = true;
    if (m?.eligible === true && m.material_bound === true &&
        m.model_family === "minimax" && m.gate === "FAIL") validFail = true;
    if (seen.has(shard.id)) {
      extras.push(shard.id + ":duplicate");
      // Duplicates cannot be a source of PASS even if one copy looks valid.
      seen.set(shard.id, null);
    } else seen.set(shard.id, record);
  }
  const covered = new Set();
  const missing = [];
  for (const shard of plan.shards) {
    const row = seen.get(shard.id);
    const z = row?.providers?.zcode;
    const m = row?.providers?.mmx;
    const independent = z?.eligible === true && z.material_bound === true &&
      z.model_family === "glm" && m?.eligible === true && m.material_bound === true &&
      m.model_family === "minimax";
    if (independent && z.gate === "PASS" && m.gate === "PASS") covered.add(shard.id);
    else missing.push(shard.id);
  }
  const requirements = plan.requirements.map(requirement => ({
    id: requirement.id,
    required_shards: [...requirement.required_shards],
    covered_shards: requirement.required_shards.filter(id => covered.has(id)),
    missing_shards: requirement.required_shards.filter(id => !covered.has(id)),
  }));
  const allCovered = !cancelled && missing.length === 0 && extras.length === 0 &&
    plan.shards.length === records.length &&
    requirements.every(row => row.missing_shards.length === 0);
  // Match review-run's cancellation priority. Keep side evidence available to
  // the caller, but never issue a terminal audit verdict for a cancelled run.
  const gate = cancelled ? "NOT_EVALUATED" : validFail ? "FAIL" :
    (allCovered && plan.acceptance_ids.length > 0 ? "PASS" : "NOT_EVALUATED");
  return {
    review_gate: gate,
    exit_code: gate === "PASS" ? 0 : gate === "FAIL" ? 1 : 2,
    cancelled,
    coverage_complete: allCovered,
    required_shards: plan.shards.length,
    covered_shards: covered.size,
    missing_shards: missing,
    unexpected_or_duplicate_shards: extras,
    acceptance: requirements,
    note: "Structural delivery coverage only; a reviewer can still misunderstand a delivered shard.",
  };
}

function cli(argv) {
  const action = argv[0];
  if (action === "plan" && [5, 7].includes(argv.length) &&
      argv[1] === "--packet" && argv[3] === "--out" &&
      (argv.length === 5 || argv[5] === "--shard-bytes")) {
    const size = argv.length === 7 ? Number(argv[6]) : DEFAULT_SHARD_BYTES;
    return { result: writePlan(regularBytes(argv[2]), argv[4], { chunkBytes: size }), code: 0 };
  }
  if (action === "verify" && argv.length === 3 && argv[1] === "--run") {
    const report = verifyPlan(argv[2]);
    return { result: report, code: report.integrity === "match" ? 0 : 2 };
  }
  usage("usage: shard-coverage.js plan --packet FILE --out NEW_DIR [--shard-bytes 1024..24576] | verify --run DIR");
}

if (require.main === module) {
  try {
    const reply = cli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(reply.result) + "\n");
    process.exitCode = reply.code;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: "planning_error",
      note: error.usage ? String(error.message) : "Coverage plan could not be created or verified." }) + "\n");
    process.exitCode = 2;
  }
}
module.exports = { buildCoveragePlan, writePlan, verifyPlan, evaluateCoverage,
  DEFAULT_SHARD_BYTES, MAX_SHARDS, MAX_MATERIAL_BYTES };
