'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { publishSms } = require('../scripts/ny_sms_state');
const MODULE = path.resolve(__dirname, '../scripts/ny_sms_state.js');
const NOW = 1795400000000;
function worker(file, attemptId) {
  return new Promise((resolve, reject) => {
    // No real production credentials or secret values in command-line arguments.
    const code = `const m=require(${JSON.stringify(MODULE)});try{m.claimSms(process.env.CARRIER,{requestId:'req-test-01',attemptId:process.env.ATTEMPT,now:${NOW}});process.stdout.write('CLAIMED');}catch(e){process.stdout.write(e.code||'UNKNOWN');}`;
    const child = spawn(process.execPath, ['-e', code], {
      env: { ...process.env, CARRIER: file, ATTEMPT: attemptId }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(stdout.trim()));
  });
}
test('two separate processes cannot both claim a shared SMS record', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.local.json');
  fs.writeFileSync(file, JSON.stringify({ environments: { prod: {} } }));
  publishSms(file, { code: '864201', sourceMessageId: 'msg-one', requestId: 'req-test-01',
    messageCreatedAt: NOW - 1000, expiresAt: NOW + 30000 }, { now: NOW, maxLifetimeMs: 60000 });
  const results = await Promise.all([worker(file, 'attempt-one'), worker(file, 'attempt-two')]);
  assert.equal(results.filter(x => x === 'CLAIMED').length, 1);
  assert.equal(results.length, 2);
  assert.equal(results.filter(x => x !== 'CLAIMED').length, 1);
  assert.ok(['ENOT_FRESH', 'ELOCKED'].includes(results.find(x => x !== 'CLAIMED')));
});
