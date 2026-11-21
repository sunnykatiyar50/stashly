// The context menu: "Send to Stashly" for selected text, a link or the page, into one of the recent stashes.
// Chrome runs this as a service worker (common.js is imported here); Firefox loads both files as background scripts.
if (typeof importScripts === 'function' && typeof ext === 'undefined') importScripts('common.js');

const ROOT = 'stashly-send';
const CONTEXTS = ['selection', 'link', 'page'];

// One item when there is a single recent stash, otherwise a submenu with one entry per stash
async function buildMenu() {
    await ext.contextMenus.removeAll();
    const { recent } = await loadSettings();
    if (recent.length <= 1) {
        ext.contextMenus.create({ id: ROOT, title: recent.length ? `Send to Stashly (${recent[0]})` : 'Send to Stashly', contexts: CONTEXTS });
        return;
    }
    ext.contextMenus.create({ id: ROOT, title: 'Send to Stashly', contexts: CONTEXTS });
    for (const slug of recent) {
        ext.contextMenus.create({ id: `${ROOT}:${slug}`, parentId: ROOT, title: slug, contexts: CONTEXTS });
    }
}

// A short mark on the toolbar button: OK, or "!" with the reason in the button's tooltip
async function flash(ok, message) {
    await ext.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
    await ext.action.setBadgeText({ text: ok ? 'OK' : '!' });
    await ext.action.setTitle({ title: message });
    setTimeout(() => {
        ext.action.setBadgeText({ text: '' });
        ext.action.setTitle({ title: 'Stashly' });
    }, ok ? 2500 : 8000);
}

ext.runtime.onInstalled.addListener(buildMenu);
ext.runtime.onStartup.addListener(buildMenu);
ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recent) buildMenu();
});

async function sendFromMenu(info) {
    const id = String(info.menuItemId);
    if (!id.startsWith(ROOT)) return;
    const { server, recent } = await loadSettings();
    const slug = id.includes(':') ? id.slice(ROOT.length + 1) : recent[0];
    if (!server) return flash(false, 'Set your Stashly server in the extension options first.');
    if (!slug) return flash(false, 'Open the Stashly popup and choose a stash first.');

    // The selection wins, then the link, then the page itself
    const text = info.selectionText || info.linkUrl || info.pageUrl;
    if (!text) return;
    const result = await sendNote(server, slug, text);
    if (result.ok) {
        await rememberStash(slug);
        return flash(true, `Sent to ${slug}`);
    }
    const reason = result.status === 401 ? `${slug} is locked. Open the popup to unlock it.` : errorText(result);
    return flash(false, reason);
}
ext.contextMenus.onClicked.addListener(sendFromMenu);
