#!/usr/bin/env node

/**
 * Get Notes API Client
 * Auth chain: cached JWT → refresh_token (90d) → Playwright browser login
 * Logs go to stderr so that callers' stdout stays clean.
 */

const fs = require('fs');
const { STATE_FILES, readState, writeState, acquireSyncLock, lockProtocolVersion, lockBackend } = require('./paths');

const OFFICIAL_BASE = 'https://openapi.biji.com/open/api/v1';

const CONFIG = {
    baseUrl: 'https://get-notes.luojilab.com',
    authApiUrl: 'https://notes-api.biji.com',
    loginUrl: 'https://www.biji.com/note',
    refreshEndpoint: '/account/v2/web/user/auth/refresh',
    listEndpoint: '/voicenotes/web/notes',
    detailEndpoint: '/voicenotes/web/notes/',
    originalEndpoint: '/voicenotes/web/notes/',
    pageSize: 20,
    delayMs: 500,

    authStateFile: STATE_FILES.authState,
    tokenCacheFile: STATE_FILES.tokenCache,
    syncStateFile: STATE_FILES.syncState,

    loginTimeoutMs: 10 * 60 * 1000,
};

// Cron must never open a login window or wait indefinitely on an HTTP request.
async function request(url, options = {}, retries = 2) {
    for (let attempt = 0; ; attempt++) {
        let response;
        try {
            response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        } catch (error) {
            if (attempt >= retries) throw error;
            await delay(1000 * (attempt + 1));
            continue;
        }
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new Error('HTTP_REDIRECT_REJECTED');
        }
        if (![429, 500, 502, 503, 504, 529].includes(response.status) || attempt >= retries) return response;
        const retryAfter = Math.min(30, Math.max(1, Number(response.headers.get('retry-after')) || (attempt + 1) * 2));
        await response.body?.cancel();
        await delay(retryAfter * 1000);
    }
}

// In-process JWT and its expiry (unix seconds; 0 = unknown)
let token = null;
let tokenExpireAt = 0;

function useToken(t, expireAt) {
    token = t;
    tokenExpireAt = expireAt ? Number(expireAt) : 0;
    return token;
}

function loadTokenCache() {
    return readState(CONFIG.tokenCacheFile, null);
}

function loadRefreshJournal() {
    const file = STATE_FILES.refreshJournal;
    if (!fs.existsSync(file)) return null;
    // Windows ignores POSIX mode bits (every file reports 0666), so the group/other
    // check would always fail there. Keep the symlink check on every platform.
    if (fs.lstatSync(file).isSymbolicLink() || (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077))) throw new Error('AUTH_FILE_PERMISSIONS_UNSAFE');
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('AUTH_REFRESH_JOURNAL_INVALID'); }
    if (!value || !['requesting', 'received', 'committed'].includes(value.status)) throw new Error('AUTH_REFRESH_JOURNAL_INVALID');
    return value;
}

function saveTokenCache(data) {
    writeState(CONFIG.tokenCacheFile, {
        token: data.token,
        tokenExpireAt: data.tokenExpireAt || null,
        refreshToken: data.refreshToken || null,
        refreshTokenExpireAt: data.refreshTokenExpireAt || null,
        savedAt: new Date().toISOString(),
    });
}

/**
 * Try silent refresh using refresh_token (valid ~90 days).
 * Returns new JWT or null on failure.
 */
async function silentRefresh(refreshToken) {
    const journal = { status: 'requesting', operation_id: require('crypto').randomUUID() };
    writeState(STATE_FILES.refreshJournal, journal);
    try {
        const url = `${CONFIG.authApiUrl}${CONFIG.refreshEndpoint}`;
        const res = await request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }),
        }, 0);
        if ([401, 403].includes(res.status)) {
            writeState(STATE_FILES.refreshJournal, { ...journal, status: 'committed', outcome: 'credentials_rejected' });
            return null;
        }
        if (!res.ok) throw new Error('AUTH_REFRESH_UNCERTAIN');

        const data = await res.json();
        const t = data?.c?.token;
        if (!t?.token) throw new Error('AUTH_REFRESH_UNCERTAIN');

        const received = {
            token: t.token,
            tokenExpireAt: t.token_expire_at,
            refreshToken: t.refresh_token,
            refreshTokenExpireAt: t.refresh_token_expire_at,
        };
        // A received token can be replayed locally after a cache-write crash, without a POST.
        writeState(STATE_FILES.refreshJournal, { ...journal, status: 'received', credentials: received });
        saveTokenCache(received);
        writeState(STATE_FILES.refreshJournal, { ...journal, status: 'committed' });

        console.error('🔄 Token refreshed silently.');
        return useToken(t.token, t.token_expire_at);
    } catch (cause) {
        const error = new Error(cause.message === 'HTTP_REDIRECT_REJECTED' ? 'HTTP_REDIRECT_REJECTED' : 'AUTH_REFRESH_UNCERTAIN');
        error.code = error.message;
        throw error;
    }
}

