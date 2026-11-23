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
  "over-limit": [0, "output_limit_exceeded"], "missing-limit": [0, "output_limit_unverified"],
  "ambiguous-limit": [0, "output_limit_unverified"], "unknown-path": [0, "output_limit_unverified"],
  "proxy-write": [0, "output_limit_unverified"],
};
for (const [scenario, [expectedArrivals, blockedReason]] of Object.entries(cases)) {
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
      { limit:1, attempts:expectedArrivals, blocked:Boolean(blockedReason), blocked_reason:blockedReason,
        verified:true, level:"local_test", entry_sha256:budget.digest(file), model_request_events:1, max_output_tokens:8,
        wire_max_output_tokens:expectedArrivals ? 8 : null, output_limit_verified:Boolean(expectedArrivals) });
  });
}
