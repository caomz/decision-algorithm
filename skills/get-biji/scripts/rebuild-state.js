#!/usr/bin/env node

/**
 * Rebuild sync state from the notes already on disk.
 * Notes found in the notes directory are marked as synced; the rest are left for the next sync.js run.
 * Use it when the sync state is lost (new machine, deleted ~/.config/get-biji) but the notes directory is intact.
 */

const fs = require('fs');
const path = require('path');
const { fetchAllNotes, saveSyncState } = require('./api');
const { noteBaseName } = require('./format');
const { resolveOutputDir } = require('./paths');

/**
 * Whether the sync stage wrote a summary file for `baseName` in this date
 * directory: `<baseName>.md`, or `<baseName>_<n>.md` when a same-day name
 * collision made sync.js append a counter. Transcript files (`<baseName>_原文.md`)
 * never count — they carry no frontmatter note identity of their own.
 */
function summaryFileExists(files, baseName) {
    if (files.has(`${baseName}.md`)) return true;
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const counterSuffix = new RegExp(`^${escaped}_\\d+\\.md$`);
    for (const file of files) {
        if (counterSuffix.test(file)) return true;
    }
    return false;
}

async function main() {
    const outputDir = resolveOutputDir();
    console.log(`🔄 Rebuilding sync state from ${outputDir}...\n`);

    const allNotes = await fetchAllNotes();
    const onDisk = [];
    const missing = [];
    // File names come from the same rule sync.js saves with (format.noteBaseName),
    // so rebuild sees exactly the files the parse stage wrote.
    const dateDirFiles = new Map();

    for (const note of allNotes) {
        const dateStr = (note.created_at || '').split(' ')[0] || 'unknown-date';
        if (!dateDirFiles.has(dateStr)) {
            const dateDir = path.join(outputDir, dateStr);
            dateDirFiles.set(dateStr, fs.existsSync(dateDir) ? new Set(fs.readdirSync(dateDir)) : new Set());
        }
        const baseName = noteBaseName(note);
        (summaryFileExists(dateDirFiles.get(dateStr), baseName) ? onDisk : missing).push(note);
    }

    saveSyncState({
        outputDir,
        fullSyncAt: missing.length === 0 ? new Date().toISOString() : undefined,
        syncedIds: onDisk.map(n => n.note_id),
        lastSyncTime: new Date().toISOString(),
    });

    console.log(`📊 Notes in Get: ${allNotes.length}`);
    console.log(`   On disk (marked as synced): ${onDisk.length}`);
    console.log(`   Missing (next sync.js run fetches them): ${missing.length}`);
}

module.exports = { summaryFileExists, main };

if (require.main === module) {
    main().catch(e => {
        console.error(`❌ ${e.message}`);
        process.exit(1);
    });
}
