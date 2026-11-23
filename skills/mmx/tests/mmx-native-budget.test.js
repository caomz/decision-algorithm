"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installFetchBudget } = require("../scripts/mmx-native-budget.js");

const url = "https://native-fixture.invalid/anthropic/v1/messages";
const payload = tokens => ({ method: "POST", body: JSON.stringify({ max_tokens: tokens }) });
function fixture(t, respond = async () => "ok") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-native-budget-"));
  const claim = path.join(dir, "claim");
  const calls = [];
  t.after(() => {
    for (const name of [claim, claim + ".blocked"]) if (fs.existsSync(name)) fs.unlinkSync(name);
    fs.rmdirSync(dir);
  });
  function client() {
    const target = { fetch: async (...params) => { calls.push(params); return respond(...params); } };
    installFetchBudget(claim, 24, target);
    return target;
  }
  return { claim, calls, client };
}

test("two concurrent native clients share one irreversible allocation", async t => {
  const { calls, claim, client } = fixture(t);
  const a = client(), b = client();
  const sent = await Promise.allSettled([a.fetch(url, payload(20)), b.fetch(url, payload(20))]);
  assert.deepEqual(sent.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(fs.readFileSync(claim, "utf8"), "20\n");
  assert.equal(fs.readFileSync(claim + ".blocked", "utf8"), "blocked\n");
});

test("request loss consumes the reservation; a new client cannot replay", async t => {
  const { calls, client } = fixture(t, async () => { throw Error("lost response"); });
  await assert.rejects(client().fetch(url, payload(24)), /lost response/);
  await assert.rejects(client().fetch(url, payload(24)), /approved budget/);
  assert.equal(calls.length, 1);
});

test("rejects malformed or oversized payloads and unexpected write routes before dispatch", async t => {
  const { calls, client, claim } = fixture(t);
  const a = client();
  for (const [target, options] of [[url, payload(25)], [url, { method: "POST", body: "?" }],
    [url, payload(null)], ["https://native-fixture.invalid/?wrong=/anthropic/v1/messages", payload(10)],
    ["https://native-fixture.invalid/oauth2/token", payload(10)], [url, { method: "PUT" }]]) {
    await assert.rejects(a.fetch(target, options), /approved budget/);
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(claim), false);
});

test("metadata and form-encoded OAuth may precede the single model fetch without redirects", async t => {
  const { calls, client } = fixture(t);
  const a = client();
  await a.fetch("https://native-fixture.invalid/region");
  await a.fetch("https://native-fixture.invalid/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "synthetic" }),
  });
  await a.fetch(url, payload(24));
  await assert.rejects(a.fetch(url, payload(24)));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([, options]) => options.redirect === "error"));
});
