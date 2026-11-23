'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const FIXTURE = path.join(__dirname, 'fixtures', 'resource_lock_worker.js');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-realproc-lock-'));
  fs.writeFileSync(path.join(root, 'os-process-log.txt'), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function worker(root, session, mode, duration) {
  const child = spawn(process.execPath, [FIXTURE, root, session, mode, String(duration)], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: root
  });
  const done = new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', x => stderr += x.toString());
    child.once('error', reject);
    child.once('close', code => resolve({ pid: child.pid, code, stderr }));
  });
  return { child, done };
}
async function until(predicate) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  throw new Error('synthetic multi-process barrier not reached');
}
test('T03 independent OS processes serialize one browser session lock', async t => {
  const root = setup(t);
  const a = worker(root, 'shared-session', 'hold', 110);
  const b = worker(root, 'shared-session', 'hold', 110);
  const results = await Promise.all([a.done, b.done]);
  assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
  assert.notEqual(results[0].pid, results[1].pid);
  const lines = fs.readFileSync(path.join(root, 'os-process-log.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0].replace('start:', ''), lines[1].replace('end:', ''));
  assert.equal(lines[2].replace('start:', ''), lines[3].replace('end:', ''));
});
test('T02 independent OS processes with distinct session keys both enter before release', async t => {
  const root = setup(t);
  const a = worker(root, 'session-one', 'barrier', 0);
  const b = worker(root, 'session-two', 'barrier', 0);
  try {
    await until(() => fs.readdirSync(root).filter(x => x.startsWith('ready-')).length === 2);
  } finally { fs.writeFileSync(path.join(root, 'release'), 'go'); }
  const results = await Promise.all([a.done, b.done]);
  assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
  assert.notEqual(results[0].pid, results[1].pid);
});
