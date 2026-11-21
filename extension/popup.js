const $ = id => document.getElementById(id);
const stashInput = $('stash');
const status = $('status');
let server = '';
// Whatever the user tried before being asked for the password, retried once the stash is unlocked
let retry = null;

function show(message, isError = false) {
    status.textContent = message;
    status.className = isError ? 'error' : 'ok';
}

function currentStash() {
    const slug = parseStash(stashInput.value);
    if (!slug) {
        show('Choose a stash first.', true);
        stashInput.focus();
    }
    return slug;
}

function fillRecent(recent) {
    $('recent').replaceChildren(...recent.map(slug => Object.assign(document.createElement('option'), { value: slug })));
}

async function init() {
    const settings = await loadSettings();
    server = settings.server;
    if (!server) {
        $('setup').hidden = false;
        return;
    }
    $('main').hidden = false;
    fillRecent(settings.recent);
    stashInput.value = settings.recent[0] || '';
    (stashInput.value ? $('text') : stashInput).focus();
    if (stashInput.value) loadNotes();
}

// Every request ends here: a locked stash asks for its password, other errors are shown
async function handle(result, slug, onSuccess, again) {
    if (result.ok) {
        fillRecent(await rememberStash(slug));
        $('unlock-form').hidden = true;
        return onSuccess(result);
    }
    if (result.status === 401 && result.data && result.data.locked) {
        retry = again;
        await showUnlock();
        return show(errorText(result), true);
    }
    if (result.status === 404 && result.data && typeof result.data === 'object') forgetStash(slug);
    show(errorText(result), true);
}

async function showUnlock() {
    const form = $('unlock-form');
    if (form.hidden) {
        const config = await api(server, '/api/config');
        const options = (config.ok && config.data.sessionOptions) || [];
        $('session').replaceChildren(
            ...options.map(({ key, label }) => Object.assign(document.createElement('option'), { value: key, textContent: label, selected: key === config.data.defaultSession }))
        );
        $('session').hidden = options.length === 0;
        form.hidden = false;
    }
    $('password').focus();
}

async function sendText(text) {
    const slug = currentStash();
    if (!slug) return;
    if (!text.trim()) return show('Write something first.', true);
    show('Sending…');
    const result = await sendNote(server, slug, text);
    await handle(result, slug, () => {
        // Also after a retry that followed the password, so the box only clears once the note is in
        if ($('text').value === text) $('text').value = '';
        show(`Sent to ${slug}.`);
        loadNotes();
    }, () => sendText(text));
}

async function upload(file) {
    const slug = currentStash();
    if (!slug || !file) return;
    show(`Uploading ${file.name}…`);
    const result = await sendFile(server, slug, file);
    await handle(result, slug, () => {
        show(`Uploaded ${file.name} to ${slug}.`);
        loadNotes();
    }, () => upload(file));
}

$('open-options').addEventListener('click', () => ext.runtime.openOptionsPage());

$('stash-form').addEventListener('submit', event => {
    event.preventDefault();
    $('text').focus();
});
stashInput.addEventListener('change', () => {
    $('unlock-form').hidden = true;
    $('search').value = '';
    retry = null;
    show('');
    loadNotes();
});

$('open-stash').addEventListener('click', () => {
    const slug = currentStash();
    if (slug) ext.tabs.create({ url: `${server}/s/${encodeURIComponent(slug)}` });
});

$('unlock-form').addEventListener('submit', async event => {
    event.preventDefault();
    const slug = currentStash();
    if (!slug) return;
    const json = { password: $('password').value };
    if ($('session').value) json.session = $('session').value;
    const result = await api(server, `${stashPath(slug)}/unlock`, { method: 'POST', json });
    if (!result.ok) return show(errorText(result), true);
    $('password').value = '';
    $('unlock-form').hidden = true;
    show(`Unlocked ${slug}.`);
    const again = retry;
    retry = null;
    if (again) again();
});

$('note-form').addEventListener('submit', event => {
    event.preventDefault();
    sendText($('text').value);
});
// Ctrl+Enter (or Cmd+Enter) sends
$('text').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('note-form').requestSubmit();
});

$('send-clipboard').addEventListener('click', async () => {
    // Reading the clipboard needs a permission the extension only asks for the first time it is used
    const granted = await ext.permissions.request({ permissions: ['clipboardRead'] }).catch(() => false);
    if (!granted) return show('Without clipboard access, paste into the box instead.', true);
    let text;
    try {
        text = await navigator.clipboard.readText();
    } catch {
        return show('The clipboard could not be read. Paste into the box instead.', true);
    }
    if (!text) return show('The clipboard has no text.', true);
    sendText(text);
});

$('file').addEventListener('change', event => {
    upload(event.target.files[0]);
    event.target.value = '';
});

// ---- The list of recent notes ----

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, title) {
    const node = el('button', null, label);
    node.type = 'button';
    if (title) node.title = title;
    return node;
}

