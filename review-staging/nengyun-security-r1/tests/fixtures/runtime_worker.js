'use strict';
// Synthetic subprocess fixture: no browser, network, credentials, or global cleanup.
const fs = require('node:fs');
const path = require('node:path');
const [mode, file, delay = '80', ...more] = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  if (mode === 'echo') {
    const body = {
      cwd: process.cwd(), args: [file, delay, ...more],
      syntheticEnv: process.env.SYNTHETIC_MARK || null,
      runId: process.env.NY_SKILL_RUN_ID || null,
      runDir: process.env.NY_SKILL_RUN_DIR || null
    };
    fs.writeFileSync(path.join(body.runDir, 'result.json'), JSON.stringify(body));
    process.stdout.write('OUT_SYNTHETIC\n');
    process.stderr.write('ERR_SYNTHETIC\n');
  } else if (mode === 'interval') {
    fs.appendFileSync(file, 'start:' + process.env.NY_SKILL_RUN_ID + '\n');
    await sleep(Number(delay));
    fs.appendFileSync(file, 'end:' + process.env.NY_SKILL_RUN_ID + '\n');
    process.stdout.write('DONE\n');
  } else if (mode === 'barrier') {
    const signalFile = path.join(file, 'in-' + process.env.NY_SKILL_RUN_ID);
    fs.writeFileSync(signalFile, 'ready');
    const until = Date.now() + 4000;
    while (!fs.existsSync(path.join(file, 'release')) && Date.now() < until) await sleep(12);
    process.stdout.write('BARRIER_DONE\n');
  } else if (mode === 'ignore-term') {
    process.on('SIGTERM', () => {});
    process.stdout.write('READY\n');
    setInterval(() => {}, 1000);
  } else if (mode === 'fail') {
    process.stderr.write('ERR_SYNTHETIC\n');
    process.exitCode = 7;
  } else {
    process.exitCode = 9;
  }
})().catch(() => { process.exitCode = 8; });
