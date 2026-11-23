'use strict';

/**
 * 跨平台进程锁。
 *
 * 两套后端，同一套对外语义：
 *
 * - `posix-exlock`（macOS）：用 Darwin open(2) 的 O_EXLOCK，锁由内核持有，
 *   进程退出自动释放。锁文件本身保留在磁盘上。
 * - `portable-exclusive`（Windows / Linux）：Node 没有暴露 flock/O_EXLOCK，
 *   改用「原子独占创建 holder 文件 + 持有者 PID」实现互斥。
 *   正常释放只清除自己的 holder；进程崩溃的 holder 不自动接管。
 *   基于锁龄或 PID 读后删除的自动接管无法保证两个写者互斥。
 *
 * 两种后端都保证：
 * - 互斥：同一时刻只有一个进程持有同一个锁；
 * - 忙时快速失败：抛 `SYNC_LOCK_BUSY`（定时任务依赖这个错误码）；
 * - 锁路径不被删除或替换（canonical 锁文件永久保留，运行中只读不换）；
 * - 不防御「同一用户恶意替换锁路径」——SKILL.md 明确不覆盖这个场景。
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const LOCK_NAMES = new Set(['sync.lock', 'auth.lock']);

/** 保留历史导出；portable 后端不按此时间接管。 */
const UNREADABLE_STALE_MS = 30 * 60 * 1000;
/** 保留历史导出；活锁永远不得按锁龄夺取。 */
const LIVE_TOO_OLD_MS = 2 * 60 * 60 * 1000;

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

/**
 * 选后端。返回 null 表示该平台没有可用实现。
 */
function selectBackend(platform = process.platform) {
    if (platform === 'darwin') return 'posix-exlock';
    if (SUPPORTED_PLATFORMS.has(platform)) return 'portable-exclusive';
    return null;
}

/**
 * 进程是否还活着。EPERM 表示活着但不属于当前用户，同样算活着。
 */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

/**
 * Darwin open(2): O_EXLOCK=0x20, O_CLOEXEC=0x01000000 (xnu/bsd/sys/fcntl.h)。
 * Node 不暴露这两个常量，只在 darwin 上用它们的数值，其他平台绝不套用。
 */
function acquirePosixExlock(lockPath) {
    const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW | 0x20 | 0x01000000;
    let fd;
    try {
        fd = fs.openSync(lockPath, flags, 0o600);
        if (!fs.fstatSync(fd).isFile()) throw new Error('SYNC_LOCK_FILE_INVALID');
    } catch (cause) {
        if (fd !== undefined) fs.closeSync(fd);
        if (['EAGAIN', 'EWOULDBLOCK'].includes(cause.code)) throw new Error('SYNC_LOCK_BUSY');
        throw cause;
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        fs.closeSync(fd);
    };
}

/**
 * 可移植独占锁：原子创建 holder 文件即拿到锁。
 */
function acquirePortableExclusive(lockPath) {
    const holderPath = `${lockPath}.holder`;
    fs.closeSync(fs.openSync(lockPath, 'a', 0o600));
    let fd;
    try {
        fd = fs.openSync(holderPath, 'wx', 0o600);
    } catch (cause) {
        if (cause.code === 'EEXIST') throw new Error('SYNC_LOCK_BUSY');
        throw cause;
    }

    const owner = randomUUID();
    try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), owner }), 'utf8');
        fs.fsyncSync(fd);
    } catch (cause) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(holderPath); } catch {}
        throw cause;
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        let held;
        try { held = fs.fstatSync(fd); } catch {}
        try { fs.closeSync(fd); } catch {}
        // A mismatch means the previous holder is no longer ours: do not unlink.
        // This does not claim to be an atomic CAS against a malicious local swap.
        try {
            const current = fs.statSync(holderPath);
            if (!held || current.dev !== held.dev || current.ino !== held.ino) return;
            const record = JSON.parse(fs.readFileSync(holderPath, 'utf8'));
            if (record.owner !== owner || record.pid !== process.pid) return;
            fs.unlinkSync(holderPath);
        } catch { /* Unknown identity: leave the holder for manual review. */ }
    };
}

/**
 * 拿一把命名锁。返回 release 函数，调用后释放。
 * @param {{stateDir: string, lockName?: string, platform?: string}} options
 */
function acquireLock({ stateDir, lockName = 'sync.lock', platform = process.platform }) {
    if (!LOCK_NAMES.has(lockName)) throw new Error('INVALID_LOCK_NAME');
    const backend = selectBackend(platform);
    if (!backend) throw new Error('SYNC_LOCK_UNSUPPORTED_PLATFORM');

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(stateDir, lockName);

    return backend === 'posix-exlock'
        ? acquirePosixExlock(lockPath)
        : acquirePortableExclusive(lockPath);
}

module.exports = {
    acquireLock,
    selectBackend,
    pidAlive,
    LOCK_NAMES,
    SUPPORTED_PLATFORMS,
    UNREADABLE_STALE_MS,
    LIVE_TOO_OLD_MS,
};
