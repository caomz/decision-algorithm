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
 *   holder 文件在临界区结束或进程退出后被回收；持有者进程崩溃留下的
 *   残留由 PID 存活检测判定为陈旧并接管。
 *
 * 两种后端都保证：
 * - 互斥：同一时刻只有一个进程持有同一个锁；
 * - 忙时快速失败：抛 `SYNC_LOCK_BUSY`（定时任务依赖这个错误码）；
 * - 锁路径不被删除或替换（canonical 锁文件永久保留，运行中只读不换）；
 * - 不防御「同一用户恶意替换锁路径」——SKILL.md 明确不覆盖这个场景。
 */

const fs = require('fs');
const path = require('path');

const LOCK_NAMES = new Set(['sync.lock', 'auth.lock']);

/** holder 文件读不出 PID 且超过这个时长，判定为陈旧。 */
const UNREADABLE_STALE_MS = 30 * 60 * 1000;
/** 持有者 PID 仍存活但持锁超过这个时长，判定为陈旧（兜底 PID 复用）。 */
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
 * 判断 holder 是否陈旧，可以被接管。
 * 返回 false 表示「还锁着」或「状态读不准，不敢动」。
 */
function reclaimableHolder(holderPath) {
    let before;
    let content;
    try {
        before = fs.statSync(holderPath);
        content = fs.readFileSync(holderPath, 'utf8');
    } catch {
        // holder 已经没了：让调用方重试一次抢占。
        return true;
    }

    let pid = null;
    try {
        const parsed = JSON.parse(content);
        if (Number.isInteger(parsed.pid)) pid = parsed.pid;
    } catch {
        pid = null;
    }

    const age = Date.now() - before.mtimeMs;
    if (pid === null) {
        // 读不出持有者：只在放够久之后才敢接管，避免抢掉刚写的 holder。
        return age > UNREADABLE_STALE_MS;
    }
    if (!pidAlive(pid)) return true;
    // PID 还活着：只有持锁时长异常长才接管（兜底 PID 复用）。
    return age > LIVE_TOO_OLD_MS;
}

/**
 * 可移植独占锁：原子创建 holder 文件即拿到锁。
 */
function acquirePortableExclusive(lockPath) {
    const holderPath = `${lockPath}.holder`;

    // canonical 锁文件永久保留，只创建不删除、不替换。
    fs.closeSync(fs.openSync(lockPath, 'a', 0o600));

    for (let round = 0; round < 3; round++) {
        let fd;
        try {
            fd = fs.openSync(holderPath, 'wx', 0o600);
        } catch (cause) {
            if (cause.code !== 'EEXIST') throw cause;
            if (!reclaimableHolder(holderPath)) throw new Error('SYNC_LOCK_BUSY');
            // 陈旧 holder：先确认它没被别人换掉，再删掉重试。
            try {
                fs.unlinkSync(holderPath);
            } catch {
                throw new Error('SYNC_LOCK_BUSY');
            }
            continue;
        }

        try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), 'utf8');
            fs.fsyncSync(fd);
        } catch (cause) {
            fs.closeSync(fd);
            try { fs.unlinkSync(holderPath); } catch { /* ignore */ }
            throw cause;
        }

        let released = false;
        return () => {
            if (released) return;
            released = true;
            fs.closeSync(fd);
            try { fs.unlinkSync(holderPath); } catch { /* 已被接管，忽略 */ }
        };
    }

    throw new Error('SYNC_LOCK_BUSY');
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
