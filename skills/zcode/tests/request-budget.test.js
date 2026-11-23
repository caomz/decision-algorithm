"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const budget = require("../scripts/request-budget.js");
const { EventParser, preflightRequestBudget } = require("../scripts/zcode-chat.js");
const preload = require.resolve("../scripts/request-budget-preload.cjs");

test("a second native model request event fails immediately, including same-model events", () => {
  const p = new EventParser();
  const event = (iteration) => JSON.stringify({ type: "session.updated", payload: {
    messageCount: 1, iteration, modelId: "fake-model", providerId: "fake-provider", toolCount: 0,
  } });
  p.accept(event(0));
  assert.throws(() => p.accept(event(1)), { status: "request_budget_exceeded" });
  assert.equal(p.requests, 2);
});

test("preflight rejects an unreviewed launcher before it can run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "z-budget-unknown-"));
  const file = path.join(dir, process.platform === "win32" ? "zcode.exe" : "zcode");
  const marker = path.join(dir, "executed");
  fs.writeFileSync(file, "#!/usr/bin/env node\nrequire('fs').writeFileSync(" + JSON.stringify(marker) + ",'1')\n", { mode: 0o700 });
  assert.equal(preflightRequestBudget({ PATH: dir }).ok, false);
  assert.equal(fs.existsSync(marker), false);
});

