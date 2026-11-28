"use strict";
// V2.2.1 D6: bounded teardown. Only processes this test run started, or pids
// whose command line carries this run's marker, are ever signalled.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { cleanEnv } = require("./support/env.js");
const { track, stop, teardown } = require("./support/teardown.js");

const deaf = marker => "process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000); /* " + marker + " */";
function start(marker) {
  const child = spawn(process.execPath, ["-e", deaf(marker), marker], { stdio: "ignore", shell: false, env: cleanEnv() });
  return new Promise((resolve, reject) => { child.once("spawn", () => resolve(child)); child.once("error", reject); });
}

test("V2.2.1 D6: a SIGTERM-deaf child is stopped within a bound and its exit is verified", { timeout: 20000 }, async () => {
  const child = await start("teardown-deaf");
  track(child);
  const began = Date.now();
  assert.equal(await stop(child), "exited");
  assert.ok(Date.now() - began < 8000, "the grace periods are bounded");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the exit is verified through the handle");
});

test("V2.2.1 D6: a recorded pid carrying the marker is stopped; one without it is never touched", { timeout: 30000 }, async () => {
  const child = await start("teardown-recorded");
  const ended = new Promise(resolve => child.once("close", resolve));
  assert.equal(await stop({ pid: child.pid, marker: "teardown-recorded" }), "exited");
  await ended;
  // The test runner itself is alive but carries no fixture marker: it must be
  // reported as reused rather than signalled or failed. The diagnostic suffix
  // names the foreign command line; only the prefix is contractual.
  const unprovable = await stop({ pid: process.pid, marker: "no-such-marker" });
  assert.ok(unprovable.startsWith("pid reused; the recorded process exited"), unprovable);
});

test("V2.2.1 D6: teardown leaves an unprovable pid alone and confirms everything else", { timeout: 30000 }, async () => {
  const child = await start("teardown-teardown");
  track(child);
  track({ pid: process.pid, marker: "no-such-marker-either" });
  await teardown();
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, "the owned child is confirmed exited");
  assert.equal(typeof process.pid, "number", "the test runner is still alive");
});