/**
 * Get refresh_token from cache or from .auth-state.json localStorage.
 */
function getRefreshToken(cache) {
    // Prefer cache file
    if (cache?.refreshToken && cache?.refreshTokenExpireAt) {
        if (Date.now() / 1000 < cache.refreshTokenExpireAt - 300) {
            return cache.refreshToken;
        }
    }
    // Fallback: extract from auth-state localStorage
    if (fs.existsSync(CONFIG.authStateFile)) {
        try {
            const state = JSON.parse(fs.readFileSync(CONFIG.authStateFile, 'utf8'));
            const origin = state.origins?.find(o => o.origin?.includes('biji.com'));
            if (!origin) return null;
            const rtItem = origin.localStorage?.find(i => i.name === 'refresh_token');
            const rtExpItem = origin.localStorage?.find(i => i.name === 'refresh_token_expire_at');
            const rtExp = rtExpItem ? parseInt(rtExpItem.value) : 0;
            if (rtItem?.value && Date.now() / 1000 < rtExp - 300) {
                return rtItem.value;
            }
        } catch { }
    }
    return null;
}

/**
 * Returns a JWT that is valid for at least 5 more minutes.
 * force: skip the in-process and cached JWT (the server rejected it), go straight to refresh.
 */
async function getToken({ force = false } = {}) {
    const fresh = exp => !exp || Date.now() / 1000 < Number(exp) - 300;
    const pendingRefresh = loadRefreshJournal();
    const recovering = ['received', 'requesting'].includes(pendingRefresh?.status);

    if (!force && !recovering && token && fresh(tokenExpireAt)) return token;

    const cache = loadTokenCache();

    // 1. Try cached JWT (still valid for >5 min)
    if (!force && !recovering && cache?.token && cache.tokenExpireAt && fresh(cache.tokenExpireAt)) {
        return useToken(cache.token, cache.tokenExpireAt);
    }

    // 2. Try silent refresh via refresh_token (~90 day validity)
    if (lockProtocolVersion !== 3) throw new Error('LOCK_PROTOCOL_VERSION_UNSUPPORTED');
    const release = await acquireSyncLock('auth.lock');
    try {
        const pending = loadRefreshJournal();
        if (pending?.status === 'received') {
            if (!pending.credentials?.token) throw new Error('AUTH_REFRESH_JOURNAL_INVALID');
            saveTokenCache(pending.credentials);
            writeState(STATE_FILES.refreshJournal, { status: 'committed', operation_id: pending.operation_id });
            if (fresh(pending.credentials.tokenExpireAt)) return useToken(pending.credentials.token, pending.credentials.tokenExpireAt);
        } else if (pending?.status === 'requesting') {
            if (process.env.GET_BIJI_NON_INTERACTIVE === '1') {
                const error = new Error('AUTH_REFRESH_UNCERTAIN');
                error.code = error.message;
                throw error;
            }
            // Only explicit interactive login can reconcile a response lost after rotation.
            const loggedIn = await browserLogin();
            writeState(STATE_FILES.refreshJournal, { status: 'committed', recovery: 'interactive_login' });
            return loggedIn;
        }
        const latest = loadTokenCache();
        if (latest?.token && latest.tokenExpireAt && fresh(latest.tokenExpireAt) && (!force || latest.token !== cache?.token)) {
            return useToken(latest.token, latest.tokenExpireAt);
        }
        const refreshTk = getRefreshToken(latest);
        if (refreshTk) {
            const newToken = await silentRefresh(refreshTk);
            if (newToken) return newToken;
        }
        // Keep the auth lock through manual login so concurrent callers cannot rotate credentials.
        return await browserLogin();
    } finally {
        release();
    }
}

