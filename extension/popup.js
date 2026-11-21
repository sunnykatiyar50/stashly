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
    }, () => sendText(text));
}

async function upload(file) {
    const slug = currentStash();
    if (!slug || !file) return;
    show(`Uploading ${file.name}…`);
    const result = await sendFile(server, slug, file);
    await handle(result, slug, () => show(`Uploaded ${file.name} to ${slug}.`), () => upload(file));
}

$('open-options').addEventListener('click', () => ext.runtime.openOptionsPage());

$('stash-form').addEventListener('submit', event => {
    event.preventDefault();
    $('text').focus();
});
stashInput.addEventListener('change', () => {
    $('unlock-form').hidden = true;
    $('latest').hidden = true;
    $('copy-latest').hidden = true;
    retry = null;
    show('');
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

$('show-latest').addEventListener('click', async function showLatest() {
    const slug = currentStash();
    if (!slug) return;
    const result = await api(server, `${stashPath(slug)}/latest`);
    // 404 with plain text means the stash is there but has no notes yet
    if (result.status === 404 && typeof result.data === 'string') return show('No notes yet.');
    await handle(result, slug, () => {
        $('latest').textContent = result.data;
        $('latest').hidden = false;
        $('copy-latest').hidden = false;
        show('');
    }, () => showLatest());
});

$('copy-latest').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText($('latest').textContent);
        show('Copied.');
    } catch {
        show('Could not copy. Select the text and copy it instead.', true);
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