function relativeTime(iso) {
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const steps = [[60, 'minute'], [24, 'hour'], [7, 'day']];
    let value = Math.floor(seconds / 60);
    for (const [size, unit] of steps) {
        if (value < size) return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
        value = Math.floor(value / size);
    }
    return new Date(iso).toLocaleDateString();
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function copyButton(text) {
    const node = button('Copy');
    node.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(text);
            node.textContent = 'Copied';
            setTimeout(() => { node.textContent = 'Copy'; }, 1500);
        } catch {
            show('Could not copy. Select the text and copy it instead.', true);
        }
    });
    return node;
}

// A burn-after-reading note: its text is not in the list. The first click asks, the second reveals it, which
// deletes it on the server for everyone, so the text shown here is the only copy left.
function revealButton(slug, item, row) {
    const node = button('Reveal', 'Shows the note once and deletes it for everyone');
    node.addEventListener('click', async () => {
        if (!node.dataset.armed) {
            node.dataset.armed = '1';
            node.textContent = 'Reveal and delete?';
            return;
        }
        node.disabled = true;
        const result = await api(server, `${stashPath(slug)}/items/${item.id}/reveal`, { method: 'POST' });
        if (!result.ok) {
            if (result.status === 404) row.remove();
            return handle(result, slug, () => {}, null);
        }
        const text = result.data.text;
        row.replaceChildren(el('div', 'note-main'), copyButton(text));
        row.firstChild.append(
            el('div', 'note-title', item.title),
            el('div', 'note-meta', 'Revealed once · now deleted for everyone'),
            el('pre', 'note-text', text)
        );
    });
    return node;
}

function noteRow(slug, item, role) {
    const row = el('li', 'note');
    const main = el('div', 'note-main');
    const isFile = item.kind === 'file';
    const meta = [
        isFile ? `File · ${formatSize(item.fileSize)}` : '',
        item.pinned ? 'Pinned' : '',
        item.secret ? 'Secret' : '',
        item.burn ? 'Burns after reading' : '',
        relativeTime(item.createdAt),
    ].filter(Boolean);
    if (item.burn && role !== 'full') meta.push('only full access can reveal it');
    main.append(el('div', 'note-title', isFile ? item.fileName : item.title), el('div', 'note-meta', meta.join(' · ')));
    row.append(main);
    // A file is listed by name only; a secret note is copied without being shown, as on the stash page
    if (!isFile && !item.burn) row.append(copyButton(item.text));
    if (item.burn && role === 'full') row.append(revealButton(slug, item, row));
    return row;
}

const LIST_LIMIT = 20;
let listSeq = 0;
let searchTimer = null;

// The newest notes of the stash, or those matching the search. The search runs on the server (in the request
// body, so the words stay out of addresses), and only LIST_LIMIT items come back.
async function loadNotes() {
    clearTimeout(searchTimer);
    const slug = parseStash(stashInput.value);
    const seq = ++listSeq;
    if (!slug) {
        $('notes').replaceChildren();
        $('notes-info').textContent = '';
        return;
    }
    const search = $('search').value.trim();
    const json = { limit: LIST_LIMIT };
    if (search) json.search = search;
    $('notes-info').textContent = search ? 'Searching…' : 'Loading…';
    const result = await api(server, `${stashPath(slug)}/query`, { method: 'POST', json });
    // A newer search or another stash has been asked for since
    if (seq !== listSeq) return;
    if (!result.ok) $('notes-info').textContent = '';
    await handle(result, slug, () => {
        const { role, total } = result.data;
        // An older server ignores the limit, so it is applied here too
        const items = (result.data.items || []).slice(0, LIST_LIMIT);
        $('notes').replaceChildren(...items.map(item => noteRow(slug, item, role)));
        let info;
        if (role === 'drop') info = 'This drop-box link can add things but cannot read them.';
        else if (!items.length) info = search ? 'Nothing matches.' : 'Nothing here yet.';
        else if (total > items.length) info = `The newest ${items.length} of ${total}${search ? ' matches' : ''}. Search to find others.`;
        else info = search ? `${total} match${total === 1 ? '' : 'es'}.` : '';
        $('notes-info').textContent = info;
    }, () => loadNotes());
}

$('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    // Waits for a pause in typing, so each key press is not a request
    searchTimer = setTimeout(loadNotes, 300);
});
$('search').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        loadNotes();
    }
});

// Dropping a file anywhere on the popup uploads it
let dragDepth = 0;
document.addEventListener('dragenter', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepth += 1;
    $('drop-hint').hidden = false;
});
document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-hint').hidden = true;
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    const files = [...event.dataTransfer.files];
    if (!files.length || !server) return;
    // One after another, so the messages follow each other in order
    files.reduce((chain, file) => chain.then(() => upload(file)), Promise.resolve());
});

init();
