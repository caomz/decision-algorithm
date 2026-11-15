#!/usr/bin/env node
'use strict';

// Read-only inventory. File selection and removal are deliberately not implemented.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function field(text, name) {
  const header = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header) return null;
  const match = header[1].match(new RegExp('^' + name + ':\\s*(.*?)\\s*$', 'm'));
  if (!match) return null;
  return match[1].replace(/^(["'])(.*)\1$/, '$2').trim() || null;
}

function inspect(notesDir) {
  if (!path.isAbsolute(notesDir)) throw new Error('notes directory must be an absolute path');
  if (fs.lstatSync(notesDir).isSymbolicLink()) throw new Error('symlink notes directory is not allowed');
  const root = fs.realpathSync(notesDir);
  if (!fs.statSync(root).isDirectory()) throw new Error('notes directory is not a directory');
  const groups = new Map();
  const skipped = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { skipped.push({ file, reason: 'symlink' }); continue; }
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile() || !file.endsWith('.md') || file.endsWith('_原文.md')) continue;
      if (stat.size > 8 * 1024 * 1024) { skipped.push({ file, reason: 'over_8_mib' }); continue; }
      const data = fs.readFileSync(file);
      const text = data.toString('utf8');
      const id = field(text, 'note_id');
      if (!id) continue;
      const transcript = field(text, 'transcript');
      let pair = null;
      if (transcript) {
        const target = path.resolve(path.dirname(file), transcript);
        const rel = path.relative(root, target);
        if (path.isAbsolute(transcript) || rel === '..' || rel.startsWith('..' + path.sep)) {
          pair = { declared: transcript, status: 'outside_notes_root' };
        } else {
          try {
            const pairedStat = fs.lstatSync(target);
            // Reject symlink ancestors as well as a symlink leaf.
            const canonical = fs.realpathSync(target);
            pair = { path: target, status: pairedStat.isSymbolicLink() || canonical !== target ? 'symlink' : pairedStat.isFile() ? 'present' : 'not_regular_file' };
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            pair = { path: target, status: 'missing' };
          }
        }
      }
      const item = { file, size: stat.size, mtime: stat.mtime.toISOString(), sha256: crypto.createHash('sha256').update(data).digest('hex'), transcript: pair };
      groups.set(id, [...(groups.get(id) || []), item]);
    }
  }
  walk(root);
  return { schema: 'get-biji.dedupe-plan.v1', mode: 'read_only', root, duplicates: [...groups].filter(([, entries]) => entries.length > 1).map(([note_id, files]) => ({ note_id, files, decision: 'manual_review_required' })), skipped, files_deleted: 0 };
}

function main(argv) {
  let notesDir = process.env.OUTPUT_DIR || '';
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node dedupe.js --notes-dir /absolute/notes [--output /new/plan.json]\nRead-only duplicate inventory; no delete/apply mode. OUTPUT_DIR may supply the directory without changing configuration.');
      return;
    }
    if (arg === '--notes-dir' || arg === '--output') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a path');
      if (arg === '--notes-dir') notesDir = value; else output = value;
    } else if (arg !== '--dry-run' && arg !== '--json') throw new Error('unsupported argument: ' + arg);
  }
  if (!notesDir) throw new Error('--notes-dir is required (or explicit OUTPUT_DIR); no private configuration is read');
  if (output && !path.isAbsolute(output)) throw new Error('--output must be an absolute new path');
  const result = inspect(notesDir);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (output) fs.writeFileSync(output, json, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(json);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error('Dedupe inventory failed: ' + error.message); process.exitCode = 1; }
}
module.exports = { inspect, field };
