const form = document.getElementById('form');
const input = document.getElementById('server');
const status = document.getElementById('status');

function show(message, isError = false) {
    status.textContent = message;
    status.className = isError ? 'error' : 'ok';
}

loadSettings().then(({ server }) => {
    input.value = server;
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    const server = normalizeServer(input.value);
    if (!server) return show('Enter the full address, starting with http:// or https://', true);
    input.value = server;

    // Asked here, in the click, because browsers only show the permission prompt in answer to the user. Firefox
    // refuses the request outright when the save did not come from a click or key, so access that is already
    // there still counts.
    const origins = [hostPattern(server)];
    const granted = await ext.permissions.request({ origins }).catch(() => ext.permissions.contains({ origins }));
    if (!granted) return show(`Without access to ${server} the extension cannot send anything.`, true);

    const { server: old } = await loadSettings();
    if (old && hostPattern(old) !== hostPattern(server)) await ext.permissions.remove({ origins: [hostPattern(old)] }).catch(() => {});
    await ext.storage.local.set({ server });

    // Checks that it is really a Stashly server
    const result = await api(server, '/api/config');
    if (!result.ok || !result.data || !Array.isArray(result.data.sessionOptions)) {
        return show(`Saved, but ${server} does not answer like a Stashly server (${errorText(result)})`, true);
    }
    show(`Saved. The extension can now reach ${server}.`);
});
