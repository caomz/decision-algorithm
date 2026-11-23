'use strict';
// Composable, offline-testable manual path. Caller must provide real browser adapters.
// The INPUT wait is time-limited; all other injected steps must be abort-aware.
class ManualCaptchaError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'ManualCaptchaError'; }
}
function assertCallback(callback, name) {
  if (typeof callback !== 'function') throw new ManualCaptchaError('EMISSING_' + name.toUpperCase());
}
async function runManualCaptcha({
  waitCooldown, challengeId, capture, getAnswer, fill, requestSms, observeResult,
  timeoutMs = 120000, signal
} = {}) {
  for (const [name, callback] of Object.entries({ waitCooldown, challengeId, capture, getAnswer, fill, requestSms, observeResult })) {
    assertCallback(callback, name);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new ManualCaptchaError('EINVALID_TIMEOUT');
  if (signal?.aborted) throw new ManualCaptchaError('ECANCELLED');
  // Never automatically re-request SMS following timeout/error/unknown response.
  await waitCooldown({ signal });
  if (signal?.aborted) throw new ManualCaptchaError('ECANCELLED');
  const initial = await challengeId({ signal });
  if (!initial) throw new ManualCaptchaError('ECHALLENGE_MISSING');
  const image = await capture({ signal });
  let timer;
  let abortHandler;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ManualCaptchaError('EINPUT_TIMEOUT')), timeoutMs);
  });
  const abort = new Promise((_, reject) => {
    abortHandler = () => reject(new ManualCaptchaError('ECANCELLED'));
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  let timedAnswer;
  try {
    timedAnswer = await Promise.race([Promise.resolve().then(() => getAnswer({ image, signal })), timeout, abort]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortHandler);
  }
  if (signal?.aborted) throw new ManualCaptchaError('ECANCELLED');
  if (typeof timedAnswer !== 'string' || !/^[a-zA-Z0-9]{1,12}$/.test(timedAnswer)) throw new ManualCaptchaError('EINVALID_ANSWER');
  if (await challengeId({ signal }) !== initial) throw new ManualCaptchaError('ECHALLENGE_CHANGED');
  await fill({ answer: timedAnswer, signal });
  if (signal?.aborted || await challengeId({ signal }) !== initial) throw new ManualCaptchaError('ECHALLENGE_CHANGED');
  await requestSms({ signal });
  const result = await observeResult({ signal });
  if (result !== 'accepted') throw new ManualCaptchaError(result === 'rejected' ? 'ESMS_REQUEST_REJECTED' : 'ESMS_REQUEST_UNKNOWN');
  return { status: 'accepted' };
}
module.exports = { runManualCaptcha, ManualCaptchaError };
