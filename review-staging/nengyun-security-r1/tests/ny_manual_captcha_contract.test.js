'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runManualCaptcha } = require('../scripts/ny_manual_captcha_contract');
function callbacks() {
  let stage = 'challenge-A', requests = 0;
  return {
    waitCooldown: async () => undefined,
    challengeId: async () => stage,
    capture: async () => Buffer.from('SYNTHETIC_IMAGE'),
    getAnswer: async () => 'ABCD',
    fill: async () => undefined,
    requestSms: async () => { requests++; },
    observeResult: async () => 'accepted',
    setStage: x => { stage = x; },
    requests: () => requests
  };
}
test('manual path returns accepted only after observed server acceptance', async () => {
  const c = callbacks();
  const { setStage, requests, ...api } = c;
  const result = await runManualCaptcha(api);
  assert.equal(result.status, 'accepted');
  assert.equal(requests(), 1);
});
test('challenge changes before submit -> no SMS request', async () => {
  const c = callbacks();
  c.getAnswer = async () => { c.setStage('challenge-B'); return 'ABCD'; };
  const { setStage, requests, ...api } = c;
  await assert.rejects(runManualCaptcha(api), e => e.code === 'ECHALLENGE_CHANGED');
  assert.equal(requests(), 0);
});
test('pre-aborted signal never enters browser flow', async () => {
  const c = callbacks(); const controller = new AbortController(); controller.abort();
  const { setStage, requests, ...api } = c;
  await assert.rejects(runManualCaptcha({ ...api, signal: controller.signal }), e => e.code === 'ECANCELLED');
  assert.equal(requests(), 0);
});
