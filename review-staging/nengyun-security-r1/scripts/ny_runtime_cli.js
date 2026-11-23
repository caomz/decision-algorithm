'use strict';
// Optional, standalone CLI entry. Do not point it at production without an
// independently approved resource map and an actual Windows compatibility run.
const fs = require('node:fs');
const path = require('node:path');
const { runSkill, inspectReadOnly } = require('./ny_windows_runtime');
const { resourceKeyForFile, resourceKeyForBrowser } = require('./ny_runtime_resources');
function readSpec(file) {
  if (typeof file !== 'string' || !file) throw new Error('EINVALID_SPEC_PATH');
  const data = fs.readFileSync(file);
  if (data.length > 65536) throw new Error('ESPEC_TOO_LARGE');
  const spec = JSON.parse(data.toString('utf8'));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('EINVALID_SPEC');
  const allowed = new Set(['skillId', 'entry', 'cwd', 'args', 'env', 'resources', 'lockRoot', 'runRoot',
    'timeoutMs', 'lockWaitMs', 'stopGraceMs', 'assumeNoDescendants']);
  if (Object.keys(spec).some(k => !allowed.has(k))) throw new Error('EUNRECOGNIZED_SPEC_FIELD');
  if (!Array.isArray(spec.resources)) throw new Error('ERESOURCE_MAP_REQUIRED');
  const resourceKeys = spec.resources.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('EINVALID_RESOURCE');
    if (item.type === 'file' && Object.keys(item).sort().join() === 'path,type') return resourceKeyForFile(item.path);
    if (item.type === 'browser' && Object.keys(item).sort().join() === 'sessionId,type') return resourceKeyForBrowser(item.sessionId);
    throw new Error('EINVALID_RESOURCE');
  });
  return { ...spec, resourceKeys };
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || !['run', 'inspect'].includes(argv[0]) || argv[1] !== '--spec') {
    process.stderr.write('EUSAGE\n'); return 125;
  }
  let spec;
  try { spec = readSpec(path.resolve(argv[2])); }
  catch (e) { process.stderr.write((/^E[A-Z_]+$/.test(e.code || e.message) ? e.code || e.message : 'EINVALID_SPEC') + '\n'); return 125; }
  if (argv[0] === 'inspect') {
    // A metadata-only preflight. Does NOT initialize run directories or child processes.
    try { const info = inspectReadOnly(spec); process.stdout.write(JSON.stringify({ kind: info.kind, status: 'INSPECTED_ONLY' }) + '\n'); return 0; }
    catch (e) { process.stderr.write((e.code || 'EINSPECT_FAILED') + '\n'); return 125; }
  }
  if (spec.args?.includes('--check')) { process.stderr.write('ECHECK_REQUIRES_READONLY_PATH\n'); return 125; }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await runSkill({ ...spec, signal: controller.signal });
    // Original business streams are passed as bytes, without injected diagnostics.
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status === 'FINISHED') return result.exitCode === null ? 125 : result.exitCode;
    process.stderr.write('ERUNTIME_' + result.status + '\n');
    return 125;
  } catch (e) {
    process.stderr.write((e.code || 'ERUNTIME_FAILED') + '\n');
    return 125;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
if (require.main === module) {
  main().then(code => { process.exitCode = code; }, () => { process.stderr.write('ERUNTIME_FAILED\n'); process.exitCode = 125; });
}
module.exports = { main, readSpec };
