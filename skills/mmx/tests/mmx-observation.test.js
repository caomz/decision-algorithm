"use strict";
// Phase D: layered HTTP observation in the transport runner and the formal
// acceptance admission. Loopback only; no CLI is launched anywhere here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { observe, observation, summarize, MODEL_PATH } = require("../scripts/mmx-timeout-experiment.js");
const { checkAcceptance } = require("../scripts/acceptance-profile.js");
const { cleanEnv } = require("./support/env.js");

const scripts = path.resolve(__dirname, "../scripts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-observation-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, maxMs = 3000) {
  const stop = Date.now() + maxMs;
  while (Date.now() < stop) { if (predicate()) return; await pause(20); }
  throw new Error("observation deadline exceeded");
}
function server(respond) {
  const srv = http.createServer((req, res) => { req.on("data", () => {}); req.on("end", () => respond(req, res)); });
  const counters = observe(srv);
  return new Promise(resolve => srv.listen(0, "127.0.0.1", () => resolve({ srv, counters, port: srv.address().port })));
}
const close = srv => new Promise(resolve => { srv.closeAllConnections?.(); srv.close(resolve); });
const get = (port, url) => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port, path: url }, res => { res.resume(); res.on("end", resolve); });
  req.on("error", reject);
});

test("phase D: a complete model request is counted on every layer", async () => {
  const { srv, counters, port } = await server((req, res) => res.end("{}"));
  const body = JSON.stringify({ probe: "loopback" });
  await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: MODEL_PATH, method: "POST", headers: { "content-length": Buffer.byteLength(body) } }, res => { res.resume(); res.on("end", resolve); });
    req.on("error", reject); req.end(body);
  });
  await until(() => counters.complete_bodies === 1);
  assert.deepEqual(observation(counters), { connections: 1, request_heads: 1, complete_bodies: 1, aborted_bodies: 0, in_flight: 0,
    client_errors: 0, model_requests: 1, other_requests: 0, headless_connections: 0, observation: "complete", unknown_reasons: [] });
  await close(srv);
});

test("phase D: a request body aborted midway is unknown, not zero", async () => {
  const { srv, counters, port } = await server((req, res) => res.end("{}"));
  await new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`POST ${MODEL_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{"partial":`);
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on("error", () => {});
    setTimeout(resolve, 200);
  });
  await until(() => observation(counters).observation === "unknown");
  const result = observation(counters);
  assert.equal(result.model_requests, 0, "an aborted body cannot be counted as a completed retry probe");
  assert.equal(result.observation, "unknown");
  // The abort surfaces as an aborted request body on POSIX and as a client
  // error on Windows; either way the observation is unknown, not zero.
  const expected = process.platform === "win32" ? ["client_errors"] : ["aborted_request_bodies"];
  assert.ok(expected.some(reason => result.unknown_reasons.includes(reason)), JSON.stringify(result.unknown_reasons));
  await close(srv);
});

test("phase D: a connection that never sends a request head leaves the observation unknown", async () => {
  const { srv, counters, port } = await server((req, res) => res.end("{}"));
  await new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); setTimeout(resolve, 100); });
    socket.on("error", () => {});
  });
  await until(() => counters.connections === 1);
  const result = observation(counters);
  assert.equal(result.request_heads, 0);
  assert.equal(result.observation, "unknown");
  assert.deepEqual(result.unknown_reasons, ["connections_without_request_head"]);
  await close(srv);
});

test("phase D: a request to another endpoint is not model retry evidence", async () => {
  const { srv, counters, port } = await server((req, res) => res.end("{}"));
  await get(port, "/anthropic/v1/models");
  await get(port, MODEL_PATH);
  await get(port, MODEL_PATH);
  await until(() => counters.complete_bodies === 3);
  assert.equal(counters.model_requests, 2);
  assert.equal(counters.other_requests, 1, "a second request elsewhere has another purpose");
  assert.equal(observation(counters).observation, "complete");
  await close(srv);
});

async function reuseThenHeadless(port) {
  // Two requests over one keep-alive connection, then a connection that closes without a request head.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  for (let i = 0; i < 2; i++) await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: MODEL_PATH, agent }, res => { res.resume(); res.on("end", resolve); });
    req.on("error", reject);
  });
  agent.destroy();
  await new Promise(resolve => { const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); setTimeout(resolve, 100); }); socket.on("error", () => {}); });
}