async function browserLogin() {
    if (process.env.GET_BIJI_NON_INTERACTIVE === '1') {
        const error = new Error('AUTH_REQUIRED: run get-biji interactively to log in; cron did not open a browser');
        error.code = 'AUTH_REQUIRED';
        throw error;
    }
    console.error('🔐 Login required: opening a browser window, log in to biji.com there (waiting up to 10 min)...');
    let browser;
    try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({ headless: false });
    } catch (e) {
        throw new Error(`Cannot open a browser for login. It needs a desktop session, plus "npm install && npx playwright install chromium" in the skill folder. ${e.message.split('\n')[0]}`);
    }

    try {
        const context = fs.existsSync(CONFIG.authStateFile)
            ? await browser.newContext({ storageState: CONFIG.authStateFile })
            : await browser.newContext();
        const page = await context.newPage();
        await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });

        const loggedIn = () => page.evaluate(() => !!localStorage.getItem('token'));
        const deadline = Date.now() + CONFIG.loginTimeoutMs;
        let isLoggedIn = await loggedIn();
        while (!isLoggedIn) {
            if (Date.now() > deadline) throw new Error('Login not completed within 10 minutes. Run the command again to retry.');
            await delay(2000);
            try {
                isLoggedIn = await loggedIn();
            } catch {
                throw new Error('The login window was closed before login finished. Run the command again to retry.');
            }
        }
        console.error('✅ Login successful');

        const authInfo = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            tokenExpireAt: localStorage.getItem('token_expire_at'),
            refreshToken: localStorage.getItem('refresh_token'),
            refreshTokenExpireAt: localStorage.getItem('refresh_token_expire_at'),
        }));

        writeState(CONFIG.authStateFile, await context.storageState());
        saveTokenCache({
            token: authInfo.token,
            tokenExpireAt: authInfo.tokenExpireAt ? parseInt(authInfo.tokenExpireAt) : null,
            refreshToken: authInfo.refreshToken || null,
            refreshTokenExpireAt: authInfo.refreshTokenExpireAt ? parseInt(authInfo.refreshTokenExpireAt) : null,
        });
        return useToken(authInfo.token, authInfo.tokenExpireAt);
    } finally {
        await browser.close().catch(() => { });
    }
}

