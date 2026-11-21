// Shared by the popup, the options page and the background script.
// Firefox has `browser`; Chrome's `chrome` returns promises in Manifest V3, so either works the same way here.
const ext = globalThis.browser || globalThis.chrome;

const RECENT_LIMIT = 5;

// The saved settings: the server's origin and the stashes used most recently (newest first)
async function loadSettings() {
    const { server = '', recent = [] } = await ext.storage.local.get(['server', 'recent']);
    return { server, recent };
}

// "https://stash.example.com/some/path" -> "https://stash.example.com". Only http(s) is accepted.
function normalizeServer(input) {
    let url;
    try {
        url = new URL(String(input || '').trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
}

// The host permission for a server. It leaves the port out: Firefox shows a pattern with a port as granted but
// matches nothing with it (bugzilla 1362809), so it covers that host on any port.
function hostPattern(server) {
    const url = new URL(server);
    return `${url.protocol}//${url.hostname}/*`;
}

// Accepts a stash name, "/s/name" or a full stash link, and returns the name
function parseStash(input) {
    const value = String(input || '').trim();
    const match = value.match(/\/s\/([^/?#]+)/);
    const slug = match ? decodeURIComponent(match[1]) : value;
    return slug.toLowerCase();
}

// Puts the stash first in the recent list
async function rememberStash(slug) {
    const { recent } = await loadSettings();
    const next = [slug, ...recent.filter(s => s !== slug)].slice(0, RECENT_LIMIT);
    await ext.storage.local.set({ recent: next });
    return next;
}

async function forgetStash(slug) {
    const { recent } = await loadSettings();
    await ext.storage.local.set({ recent: recent.filter(s => s !== slug) });
}

// Calls the Stashly API. The browser adds the stash's sign-in cookie itself (credentials: 'include').
// Resolves to { ok, status, data } where data is the parsed JSON or the text; never throws on an HTTP error.
async function api(server, path, { method = 'GET', json, body, headers = {} } = {}) {
    const init = { method, credentials: 'include', headers: { ...headers } };
    if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
    } else if (body !== undefined) {
        init.body = body;
    }
    let res;
    try {
        res = await fetch(server + path, init);
    } catch {
        return { ok: false, status: 0, data: { error: `Cannot reach ${server}.` } };
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
    return { ok: res.ok, status: res.status, data };
}

const stashPath = slug => `/api/stashes/${encodeURIComponent(slug)}`;

function errorText(result) {
    if (result.data && typeof result.data === 'object' && result.data.error) return result.data.error;
    if (result.status === 0) return 'Cannot reach the server.';
    return `The server answered ${result.status}.`;
}

function sendNote(server, slug, text) {
    return api(server, `${stashPath(slug)}/notes`, { method: 'POST', json: { text } });
}

function sendFile(server, slug, file) {
    return api(server, `${stashPath(slug)}/files`, {
        method: 'POST',
        body: file,
        headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
    });
}
