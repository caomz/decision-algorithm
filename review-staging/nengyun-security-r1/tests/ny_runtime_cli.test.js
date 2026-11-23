'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const CLI = path.join(__dirname, '../scripts/ny_runtime_cli.js');
const FIXTURE = path.join(__dirname, 'fixtures/runtime_worker.js');
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-cli-synthetic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function invoke(root, subcommand, spec) {
  const config = path.join(root, 'runtime-spec.json');
  fs.writeFileSync(config, JSON.stringify(spec));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, subcommand, '--spec', config], { shell: false, cwd: root });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    child.stdout.on('data', b => stdout = Buffer.concat([stdout, b]));
    child.stderr.on('data', b => stderr = Buffer.concat([stderr, b]));
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
test('T10 optional CLI preserves child stdout, stderr and original exit 7', async t => {
  const root = sandbox(t);
  const spec = { skillId: 'Synthetic', entry: FIXTURE, cwd: root, runRoot: root, lockRoot: root,
    resources: [], args: ['fail', 'x'] };
  const out = await invoke(root, 'run', spec);
  assert.equal(out.code, 7);
  assert.equal(out.stdout.toString(), '');
  assert.equal(out.stderr.toString(), 'ERR_SYNTHETIC\n');
});
test('T11 CLI inspect does not create runDir or locks', async t => {
  const root = sandbox(t);
  const spec = { skillId: 'Synthetic', entry: FIXTURE, cwd: root, runRoot: root, lockRoot: root,
    resources: [], args: ['--check'] };
  const out = await invoke(root, 'inspect', spec);
  assert.equal(out.code, 0);
  assert.deepEqual(fs.readdirSync(root), ['runtime-spec.json']);
  assert.deepEqual(JSON.parse(out.stdout.toString()), { kind: 'node', status: 'INSPECTED_ONLY' });
  const blocked = await invoke(root, 'run', spec);
  assert.equal(blocked.code, 125);
  assert.match(blocked.stderr.toString(), /ECHECK_REQUIRES_READONLY_PATH/);
});
