'use strict';
/**
 * 跨平台锁的回归测试。
 *
 * 关键性质：
 * - 互斥：同一时刻只有一个持有者；
 * - 忙时快速失败：错误码必须是 SYNC_LOCK_BUSY（定时任务依赖它）；
 * - 释放干净：释放后 holder 消失，canonical 锁文件保留；
 * - 崩溃默认拒绝自动接管：残留 holder 需要外部核验；
 * - 活着的持有者不会被抢。
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync, execFileSync} = require('node:child_process');
const {acquireLock, selectBackend, pidAlive} = require('../scripts/lock.js');

const LOCK_PATH = path.resolve(__dirname, '../scripts/lock.js');
const tmp = name => fs.mkdtempSync(path.join(process.env.TEST_ARTIFACT_ROOT || os.tmpdir(), name));

test('backend selection maps platforms and rejects the unknown', () => {
    assert.equal(selectBackend('darwin'), 'posix-exlock');
    assert.equal(selectBackend('win32'), 'portable-exclusive');
    assert.equal(selectBackend('linux'), 'portable-exclusive');
    assert.equal(selectBackend('sunos'), null);
});

test('invalid lock name and unsupported platform fail closed', () => {
    const dir = tmp('lock-invalid-');
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'evil.lock'}), /INVALID_LOCK_NAME/);
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'sunos'}),
        /SYNC_LOCK_UNSUPPORTED_PLATFORM/);
});

test('portable lock is exclusive, releases cleanly, and keeps the canonical file', () => {
    const dir = tmp('lock-portable-');
    const release = acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'});

    const holder = path.join(dir, 'sync.lock.holder');
    assert.ok(fs.existsSync(holder), 'holder exists while locked');
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'}),
        /SYNC_LOCK_BUSY/);

    release();
    assert.ok(!fs.existsSync(holder), 'holder removed on release');
    assert.ok(fs.existsSync(path.join(dir, 'sync.lock')), 'canonical lock file is kept');

    const again = acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'});
    again();
});

test('a live holder is never reclaimed', () => {
    const dir = tmp('lock-live-');
    const release = acquireLock({stateDir: dir, lockName: 'auth.lock', platform: 'win32'});
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'auth.lock', platform: 'win32'}),
        /SYNC_LOCK_BUSY/);
    release();
});

test('a dead holder is still busy without safe atomic takeover', () => {
    const dir = tmp('lock-stale-');
    const holder = path.join(dir, 'sync.lock.holder');
    fs.writeFileSync(holder, JSON.stringify({pid: 999999, acquiredAt: Date.now()}), 'utf8');
    assert.equal(pidAlive(999999), false);
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'}),
        /SYNC_LOCK_BUSY/);
});

test('an unreadable but fresh holder is left alone', () => {
    const dir = tmp('lock-garbage-');
    fs.writeFileSync(path.join(dir, 'sync.lock.holder'), 'not json', 'utf8');
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'}),
        /SYNC_LOCK_BUSY/);
});

test('two separate processes cannot hold the same lock', () => {
    const dir = tmp('lock-xproc-');
    const holder = path.join(dir, 'sync.lock.holder');
    fs.writeFileSync(holder, JSON.stringify({pid: process.pid, acquiredAt: Date.now()}), 'utf8');

    // A separate node process must see the lock as busy.
    const out = spawnSync(process.execPath, ['-e', `
        const {acquireLock} = require(${JSON.stringify(LOCK_PATH)});
        try { acquireLock({stateDir: ${JSON.stringify(dir)}, lockName: 'sync.lock', platform: 'win32'}); }
        catch (e) { process.stdout.write(e.message); }
    `], {encoding: 'utf8'});

    assert.equal(out.stdout, 'SYNC_LOCK_BUSY');
});

test('the darwin backend is exclusive and releases on demand', {skip: process.platform !== 'darwin'}, () => {
    const dir = tmp('lock-darwin-');
    const release = acquireLock({stateDir: dir, lockName: 'sync.lock'});
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock'}), /SYNC_LOCK_BUSY/);
    release();
    const again = acquireLock({stateDir: dir, lockName: 'sync.lock'});
    again();
});

test('crashed holder does not get stolen automatically', () => {
    const dir = tmp('lock-crash-');
    const child = spawnSync(process.execPath, ['-e', `
        const {acquireLock} = require(${JSON.stringify(LOCK_PATH)});
        acquireLock({stateDir: ${JSON.stringify(dir)}, lockName: 'sync.lock', platform: 'win32'});
        process.exit(0);
    `], {encoding: 'utf8'});
    assert.equal(child.status, 0);
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'}),
        /SYNC_LOCK_BUSY/);
});

test('two-hour boundary and clock jump do not steal a live lock', () => {
    const dir = tmp('lock-old-live-');
    const release = acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'});
    const holder = path.join(dir, 'sync.lock.holder');
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000);
    fs.utimesSync(holder, old, old);
    assert.throws(() => acquireLock({stateDir: dir, lockName: 'sync.lock', platform: 'win32'}),
        /SYNC_LOCK_BUSY/);
    release();
    assert.ok(!fs.existsSync(holder));
});

test('release does not remove an owner-mismatched holder', () => {
    const dir = tmp('lock-owner-');
    const release = acquireLock({stateDir: dir, lockName: 'auth.lock', platform: 'win32'});
    const holder = path.join(dir, 'auth.lock.holder');
    const swapped = JSON.parse(fs.readFileSync(holder, 'utf8'));
    swapped.owner = 'synthetic-another-owner';
    fs.writeFileSync(holder, JSON.stringify(swapped));
    release();
    assert.ok(fs.existsSync(holder));
});
