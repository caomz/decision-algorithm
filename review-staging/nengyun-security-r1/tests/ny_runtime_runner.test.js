'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSkill, inspectReadOnly, childEnvironment } = require('../scripts/ny_windows_runtime');
const { resourceKeyForFile, resourceKeyForBrowser } = require('../scripts/ny_runtime_resources');
const FIXTURE = path.join(__dirname, 'fixtures', 'runtime_worker.js');
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-runner-synthetic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function options(root, extra = {}) {
  return { entry: FIXTURE, cwd: root, skillId: 'SyntheticSkill', runRoot: root,
    lockRoot: root, assumeNoDescendants: true, ...extra };
}
async function waitFor(predicate, ms = 1800) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  throw new Error('synthetic barrier timeout');
}
test('T01 A to B to A uses original cwd and distinct run directories and env copies', async (t) => {
  const root = sandbox(t);
  const aDir = path.join(root, 'A 中文 空格');
  const bDir = path.join(root, 'B spaces');
  fs.mkdirSync(aDir); fs.mkdirSync(bDir);
  const a1 = await runSkill(options(root, { skillId: 'A', cwd: aDir, args: ['echo', '原始 参数', 'a', 'quote"|&'], env: { SYNTHETIC_MARK: 'A1' } }));
  const b = await runSkill(options(root, { skillId: 'B', cwd: bDir, args: ['echo', 'b', 'b'], env: { SYNTHETIC_MARK: 'B1' } }));
  const a2 = await runSkill(options(root, { skillId: 'A', cwd: aDir, args: ['echo', 'a', 'a'], env: { SYNTHETIC_MARK: 'A2' } }));
  for (const result of [a1, b, a2]) { assert.equal(result.status, 'FINISHED'); assert.equal(result.exitCode, 0); }
  assert.equal(new Set([a1.runDir, b.runDir, a2.runDir]).size, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a1.runDir, 'result.json'))).cwd, aDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.runDir, 'result.json'))).syntheticEnv, 'B1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a2.runDir, 'result.json'))).syntheticEnv, 'A2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a1.runDir, 'result.json'))).args[2], 'quote"|&');
  assert.equal(a1.stdout.toString(), 'OUT_SYNTHETIC\n');
  assert.equal(a1.stderr.toString(), 'ERR_SYNTHETIC\n');
});
test('T02 two different resource keys run concurrently across real child processes', async (t) => {
  const root = sandbox(t);
  const p1 = runSkill(options(root, { skillId: 'A', args: ['barrier', root], resourceKeys: [resourceKeyForBrowser('session-a')] }));
  const p2 = runSkill(options(root, { skillId: 'B', args: ['barrier', root], resourceKeys: [resourceKeyForBrowser('session-b')] }));
  await waitFor(() => fs.readdirSync(root).filter(x => x.startsWith('in-')).length === 2);
  fs.writeFileSync(path.join(root, 'release'), 'go');
  const results = await Promise.all([p1, p2]);
  assert.ok(results.every(x => x.status === 'FINISHED' && x.exitCode === 0));
});
test('T03/T04 same writable resource serializes distinct and repeated Skill executions', async (t) => {
  const root = sandbox(t);
  const log = path.join(root, 'events.txt'); fs.writeFileSync(log, '');
  const shared = resourceKeyForFile(log);
  const a = runSkill(options(root, { skillId: 'A', args: ['interval', log, '90'], resourceKeys: [shared] }));
  const b = runSkill(options(root, { skillId: 'B', args: ['interval', log, '90'], resourceKeys: [shared] }));
  const c = runSkill(options(root, { skillId: 'A', args: ['interval', log, '90'], resourceKeys: [shared] }));
  const results = await Promise.all([a, b, c]);
  assert.ok(results.every(x => x.status === 'FINISHED' && x.exitCode === 0));
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  for (let i = 0; i < lines.length; i += 2) {
    assert.ok(lines[i].startsWith('start:'));
    assert.equal(lines[i].replace('start:', ''), lines[i + 1].replace('end:', ''));
  }
});
test('T06 failure in one child keeps the other child stdout/stderr and exit code intact', async (t) => {
  const root = sandbox(t);
  const [a, b] = await Promise.all([
    runSkill(options(root, { skillId: 'A', args: ['fail', 'x', 'y'] })),
    runSkill(options(root, { skillId: 'B', args: ['echo', 'arg', 'value'] }))
  ]);
  assert.equal(a.exitCode, 7);
  assert.equal(a.stderr.toString(), 'ERR_SYNTHETIC\n');
  assert.equal(b.exitCode, 0);
  assert.equal(b.stdout.toString(), 'OUT_SYNTHETIC\n');
});
test('T07 timeout with unconfirmed process preserves shared lock and blocks another task', async (t) => {
  if (process.platform === 'win32') { t.skip('requires Windows process-tree proof; unsafe to assume SIGTERM semantics'); return; }
  const root = sandbox(t);
  const shared = resourceKeyForBrowser('unknown-tree');
  const a = await runSkill(options(root, { skillId: 'A', args: ['ignore-term', 'x'],
    resourceKeys: [shared], timeoutMs: 160, stopGraceMs: 80, assumeNoDescendants: false }));
  assert.equal(a.status, 'RESOURCE_UNCERTAIN');
  const b = await assert.rejects(runSkill(options(root, { skillId: 'B', args: ['echo', 'x'],
    resourceKeys: [shared], lockWaitMs: 85, cleanupOwned: true })), e => e.code === 'ERESOURCE_BUSY');
  assert.equal(b, undefined);
  assert.ok(a.childPid > 0);
  try { process.kill(a.childPid, 'SIGKILL'); } catch { /* already gone */ }
  await new Promise(resolve => setTimeout(resolve, 60));
});
test('T09 / T10 classify scripts, keep args boundaries and do not alter authentication env', (t) => {
  const root = sandbox(t);
  const ps1 = path.join(root, 'safe.ps1'); fs.writeFileSync(ps1, '# synthetic\n');
  const cmd = path.join(root, 'safe.cmd'); fs.writeFileSync(cmd, '@echo off\n');
  const inspect = inspectReadOnly({ entry: ps1, cwd: root, args: ['中文 目录', 'quote"'] , platform: 'win32' });
  assert.equal(inspect.kind, 'ps1');
  assert.deepEqual(inspect.argv.slice(-2), ['中文 目录', 'quote"']);
  assert.throws(() => inspectReadOnly({ entry: cmd, cwd: root, platform: 'win32' }), e => e.code === 'EUNVERIFIED_CMD_BRIDGE');
  assert.throws(() => childEnvironment({ PATH: 'bad' }, 'synthetic01', root), e => e.code === 'EPROTECTED_ENV_OVERRIDE');
  assert.throws(() => childEnvironment({ APPDATA: 'bad' }, 'synthetic01', root), e => e.code === 'EPROTECTED_ENV_OVERRIDE');
  assert.equal(childEnvironment({ SYNTHETIC_MARK: 'okay' }, 'synthetic01', root).SYNTHETIC_MARK, 'okay');
});
test('T11 inspectReadOnly neither creates lock/state nor starts a subprocess', async (t) => {
  const root = sandbox(t);
  const before = fs.readdirSync(root);
  const info = inspectReadOnly({ entry: FIXTURE, cwd: root, args: ['--check'] });
  assert.equal(info.kind, 'node');
  assert.deepEqual(fs.readdirSync(root), before);
  await assert.rejects(runSkill(options(root, { args: ['--check'] })), e => e.code === 'ECHECK_REQUIRES_READONLY_PATH');
});
test('T13 same browser session serializes across Skill IDs; different sessions are distinct keys', async (t) => {
  const root = sandbox(t);
  const events = path.join(root, 'browser-events.txt'); fs.writeFileSync(events, '');
  const session = resourceKeyForBrowser('shared-cdp-synthetic');
  const x = runSkill(options(root, { skillId: 'First', args: ['interval', events, '70'], resourceKeys: [session] }));
  const y = runSkill(options(root, { skillId: 'Second', args: ['interval', events, '70'], resourceKeys: [session] }));
  const results = await Promise.all([x, y]);
  assert.ok(results.every(v => v.status === 'FINISHED'));
  const lines = fs.readFileSync(events, 'utf8').trim().split('\n');
  assert.equal(lines[0].replace('start:', ''), lines[1].replace('end:', ''));
  assert.equal(lines[2].replace('start:', ''), lines[3].replace('end:', ''));
});
test('T06 cancellation of A does not terminate independent B', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows child-stop verification not performed on this host'); return; }
  const root = sandbox(t);
  const aLog = path.join(root, 'A-log.txt'); fs.writeFileSync(aLog, '');
  const controller = new AbortController();
  const a = runSkill(options(root, { skillId: 'A', args: ['interval', aLog, '1200'],
    signal: controller.signal, resourceKeys: [resourceKeyForFile(aLog)], stopGraceMs: 400 }));
  await waitFor(() => fs.readFileSync(aLog, 'utf8').includes('start:'));
  const b = runSkill(options(root, { skillId: 'B', args: ['echo', 'value'],
    resourceKeys: [resourceKeyForBrowser('B-independent-session')] }));
  controller.abort();
  const [ar, br] = await Promise.all([a, b]);
  assert.equal(ar.status, 'CANCELLED');
  assert.equal(br.status, 'FINISHED');
  assert.equal(br.exitCode, 0);
  assert.equal(fs.readFileSync(aLog, 'utf8').includes('end:'), false);
});
test('T11 pre-aborted request does not create a run directory', async (t) => {
  const root = sandbox(t);
  const controller = new AbortController(); controller.abort();
  const before = fs.readdirSync(root);
  await assert.rejects(runSkill(options(root, { signal: controller.signal, args: ['echo', 'safe'] })), e => e.code === 'ECANCELLED');
  assert.deepEqual(fs.readdirSync(root), before);
});