test("V2.2.1 D5: a headless connection is seen beside a reused keep-alive connection", async () => {
  const { srv, counters, port } = await server((req, res) => res.end("{}"));
  try {
    await reuseThenHeadless(port);
    await until(() => observation(counters).observation === "unknown");
    const result = observation(counters);
    assert.equal(result.connections, 2);
    assert.equal(result.request_heads, 2);
    assert.equal(result.model_requests, 2);
    assert.ok(result.headless_connections >= 1, JSON.stringify(result));
    assert.ok(result.unknown_reasons.includes("connections_without_request_head"));
  } finally { await close(srv); }
});

test("V2.2.1 D5: verdicts use only complete requests to the model endpoint", () => {
  const counters = (heads, model, other) => ({ connections: heads, request_heads: heads, complete_bodies: heads, aborted_bodies: 0, in_flight: 0,
    client_errors: 0, model_requests: model, other_requests: other, headless_connections: 0 });
  const caseOf = (name, observed, extra = {}) => ({ case: name, requests: observed.request_heads, http_observation: { ...observed, observation: "complete" },
    local_process_exit_observed: true, capture_truncated: false, stop_reason: null, ...extra });
  const otherOnly = [caseOf("telemetry", counters(1, 0, 1))];
  assert.equal(summarize(otherOnly, "mmx-cli").real_mmx_transport, "NOT_EVALUATED", "a request elsewhere is not model transport");
  assert.deepEqual(summarize(otherOnly, "mmx-cli").provider_internal_retry.unobserved_cases, ["telemetry"]);
  const mixed = [caseOf("ok", counters(1, 1, 0)), caseOf("other", counters(1, 0, 1))];
  assert.equal(summarize(mixed, "mmx-cli").real_mmx_transport, "INCOMPLETE_LOCAL_ONLY");
  assert.deepEqual(summarize(mixed, "mmx-cli").provider_internal_retry.observed_cases, ["ok"]);
  const unknown = [caseOf("ok", counters(1, 1, 0)),
    caseOf("aborted", counters(1, 1, 0), { http_observation: { ...counters(1, 1, 0), aborted_bodies: 1, complete_bodies: 0, observation: "unknown", unknown_reasons: ["aborted_request_bodies"] } })];
  assert.equal(summarize(unknown, "mmx-cli").provider_internal_retry.status, "INCOMPLETE_NOT_EVALUATED", "an unknown case cannot be verified");
  const clean = [caseOf("a", counters(1, 1, 0)), caseOf("b", counters(1, 1, 0))];
  assert.equal(summarize(clean, "mmx-cli").provider_internal_retry.status, "OBSERVED_LOCAL_SCENARIOS");
  assert.equal(summarize(clean, "node-fetch").provider_internal_retry, "NOT_EVALUATED");
});

// ---------------------------------------------------------------------------
// Formal acceptance admission.
// ---------------------------------------------------------------------------
const acceptance = path.join(scripts, "acceptance-profile.js");
const example = path.resolve(__dirname, "../acceptance-profile.example.json");

