'use strict';
// Real OS-process lock fixture, synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const { acquireResources, resourceKeyForBrowser } = require('../../scripts/ny_runtime_resources');
const [root, session, mode, duration = '90'] = process.argv.slice(2);
const key = resourceKeyForBrowser(session);
(async () => {
  const lease = await acquireResources([key], { lockRoot: root, waitMs: 2500 });
  try {
    fs.appendFileSync(path.join(root, 'os-process-log.txt'), 'start:' + process.pid + ':' + session + '\n');
    if (mode === 'barrier') {
      fs.writeFileSync(path.join(root, 'ready-' + process.pid), 'ready');
      const deadline = Date.now() + 2500;
      while (!fs.existsSync(path.join(root, 'release')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, Number(duration)));
    }
    fs.appendFileSync(path.join(root, 'os-process-log.txt'), 'end:' + process.pid + ':' + session + '\n');
  } finally { lease.release(); }
})().catch(error => {
  process.stderr.write((error.code || 'EWORKER') + '\n');
  process.exitCode = 2;
});
