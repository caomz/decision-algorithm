#!/usr/bin/env node
"use strict";
// Controlled loopback diagnosis. Never downloads a CLI or contacts a provider.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const GUARD = path.join(__dirname, "fetch-timeout-guard.js");
const EXPECTED_CLI = "1.0.29";
const sha = b => createHash("sha256").update(b).digest("hex");
function save(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function parse(argv) {
  const out = { suite: "node-fetch", delayMs: 305000, caseGroup: "headers" };
  const names = new Map([["--suite", "suite"], ["--out", "out"], ["--cli-root", "cliRoot"], ["--undici-path", "undiciPath"], ["--delay-ms", "delayMs"], ["--case-group", "caseGroup"]]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = names.get(argv[i]);
    if (!key || seen.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("invalid or duplicate option");
    seen.add(key); out[key] = argv[i + 1];
  }
  out.delayMs = Number(out.delayMs);
  if (!out.out || !["headers", "body", "errors", "all"].includes(out.caseGroup) || !["node-fetch", "mmx-cli"].includes(out.suite) || !Number.isSafeInteger(out.delayMs) || out.delayMs < 1 || out.delayMs > 330000) throw new Error("expected --out NEW_DIR, suite node-fetch|mmx-cli, delay 1..330000 ms");
  return out;
}
function isolation() {
  if (process.platform !== "linux") throw new Error("requires an independently isolated Linux loopback-only network namespace");
  const devices = fs.readFileSync("/proc/net/dev", "utf8").trim().split("\n").slice(2).map(l => l.split(":")[0].trim());
  if (devices.length !== 1 || devices[0] !== "lo") throw new Error("loopback-only isolation not verified; refusing before CLI launch");
  const routes = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  if (routes.some(x => x.trim().split(/\s+/)[1] === "00000000")) throw new Error("default route present");
  return { mechanism: "linux-network-namespace", interfaces: devices, ipv4_default_route: false, addresses: ["127.0.0.1"] };
}
function dependency(entry) {
  let dir = path.dirname(fs.realpathSync(entry));
  for (;;) {
    const metadata = path.join(dir, "package.json");
    if (fs.existsSync(metadata)) { const bytes = fs.readFileSync(metadata); const pkg = JSON.parse(bytes); if (pkg.name === "undici") return { name: pkg.name, version: pkg.version, package_sha256: sha(bytes) }; }
    if (path.dirname(dir) === dir) throw new Error("undici package metadata unavailable");
    dir = path.dirname(dir);
  }
}
async function experiment(opts) {
  const network = isolation();
  let entry = null, cli = null, undiciPath = opts.undiciPath;
  if (opts.suite === "mmx-cli") {
    if (!opts.cliRoot) throw new Error("--cli-root must name an already-installed mmx-cli package");
    const root = fs.realpathSync(opts.cliRoot), metadata = fs.readFileSync(path.join(root, "package.json"));
    const pkg = JSON.parse(metadata);
    if (pkg.name !== "mmx-cli" || pkg.version !== EXPECTED_CLI) throw new Error("only the pinned mmx-cli 1.0.29 is accepted; this runner never installs or upgrades");
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.mmx;
    if (typeof bin !== "string" || path.isAbsolute(bin)) throw new Error("invalid mmx bin");
    entry = fs.realpathSync(path.resolve(root, bin));
    if (path.relative(root, entry).startsWith("..")) throw new Error("mmx entry escapes its package");
    cli = { name: pkg.name, version: pkg.version, package_sha256: sha(metadata), entry_sha256: sha(fs.readFileSync(entry)) };
    const resolved = require.resolve("undici", { paths: [root] });
    if (undiciPath && fs.realpathSync(undiciPath) !== fs.realpathSync(resolved)) throw new Error("mmx suite must use its own undici dependency");
    undiciPath = resolved;
  }
  if (!undiciPath) throw new Error("--undici-path is required for node-fetch controls (use an installed dependency)");
  undiciPath = fs.realpathSync(undiciPath);
  const dep = dependency(undiciPath);
  const out = path.resolve(opts.out);
  fs.mkdirSync(out, { mode: 0o700 });
  const envRoot = path.join(out, "isolated"); fs.mkdirSync(envRoot, { mode: 0o700 });
  for (const name of ["home", "config", "tmp"]) fs.mkdirSync(path.join(envRoot, name), { mode: 0o700 });
  const prompt = [{ role: "user", content: "Return LOOPBACK_OK. This is a local controlled transport experiment." }];
  const messages = path.join(envRoot, "messages.json"); save(messages, prompt);
  const baseEnv = { PATH: path.dirname(process.execPath), HOME: path.join(envRoot, "home"), USERPROFILE: path.join(envRoot, "home"), MMX_CONFIG_DIR: path.join(envRoot, "config"), TMPDIR: path.join(envRoot, "tmp"), TMP: path.join(envRoot, "tmp"), TEMP: path.join(envRoot, "tmp"), LANG: "C.UTF-8", CI: "true" };
  const plan = { format: 1, suite: opts.suite, created_at: new Date().toISOString(), node: process.version, bundled_undici: process.versions.undici ?? null, undici: dep, cli, isolation: network, delay_ms: opts.delayMs, threshold_300s_exercised: opts.delayMs > 300000, request_timeout_ms: 600000, wrapper_timeout_ms: null, supervisor_timeout_ms: 650000, supervisor_cleanup_timeout_ms: 8000, runner_sha256: sha(fs.readFileSync(__filename)), guard_sha256: sha(fs.readFileSync(GUARD)), real_provider: "NOT_EVALUATED", real_mmx_transport: opts.suite === "mmx-cli" ? "TESTING" : "NOT_EVALUATED", note: "Raw CLI/fetch transport controls; the production 630s wrapper is not exercised by this runner." };
  save(path.join(out, "plan.json"), plan);
  const groups = { headers: ["headers-unguarded", "headers-guarded"], body: ["body-unguarded", "body-guarded"], errors: ["http-429", "http-500", "connection-reset"] };
  const cases = opts.caseGroup === "all" ? Object.values(groups).flat() : groups[opts.caseGroup ?? "headers"];
  if (opts.suite === "mmx-cli" && opts.caseGroup === "headers") cases.push(...groups.errors);
  const results = [];
  async function runCase(name) {
    const guarded = !name.endsWith("-unguarded");
    const events = [], sockets = new Set(), timers = new Set();
    const began = performance.now();
    const response = { id: "loopback-message", type: "message", role: "assistant", content: [{ type: "text", text: "LOOPBACK_OK" }], model: "MiniMax-M3", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, base_resp: { status_code: 0, status_msg: "" } };
    const server = http.createServer((req, res) => {
      let bytes = 0; const hash = createHash("sha256");
      req.on("data", b => { bytes += b.length; hash.update(b); });
      req.on("end", () => {
        events.push({ ordinal: events.length + 1, method: req.method, path: req.url, received_ms: Math.round(performance.now() - began), body_bytes: bytes, body_sha256: hash.digest("hex") });
        if (name === "connection-reset") { req.socket.destroy(); return; }
        const send = () => { res.setHeader("Content-Type", "application/json"); if (name.startsWith("http-")) { res.statusCode = Number(name.slice(5)); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "controlled local failure" } })); } else res.end(JSON.stringify(response)); };
        if (name.startsWith("headers-")) { const timer = setTimeout(send, opts.delayMs); timers.add(timer); }
        else if (name.startsWith("body-")) {
          res.setHeader("Content-Type", "application/json");
          const bytes = JSON.stringify(response);
          res.write(bytes.slice(0, 1));
          const timer = setTimeout(() => res.end(bytes.slice(1)), opts.delayMs); timers.add(timer);
        } else send();
      });
    });
    server.on("connection", sock => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const ack = path.join(out, `${name}.guard`);
    const env = { ...baseEnv, MINIMAX_BASE_URL: endpoint, MINIMAX_API_KEY: "synthetic-loopback-only-key", MMX_CHAT_UNDICI_PATH: undiciPath, MMX_CHAT_FETCH_GUARD_STATUS: ack, ZMX_PROBE_URL: endpoint + "/anthropic/v1/messages" };
    const prefix = guarded ? ["--require", GUARD] : [];
    const args = opts.suite === "mmx-cli" ? [...prefix, entry, "text", "chat", "--messages-file", messages, "--max-tokens", "524288", "--output", "json", "--non-interactive", "--no-color", "--timeout", "600"] : [...prefix, __filename, "--fetch-child"];
    const outcome = await new Promise(resolve => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stopped = null;
      let exited = false, exitCode = null, exitSignal = null, finished = false, overflow = false;
      let tailTimer, escalation, hardTimer, processTimer;
      const cap = 1024 * 1024;
      function signal(sig) { try { if (process.platform !== "win32") process.kill(-child.pid, sig); else child.kill(sig); } catch {} }
      function finish() {
        if (finished) return; finished = true;
        for (const timer of [processTimer, tailTimer, escalation, hardTimer]) clearTimeout(timer);
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        // Bytes are synthetic, from an empty config/home with only a local dummy key.
        // Preserve them for independent diagnosis; never include host credentials.
        for (const [suffix, bytes] of [["stdout", stdout], ["stderr", stderr]]) {
          const fd = fs.openSync(path.join(out, `${name}.${suffix}`), "wx", 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        let receipt = null; try { receipt = JSON.parse(stdout.toString("utf8")); } catch {}
        resolve({ exit_code: exitCode, signal: exitSignal, local_process_exit_observed: exited, supervisor_expired: stopped === "supervisor_timeout", stop_reason: stopped, local_tree_cleanup: "NOT_VERIFIED", capture_truncated: overflow, stdout_bytes: stdout.length, stdout_sha256: sha(stdout), stderr_bytes: stderr.length, stderr_sha256: sha(stderr), ...(opts.suite === "node-fetch" ? { receipt } : {}) });
      }
      function stop(reason) {
        if (stopped || finished) return; stopped = reason; signal("SIGTERM");
        escalation = setTimeout(() => signal("SIGKILL"), 2000);
        hardTimer = setTimeout(finish, 8000);
      }
      processTimer = setTimeout(() => stop("supervisor_timeout"), 650000);
      function capture(previous, bytes) { const room = cap - previous.length; if (bytes.length > room) { overflow = true; stop("capture_limit"); } return Buffer.concat([previous, bytes.subarray(0, room)]); }
      child.stdout.on("data", bytes => { stdout = capture(stdout, bytes); });
      child.stderr.on("data", bytes => { stderr = capture(stderr, bytes); });
      child.on("error", () => { stopped = "spawn_error"; finish(); });
      child.on("exit", (code, sig) => { exited = true; exitCode = code; exitSignal = sig; tailTimer = setTimeout(() => stop("pipe_close_timeout"), 4000); });
      child.on("close", (code, sig) => { exitCode = code; exitSignal = sig; finish(); });
    });
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    let acknowledged = false; try { acknowledged = fs.readFileSync(ack, "utf8") === "applied\n"; } catch {}
    const result = { case: name, elapsed_ms: Math.round(performance.now() - began), guarded, guard_initialized: acknowledged, requests: events.length, requests_after_first: Math.max(0, events.length - 1), events, ...outcome };
    save(path.join(out, `${name}.json`), result);
    process.stdout.write(JSON.stringify({ case: name, elapsed_ms: result.elapsed_ms, requests: events.length, exit_code: result.exit_code }) + "\n");
    return result;
  }
  // Fetch controls are independent, non-provider processes. Actual CLI cases stay serial.
  if (opts.suite === "node-fetch") results.push(...await Promise.all(cases.map(runCase)));
  else for (const name of cases) results.push(await runCase(name));
  const report = { ...plan, real_mmx_transport: opts.suite === "mmx-cli" && results.some(r => r.requests > 0) ? (results.every(r => r.requests > 0) ? "OBSERVED_LOCAL_ONLY" : "INCOMPLETE_LOCAL_ONLY") : "NOT_EVALUATED", provider_internal_retry: opts.suite === "mmx-cli" ? { status: results.every(r => r.requests > 0 && r.local_process_exit_observed && !r.capture_truncated && r.stop_reason === null) ? "OBSERVED_LOCAL_SCENARIOS" : "INCOMPLETE_NOT_EVALUATED", evidence_scope: "listed local scenarios only; never generalized to all faults", observed_cases: results.filter(r => r.requests > 0).map(r => r.case), unobserved_cases: results.filter(r => r.requests === 0).map(r => r.case), additional_requests_observed: results.some(r => r.requests > 1) } : "NOT_EVALUATED", cases: results };
  save(path.join(out, "report.json"), report);
  return report;
}
async function fetchChild() {
  isolation();
  const endpoint = new URL(process.env.ZMX_PROBE_URL);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password) throw new Error("fetch child accepts loopback HTTP only");
  const started = performance.now();
  try { const response = await fetch(process.env.ZMX_PROBE_URL, { method: "POST", body: JSON.stringify({ probe: "loopback" }), signal: AbortSignal.timeout(600000), redirect: "error" }); const text = await response.text(); process.stdout.write(JSON.stringify({ status: response.status, body_bytes: Buffer.byteLength(text), elapsed_ms: Math.round(performance.now() - started) }) + "\n"); }
  catch (e) { process.stdout.write(JSON.stringify({ error: e.name, cause: e.cause?.code ?? null, elapsed_ms: Math.round(performance.now() - started) }) + "\n"); process.exitCode = 1; }
}
if (require.main === module) {
  (process.argv[2] === "--fetch-child" ? fetchChild() : experiment(parse(process.argv.slice(2)))).catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 2; });
} else module.exports = { parse, isolation, experiment };