async function fetchWithAuth(url, { retried = false } = {}) {
    const t = await getToken({ force: retried });
    const response = await request(url, {
        headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/json' }
    });

    const data = response.ok ? await response.json() : null;
    const expired = response.status === 401 || data?.message === 'LoginRequired';
    if (expired && !retried) return fetchWithAuth(url, { retried: true });
    if (expired) throw new Error('Token expired and could not be refreshed');
    if (!response.ok) throw new Error(`API Error: ${response.status}`);

    return data;
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch all notes from the API using cursor pagination.
 * Returns an array of unique note objects (list-level data, no detail).
 */
async function fetchAllNotes({ dedupeContent = true } = {}) {
    let allNotes = [];
    let sinceId = null;
    let hasMore = true;
    const cursors = new Set();

    console.error('📋 Fetching notes list...');

    while (hasMore) {
        let url = `${CONFIG.baseUrl}${CONFIG.listEndpoint}?limit=${CONFIG.pageSize}&sort=create_desc`;
        if (sinceId) url += `&since_id=${encodeURIComponent(String(sinceId))}`;

        const data = await fetchWithAuth(url);
        if (!Array.isArray(data?.c?.list)) throw new Error('NOTE_LIST_SCHEMA_INVALID');
        const notes = data.c.list;

        if (notes.length === 0) {
            hasMore = false;
        } else {
            process.stderr.write('.');
            allNotes = allNotes.concat(notes);
            const nextId = notes[notes.length - 1].note_id;
            if (!nextId || cursors.has(String(nextId))) throw new Error('NOTE_LIST_CURSOR_STALLED');
            cursors.add(String(nextId));
            sinceId = nextId;
            await delay(CONFIG.delayMs);
        }
    }

    // Deduplicate by note_id
    const seenIds = new Set();
    const uniqueById = allNotes.filter(n => {
        if (seenIds.has(String(n.note_id))) return false;
        seenIds.add(String(n.note_id));
        return true;
    });

    // Deduplicate by created_at + title (API returns same content under different note_ids)
    const seenContent = new Set();
    const unique = uniqueById.filter(n => {
        if (!dedupeContent) return true;
        const key = `${n.created_at || ''}|${n.title || ''}`;
        if (seenContent.has(key)) return false;
        seenContent.add(key);
        return true;
    });

    const dupeCount = uniqueById.length - unique.length;
    console.error(`\n📁 Found ${uniqueById.length} notes (${dupeCount} content duplicates removed) → ${unique.length} unique.\n`);
    return unique;
}

/**
 * Fetch note detail + original transcript for a single note.
 */
async function fetchNoteDetail(noteId, { attempts = 3 } = {}) {
    // Detail metadata: prefer the official open API. The web endpoint rate-limits
    // aggressively and then answers 200 with an empty payload, which would silently
    // write a file with no body.
    let detail = await fetchNoteDetailOfficial(noteId);
    if (!detail) {
        detail = await fetchNoteDetailWeb(noteId, { attempts });
    }

    // The original transcript only exists on the web endpoint.
    let originalData = null;
    try {
        const origUrl = `${CONFIG.baseUrl}${CONFIG.originalEndpoint}${encodeURIComponent(String(noteId))}/original`;
        originalData = (await fetchWithAuth(origUrl)).c;
        if (!originalData || !Object.keys(originalData).length) originalData = null;
    } catch (e) {
        if (e.code === 'AUTH_REQUIRED' || /AUTH_REFRESH_|HTTP_REDIRECT_REJECTED|Token expired|API Error: (401|403)/.test(e.message)) throw e;
    }
    if (!originalData) {
        // The web endpoint rate-limits hard and then answers with an empty payload.
        // Say so — otherwise transcripts silently go missing.
        console.error(`⚠️  逐字稿未取到（网页端点限流）: ${noteId}`);
    }

    await delay(CONFIG.delayMs);
    return { detail, originalData };
}

/**
 * Detail via the official open API (openapi.biji.com). Needs GETNOTE_API_KEY and
 * GETNOTE_CLIENT_ID in the environment; returns null when they are absent.
 */
async function fetchNoteDetailOfficial(noteId) {
    const apiKey = process.env.GETNOTE_API_KEY;
    const clientId = process.env.GETNOTE_CLIENT_ID;
    if (!apiKey || !clientId) return null;

    const url = `${OFFICIAL_BASE}/resource/note/detail?id=${encodeURIComponent(noteId)}`;
    try {
        const res = await request(url, {
            headers: { 'Authorization': apiKey, 'X-Client-ID': clientId, 'Accept': 'application/json' }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const note = data?.data?.note || data?.data || data?.note;
        if (!note || !note.note_id) return null;
        return {
            note_id: note.note_id,
            title: note.title || '',
            content: note.content || '',
            ref_content: note.ref_content || '',
            note_type: note.note_type || '',
            source: note.source || '',
            created_at: note.created_at || '',
            updated_at: note.updated_at || '',
            tags: note.tags || [],
            topics: note.topics || [],
            attachments: note.attachments || [],
            entry_type: note.entry_type || '',
            is_child_note: !!note.is_child_note,
        };
    } catch (e) {
        return null;
    }
}

/**
 * Detail via the web endpoint, with retries for trimmed payloads.
 */
async function fetchNoteDetailWeb(noteId, { attempts = 3 } = {}) {
    const detailUrl = `${CONFIG.baseUrl}${CONFIG.detailEndpoint}${encodeURIComponent(String(noteId))}`;
    let detail = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        detail = (await fetchWithAuth(detailUrl)).c;
        // The endpoint sometimes answers 200 with a trimmed payload — no created_at,
        // no tags, no ref_content. Treat that as a miss and ask again after backing off.
        if (detail && detail.created_at) break;
        if (attempt < attempts - 1) await delay(CONFIG.delayMs * (attempt + 1) * 3);
    }
    return detail;
}

// Sync state helpers
function loadSyncState() {
    return readState(CONFIG.syncStateFile, { syncedIds: [] });
}

function saveSyncState(state) {
    writeState(CONFIG.syncStateFile, state);
}

module.exports = {
    capabilities: {
        cronSafeAuth: true,
        cronProtocolVersion: 3,
        // 写者持锁：macOS 走内核 O_EXLOCK，Windows / Linux 走可移植独占锁，
        // 两种后端都由实际写入的进程持有到临界区结束或进程退出。
        writerOwnedLock: lockProtocolVersion === 3 && lockBackend !== null,
        lockBackend,
    },
    CONFIG,
    getToken,
    fetchAllNotes,
    fetchNoteDetail,
    loadSyncState,
    saveSyncState,
    delay,
};
