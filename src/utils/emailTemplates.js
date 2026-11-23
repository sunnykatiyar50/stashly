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

module.exports = { testEmail, escapeHtml, layout, FOOTER };
