// The wording of every email the server sends. Each function returns { subject, text, html }.
// Text is the real message; the HTML copy is the same words with escaped values and the links made clickable.
// Nothing here puts a password in a message.
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// paragraphs: strings, or { link: 'https://...' } for a line that is just a link
function layout(title, paragraphs, footer) {
    const text = [title, '', ...paragraphs.map(p => (typeof p === 'string' ? p : p.link)), '', '--', footer].join('\n');
    const body = paragraphs
        .map(p => (typeof p === 'string'
            ? `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`
            : `<p style="margin:0 0 14px"><a href="${escapeHtml(p.link)}">${escapeHtml(p.link)}</a></p>`))
        .join('');
    const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">` +
        `<h2 style="font-size:18px;margin:0 0 14px">${escapeHtml(title)}</h2>${body}` +
        `<p style="margin:18px 0 0;color:#6b7280;font-size:12.5px">${escapeHtml(footer)}</p></div>`;
    return { text, html };
}

const FOOTER = 'Sent by Stashly. If you did not expect this email you can ignore it.';

function testEmail({ serverName = 'Stashly', url = '' } = {}) {
    const paragraphs = ['This is a test message. If you can read it, the email settings work.'];
    if (url) paragraphs.push('The address this server uses in links:', { link: url });
    return { subject: `${serverName}: test email`, ...layout('Test email', paragraphs, FOOTER) };
}

// A link that sets a new password. minutes: how long it works. who: the account's username.
function resetEmail({ serverName = 'Stashly', username, link, minutes, byAdmin = false }) {
    const paragraphs = [
        byAdmin ? `An administrator sent you a link to choose a new password for the account "${username}".` : `Someone asked to reset the password of the account "${username}".`,
        `Open this link to choose a new one. It works once, for ${minutes} minutes:`,
        { link },
        'If you did not ask for this, ignore this email: nothing changes until the link is used.',
    ];
    return { subject: `${serverName}: reset your password`, ...layout('Reset your password', paragraphs, FOOTER) };
}

// Sent after a password was changed by a reset link, and to the old address when the email on an account changes
function passwordChangedEmail({ serverName = 'Stashly', username }) {
    const paragraphs = [`The password of the account "${username}" was just changed.`, 'If this was not you, ask your administrator to secure the account.'];
    return { subject: `${serverName}: your password was changed`, ...layout('Your password was changed', paragraphs, FOOTER) };
}

function emailChangedEmail({ serverName = 'Stashly', username }) {
    const paragraphs = [`The email address of the account "${username}" was changed, so this address no longer receives its password reset links.`, 'If this was not you, ask your administrator to secure the account.'];
    return { subject: `${serverName}: the email address of your account changed`, ...layout('Your account email changed', paragraphs, FOOTER) };
}

module.exports = { resetEmail, passwordChangedEmail, emailChangedEmail, testEmail, escapeHtml, layout, FOOTER };
