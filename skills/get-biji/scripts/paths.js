/**
 * 登录态、同步记录和笔记目录的设置都存在 skill 目录之外：重装或更新 skill 时，skill 目录会被整个换掉。
 * 位置：$GET_BIJI_HOME，默认 ~/.config/get-biji/
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.GET_BIJI_HOME || path.join(os.homedir(), '.config', 'get-biji');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

const STATE_FILES = {
    authState: path.join(STATE_DIR, 'auth-state.json'),
    tokenCache: path.join(STATE_DIR, 'token-cache.json'),
    syncState: path.join(STATE_DIR, 'sync-state.json'),
    transcriptLedger: path.join(STATE_DIR, 'link-transcript-ids.json'),
    refreshJournal: path.join(STATE_DIR, 'auth-refresh-journal.json'),
};

function readState(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeState(file, data) {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${require('crypto').randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    const stateParent = fs.openSync(path.dirname(STATE_DIR), 'r');
    try { fs.fsyncSync(stateParent); } finally { fs.closeSync(stateParent); }
}

/**
 * 笔记目录：带了 OUTPUT_DIR 就用它并记下来；没带就用上次记下的；都没有就报错，由 agent 去问用户。
 */
function resolveOutputDir() {
    const config = readState(CONFIG_FILE, {});
    let dir = process.env.OUTPUT_DIR;
    if (!dir) {
        if (config.outputDir) return config.outputDir;
        throw new Error(`No notes directory yet. Run once with OUTPUT_DIR="<absolute path>"; it is then remembered in ${CONFIG_FILE}`);
    }
    if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));
    if (!path.isAbsolute(dir)) throw new Error(`OUTPUT_DIR must be an absolute path, got: ${dir}`);
    if (config.outputDir !== dir) writeState(CONFIG_FILE, { ...config, outputDir: dir });
    return dir;
}

/** The writer itself owns the locked descriptor until release or process exit. */
async function acquireSyncLock(lockName = 'sync.lock') {
    if (!['sync.lock', 'auth.lock'].includes(lockName)) throw new Error('INVALID_LOCK_NAME');
    // Darwin open(2): O_EXLOCK=0x20, O_CLOEXEC=0x01000000 (xnu/bsd/sys/fcntl.h).
    // Node does not expose these constants. Never apply their numbers on another OS.
    if (process.platform !== 'darwin') throw new Error('SYNC_LOCK_UNSUPPORTED_PLATFORM');
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW | 0x20 | 0x01000000;
    let fd;
    try {
        fd = fs.openSync(path.join(STATE_DIR, lockName), flags, 0o600);
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

module.exports = { STATE_DIR, CONFIG_FILE, STATE_FILES, readState, writeState, resolveOutputDir, acquireSyncLock, lockProtocolVersion: 3 };