// The listener counts arrivals independent of the guard. The child only
// receives the synthetic endpoint and writes no headers, bodies or credentials to evidence.
const cases = {
  success: [1, null], throttle: [1, "request_budget_exceeded"], disconnect: [1, "request_budget_exceeded"],
  concurrent: [1, "request_budget_exceeded"], mixed: [1, "request_budget_exceeded"], redirect: [1, null],
  "over-limit": [0, "output_limit_exceeded"], "missing-limit": [0, "output_limit_unverified", "field_absent"],
  "ambiguous-limit": [0, "output_limit_unverified", "fields_ambiguous"], "unknown-path": [0, "output_limit_unverified", "endpoint"],
  "proxy-write": [0, "output_limit_unverified", "http_stream"],
};
for (const [scenario, [expectedArrivals, blockedReason, blockedDetail]] of Object.entries(cases)) {
  test("wire request and token limits: " + scenario, { timeout: 15000 }, async t => {
    let arrivals = 0;
    const server = http.createServer((req, res) => {
      arrivals++;
      if (scenario === "disconnect") {
        res.writeHead(200, { "Content-Length": "30" });
        res.write("partial");
        setImmediate(() => res.destroy());
      } else if (scenario === "throttle") { res.writeHead(429); res.end(); }
      else if (scenario === "redirect") { res.writeHead(307, { Location: "/second" }); res.end(); }
      else res.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "z-budget-wire-"));
    const file = path.join(dir, "client.cjs");
    const source = `
const http = require("node:http"), url = process.argv[2], scenario = process.argv[3];
const body = scenario === "over-limit" ? {"max_tokens": 9} : scenario==="missing-limit" ? {} :
  scenario==="ambiguous-limit" ? {"max_tokens": 8, "max_completion_tokens": 99} : {"max_tokens": 8};
const post = async () => (await fetch(url, { method: "POST", body: JSON.stringify(body) })).text();
const legacy = () => new Promise((ok, bad) => {
  const req = http.request(new URL(url), { method:"POST" }, res => { res.resume(); res.on("end", ok); res.on("error", bad); });
  req.on("error", bad); req.end();
});
(async () => {
  if (scenario === "concurrent") await Promise.allSettled([post(),post()]);
  else if (scenario === "mixed") { await post(); await legacy().catch(()=>{}); }
  else if (scenario === "proxy-write") await legacy().catch(()=>{});
  else { await post().catch(()=>{}); if (["throttle","disconnect"].includes(scenario)) await post().catch(()=>{}); }
})().catch(()=>{ process.exitCode=1; });`;
    fs.writeFileSync(file, source);
    const child = spawn(process.execPath, ["--require", preload, file,
      "http://127.0.0.1:" + server.address().port + (scenario==="unknown-path" ? "/unknown" : "/v1/chat/completions"), scenario],
    { stdio: ["ignore", "ignore", "pipe"], env: { ZCODE_WRAPPER_BUDGET_DIR: dir, ZCODE_WRAPPER_ENTRY_SHA256: budget.digest(file), ZCODE_WRAPPER_OUTPUT_LIMIT: "8" } });
    let err = "";
    child.stderr.on("data", bytes => { err += bytes; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, err);
    assert.equal(arrivals, expectedArrivals);
    assert.deepEqual(budget.observation(dir, {level:"local_test",entry_sha256:budget.digest(file),max_output_tokens:8}, 1),
      { limit:1, attempts:expectedArrivals, project_token_exchanges:0, blocked:Boolean(blockedReason), blocked_reason:blockedReason,
        ...(blockedDetail ? { blocked_detail: blockedDetail } : {}),
        verified:true, level:"local_test", entry_sha256:budget.digest(file), model_request_events:1, max_output_tokens:8,
        wire_max_output_tokens:expectedArrivals ? 8 : null, output_limit_verified:Boolean(expectedArrivals) });
  });
}

for (const [scenario, expected, detail] of [
  ["signed-in", ["exchange", "model"]],
  ["runtime-version", ["exchange", "model"]],
  ["already-used", ["exchange"], "project_token_duplicate"],
  ["too-late", ["model"], "project_token_order"],
  ["ineligible-payload", [], "project_token_body"],
  ["different-origin", [], "endpoint"],
  ["key-creation", [], "endpoint"],
  ["redirect", ["exchange"]],
  ["model-over-cap", ["exchange"]],
]) {
  test("existing project token exchange: " + scenario, { timeout: 12000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "z-budget-project-token-"));
    const transport = path.join(dir, "fixture-transport.cjs");
    const file = path.join(dir, "client.cjs");
    // Both supported Node dispatcher slots point to an in-memory transport.
    // The fixture uses the real Fetch pipeline, with zero sockets or credentials.
    fs.writeFileSync(transport, `
const fs = require("node:fs"), path = require("node:path");
const origin = "https://bigmodel.cn";
const scenario = process.argv[2];
const fake = { dispatch(options, handler) {
  const isExchange = options.path.endsWith("/access_tokens");
  if (isExchange && options.origin.toString() !== origin) throw new Error("unexpected synthetic origin");
  fs.appendFileSync(path.join(__dirname, "dispatches"), isExchange ? "exchange\\n" : "model\\n");
  const redirect = scenario === "redirect" && isExchange;
  const code = redirect ? 307 : 200;
  const headers = redirect ? [Buffer.from("location"), Buffer.from("/other")] : [];
  if (handler.onConnect) {
    handler.onConnect(() => {});
    handler.onHeaders(code, headers, () => {}, redirect ? "Temporary Redirect" : "OK");
    handler.onComplete([]);
  } else {
    const controller = { abort() {}, pause() {}, resume() {}, paused: false, aborted: false };
    handler.onRequestStart(controller, null);
    handler.onResponseStart(controller, code, redirect ? { location: "/other" } : {}, redirect ? "Temporary Redirect" : "OK");
    handler.onResponseEnd(controller, {});
  }
  return true;
}};
new Request("data:,");
for (const key of ["undici.globalDispatcher.1", "undici.globalDispatcher.2"]) globalThis[Symbol.for(key)] = fake;`);
    fs.writeFileSync(file, `
const origin = process.argv[2] === "different-origin" ? "https://fixture.invalid" : "https://bigmodel.cn";
const path = "/api/biz/v1/organization/sample_org/projects/sample_project/api_keys";
const project = origin + path + (process.argv[2] === "key-creation" ? "" : "/sample_key.test_id/access_tokens");
const scenario = process.argv[2];
const body = { clientType: "zcode", clientVersion: scenario === "runtime-version" ? "0.17.1" : "0.0.0-dev" };
if (scenario === "ineligible-payload") body.other = false;
const token = () => fetch(project, { method: "POST", body: Buffer.from(JSON.stringify(body)) });
const model = () => fetch("https://fixture.invalid/v1/messages", { method: "POST",
  body: JSON.stringify({ max_tokens: scenario === "model-over-cap" ? 9 : 8 }) });
(async () => {
  if (scenario === "too-late") { await model(); await token().catch(() => {}); return; }
  await token().catch(() => {});
  if (scenario === "already-used") await token().catch(() => {});
  if (["signed-in","runtime-version","model-over-cap"].includes(scenario)) await model().catch(() => {});
})().catch(error => { console.error(error); process.exitCode = 1; });`);
    const hash = budget.digest(file);
    const child = spawn(process.execPath, ["--require", transport, "--require", preload, file, scenario], {
      stdio: ["ignore", "ignore", "pipe"], env: { ZCODE_WRAPPER_BUDGET_DIR: dir,
        ZCODE_WRAPPER_ENTRY_SHA256: hash, ZCODE_WRAPPER_OUTPUT_LIMIT: "8" },
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    const log = path.join(dir, "dispatches");
    const sent = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    assert.deepEqual(sent, expected);
    const proof = budget.observation(dir, { level: "fixture", entry_sha256: hash, max_output_tokens: 8 }, 1);
    assert.equal(proof.project_token_exchanges, Number(expected.includes("exchange")));
    assert.equal(proof.attempts, Number(expected.includes("model")));
    assert.equal(proof.blocked_detail, detail);
    assert.equal(proof.blocked_reason, scenario === "model-over-cap" ? "output_limit_exceeded" : detail ? "output_limit_unverified" : null);
  });
}

for (const [scenario, expectedArrivals, reason, detail] of [
  ["request", 1, null], ["null-init-body", 1, null], ["override", 1, null],
  ["duplicate", 1, "request_budget_exceeded"], ["excessive-limit", 0, "output_limit_exceeded"],
  ["invalid-utf8", 0, "output_limit_unverified", "body_utf8"],
  ["consumed", 0, "output_limit_unverified", "body_unavailable"],
  ["large", 0, "output_limit_unverified", "body_size"],
  ["abort", 0, "output_limit_unverified", "body_aborted"],
  ["stalled", 0, "output_limit_unverified", "body_timeout"],
]) {
  test("Request-body wire proof: " + scenario, { timeout: 15000 }, async t => {
    const original = ' { "note": "中文🌟", "max_completion_tokens" : 8 }\n';
    const received = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(Buffer.concat(chunks));
      res.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "z-request-body-"));
    const file = path.join(dir, "client.cjs");
    fs.writeFileSync(file, `
const assert=require("node:assert/strict"), original=${JSON.stringify(original)}, [url, scenario]=process.argv.slice(2);
(async () => {
  const controller = new AbortController();
  let body = original;
  if (scenario === "excessive-limit" || scenario === "override") body = '{"max_completion_tokens":9}';
  if (scenario === "invalid-utf8") body = new Uint8Array([0xff,0x00]);
  if (scenario === "large") body = "x".repeat(4 * 1024 * 1024 + 1);
  if (scenario === "stalled" || scenario === "abort") body = new ReadableStream({start(){}});
  const req = new Request(url,{method:"POST",body,duplex:"half",signal:controller.signal});
  if (scenario === "consumed") await req.text();
  if (scenario === "abort") setTimeout(()=>controller.abort(),20);
  const init = scenario === "override" ? {body: original} : scenario === "null-init-body" ? {body:null} : undefined;
  try {
    assert.equal(await (await fetch(req, init)).text(), "ok");
    assert.ok(["request","null-init-body","override","duplicate"].includes(scenario));
  } catch (error) {
    if (["request","null-init-body","override","duplicate"].includes(scenario)) throw error;
  }
  if (scenario === "duplicate") await assert.rejects(fetch(req));
  assert.equal(req.bodyUsed, scenario === "consumed");
  if (scenario === "request") assert.equal(await req.text(),original);
  else if (!req.bodyUsed) req.body.cancel().catch(()=>{});
})().catch(error=>{console.error(error);process.exitCode=1});`);
    const entryHash = budget.digest(file);
    const child = spawn(process.execPath, ["--require",preload,file,
      "http://127.0.0.1:" + server.address().port + "/v1/chat/completions", scenario],
      {stdio:["ignore","ignore","pipe"],env:{ZCODE_WRAPPER_BUDGET_DIR:dir,ZCODE_WRAPPER_ENTRY_SHA256:entryHash,ZCODE_WRAPPER_OUTPUT_LIMIT:"8"}});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let stderr="";
    child.stderr.on("data",chunk=>{stderr+=chunk;});
    const [code] = await once(child, "close");
    assert.equal(code,0,stderr);
    assert.deepEqual(received, Array.from({length:expectedArrivals},()=>Buffer.from(original)));
    const proof = budget.observation(dir,{level:"test",entry_sha256:entryHash,max_output_tokens:8},1);
    assert.equal(proof.blocked_reason,reason);
    assert.equal(proof.blocked_detail,detail);
    assert.equal(proof.attempts,expectedArrivals);
    assert.equal(proof.wire_max_output_tokens,expectedArrivals ? 8 : null);
  });
}