test("phase D: the shipped acceptance config refuses and launches nothing", () => {
  const run = spawnSync(process.execPath, [acceptance, "--config", example, "--dry-run"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(run.status, 2);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, "refused");
  assert.equal(report.launched, false);
  assert.ok(report.problems.includes("config is not approved"));
  for (const field of ["node.version", "cli.package", "cli.version", "cli.entry_sha256", "undici.version"]) {
    assert.ok(report.problems.includes(`${field} is missing`));
  }
});

test("phase D: acceptance requires the exact approved combination with full values", () => {
  const observed = { "node.version": "v1.2.3", "cli.package": "mmx-cli", "cli.version": "1.0.29", "cli.entry_sha256": "a".repeat(64), "undici.version": "6.28.0" };
  const config = { format: 1, approved: true, node: { version: "v1.2.3" }, cli: { package: "mmx-cli", version: "1.0.29", entry_sha256: "a".repeat(64) }, undici: { version: "6.28.0" } };
  assert.deepEqual(checkAcceptance(config, observed), []);
  assert.deepEqual(checkAcceptance({ ...config, approved: false }, observed), ["config is not approved"]);
  assert.deepEqual(checkAcceptance(config, { ...observed, "cli.version": "1.0.30" }), ["cli.version differs: expected 1.0.29, found 1.0.30"]);
  assert.deepEqual(checkAcceptance(config, { ...observed, "cli.entry_sha256": null }), ["cli.entry_sha256 differs: expected " + "a".repeat(64) + ", found nothing"]);
  assert.deepEqual(checkAcceptance({ ...config, cli: { ...config.cli, entry_sha256: "a".repeat(63) } }, observed), ["cli.entry_sha256 is malformed"]);
  assert.deepEqual(checkAcceptance({ ...config, undici: { version: "latest" } }, observed), ["undici.version is malformed"]);
  assert.equal(checkAcceptance({ format: 1, approved: true }, observed).length, 5, "every approved field must be present");
});

// A synthetic mmx-cli package layout with an approved admission config; only
// metadata and digests are read. Shared by the dry-run and binding tests.
let acceptanceSeq = 0;
function approvedLayout() {
  const base = path.join(root, "acceptance-" + String(++acceptanceSeq));
  const pkg = path.join(base, "node_modules", "mmx-cli");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.mkdirSync(path.join(base, "node_modules", "undici"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "mmx-cli", version: "9.9.9", bin: { mmx: "dist/mmx.mjs" } }));
  const entry = path.join(pkg, "dist", "mmx.mjs");
  fs.writeFileSync(entry, "// synthetic entry; never executed\n", { mode: 0o755 }); // POSIX PATH lookup needs X_OK
  fs.writeFileSync(path.join(base, "node_modules", "undici", "package.json"), JSON.stringify({ name: "undici", version: "1.2.3", main: "index.js" }));
  fs.writeFileSync(path.join(base, "node_modules", "undici", "index.js"), "");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(base, "mmx.cmd"), "@ECHO off\r\nSETLOCAL\r\nSET _prog=node\r\n\"%_prog%\" \"%dp0%\\node_modules\\mmx-cli\\dist\\mmx.mjs\" %*\r\n");
  } else {
    fs.symlinkSync(entry, path.join(base, "mmx"), "file");
  }
  const config = { format: 1, approved: true, node: { version: process.version }, cli: { package: "mmx-cli", version: "9.9.9",
    entry_sha256: (require("node:crypto").createHash("sha256").update(fs.readFileSync(entry)).digest("hex")) }, undici: { version: "1.2.3" } };
  const configFile = path.join(base, "approved.json");
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const env = cleanEnv({ PATH: `${base}${path.delimiter}${cleanEnv().PATH}` });
  return { base, config, configFile, env };
}

test("phase D: a matching approved combination is reported in dry-run without launching anything", () => {
  const { base, config, configFile, env } = approvedLayout();
  const matched = spawnSync(process.execPath, [acceptance, "--config", configFile, "--dry-run"], { encoding: "utf8", env });
  assert.equal(matched.status, 0, matched.stdout + matched.stderr);
  const report = JSON.parse(matched.stdout);
  assert.equal(report.status, "matched");
  assert.equal(report.launched, false);
  assert.equal(report.observed["cli.version"], "9.9.9");
  assert.equal(report.observed["undici.version"], "1.2.3");
  // A drifted combination is refused with the differing field named.
  const driftedConfig = path.join(base, "drifted.json");
  fs.writeFileSync(driftedConfig, JSON.stringify({ ...config, cli: { ...config.cli, version: "1.0.30" } }, null, 2));
  const refused = spawnSync(process.execPath, [acceptance, "--config", driftedConfig, "--dry-run"],
    { encoding: "utf8", env: cleanEnv({ PATH: env.PATH }) });
  assert.equal(refused.status, 2);
  assert.deepEqual(JSON.parse(refused.stdout).problems, ["cli.version differs: expected 1.0.30, found 9.9.9"]);
});

test("V2.2.1 D4: the admitted identity is handed to the entry that runs", () => {
  const { configFile, env, config } = approvedLayout();
  const probe = path.join(root, "binding-probe.cjs");
  fs.writeFileSync(probe, "process.stdout.write(process.env.ZMX_ACCEPTANCE_BINDING + \"\\n\");\n");
  const run = spawnSync(process.execPath, [acceptance, "--config", configFile, "--", probe],
    { encoding: "utf8", env: cleanEnv({ PATH: env.PATH }) });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const binding = JSON.parse(run.stdout);
  for (const field of ["node.version", "cli.package", "cli.version", "cli.entry_sha256", "undici.version"]) {
    assert.equal(typeof binding[field], "string", field);
  }
  assert.equal(binding["cli.entry_sha256"], config.cli.entry_sha256);
  assert.equal(binding["undici.version"], config.undici.version);
  assert.equal(binding["node.version"], process.version);
});
