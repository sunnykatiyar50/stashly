// Sends email through the SMTP server set in Admin > Settings > Email. Nothing else in the server talks to a mail server:
// everything that sends goes through send(), so the rules below hold for every kind of message.
//
//  - Off until the admin turns it on and the server and the From address are filled in.
//  - Addresses and subjects are checked: no line breaks (header injection), a sane shape, at most MAX_RECIPIENTS.
//  - A cap on how many messages go out an hour (Admin > Settings > Email), so a stolen account or a bug cannot turn
//    the server into a mail cannon.
//  - Failures are described in plain words. The password never appears in an error, a log or a response.
const nodemailer = require('nodemailer');

const MAX_RECIPIENTS = 10;

// A plain address: something@something.tld, without spaces, quotes, brackets or separators
const ADDRESS = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]{2,}$/;

function validAddress(value) {
    return typeof value === 'string' && value.length <= 254 && !/[\r\n]/.test(value) && ADDRESS.test(value);
}

// code: disabled | invalid | rate | connect | tls | auth | recipient | rejected | failed
class MailError extends Error {
    constructor(code, message, detail = '') {
        super(message);
        this.name = 'MailError';
        this.code = code;
        // Only for the admin's test: what the mail server said, shortened. Never shown to ordinary visitors.
        this.detail = detail;
    }
}

const MESSAGES = {
    disabled: 'Email is not set up on this server.',
    invalid: 'That is not a valid email address.',
    rate: 'This server has sent too many emails this hour. Try again later.',
    connect: 'Could not reach the mail server. Check the host and port.',
    tls: 'The mail server did not accept the secure connection. Check the security setting and the port.',
    auth: 'The mail server did not accept the username or password.',
    recipient: 'The mail server refused that address.',
    rejected: 'The mail server refused the message.',
    failed: 'The email could not be sent.',
};

// On, and complete enough to send (also what the public config reports, so the pages know whether to offer email)
function emailReady(config) {
    return Boolean(config.smtpEnabled && config.smtpHost && validAddress(config.smtpFromAddress));
}

class Mailer {
    // createTransport can be replaced (tests); it is nodemailer's by default
    constructor({ config, now = () => new Date(), createTransport = nodemailer.createTransport } = {}) {
        this.config = config;
        this.now = now;
        this.createTransport = createTransport;
        this.sentAt = [];
    }

    // On, and complete enough to send
    get enabled() {
        return emailReady(this.config);
    }

    // The address of this server to put in links: the one the admin gave, with no trailing slash. Empty when not set.
    // Emails that carry a link which signs someone in or changes a password need it (the Host header of a request is
    // chosen by whoever makes the request, so it must never decide where such a link points).
    get publicUrl() {
        return this.config.publicUrl || '';
    }

    transportOptions() {
        const c = this.config;
        const options = {
            host: c.smtpHost,
            port: c.smtpPort,
            secure: c.smtpSecurity === 'ssl',
            // STARTTLS must succeed (no quiet fall back to plain text); "none" means plain on purpose
            requireTLS: c.smtpSecurity === 'starttls',
            ignoreTLS: c.smtpSecurity === 'none',
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 20000,
            tls: { minVersion: 'TLSv1.2' },
        };
        if (c.smtpUser) options.auth = { user: c.smtpUser, pass: c.smtpPassword };
        return options;
    }

    // Keeps the count of messages sent in the last hour, and refuses past the cap
    checkRate() {
        const now = this.now().getTime();
        this.sentAt = this.sentAt.filter(at => now - at < 60 * 60 * 1000);
        if (this.sentAt.length >= this.config.emailsPerHour) throw new MailError('rate', MESSAGES.rate);
    }

    // to: one address or a list. Returns { accepted } or throws a MailError.
    async send({ to, subject, text, html, replyTo }) {
        if (!this.enabled) throw new MailError('disabled', MESSAGES.disabled);
        const recipients = [].concat(to || []);
        if (!recipients.length || recipients.length > MAX_RECIPIENTS || !recipients.every(validAddress)) {
            throw new MailError('invalid', MESSAGES.invalid);
        }
        if (typeof subject !== 'string' || !subject || /[\r\n]/.test(subject) || subject.length > 200) throw new MailError('invalid', 'The subject is not valid.');
        if (replyTo !== undefined && !validAddress(replyTo)) throw new MailError('invalid', MESSAGES.invalid);
        this.checkRate();

        const c = this.config;
        const transport = this.createTransport(this.transportOptions());
        try {
            const info = await transport.sendMail({
                from: { name: String(c.smtpFromName || '').replace(/[\r\n"]/g, ' ').slice(0, 100), address: c.smtpFromAddress },
                to: recipients,
                replyTo,
                subject,
                text,
                html,
                // Tells auto-repliers and vacation messages to leave it alone
                headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
            });
            this.sentAt.push(this.now().getTime());
            return { accepted: (info && info.accepted ? info.accepted.length : recipients.length) };
        } catch (err) {
            throw this.describe(err);
        } finally {
            if (transport && typeof transport.close === 'function') transport.close();
        }
    }

    // Turns whatever nodemailer threw into a MailError that names the problem and leaks nothing
    describe(err) {
        if (err instanceof MailError) return err;
        const code = String(err && err.code || '');
        const secret = this.config.smtpPassword;
        let detail = String((err && (err.response || err.message)) || '').replace(/\s+/g, ' ').slice(0, 200);
        if (secret) detail = detail.split(secret).join('***');
        if (code === 'EAUTH') return new MailError('auth', MESSAGES.auth, detail);
        if (code === 'EENVELOPE') return new MailError('recipient', MESSAGES.recipient, detail);
        if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'].includes(code)) {
            // A failed TLS handshake is reported as a socket error: tell the two apart by the message
            return /tls|ssl|certificate|handshake|wrong version/i.test(detail) ? new MailError('tls', MESSAGES.tls, detail) : new MailError('connect', MESSAGES.connect, detail);
        }
        if (/tls|ssl|certificate|starttls/i.test(code + ' ' + detail)) return new MailError('tls', MESSAGES.tls, detail);
        if (err && Number(err.responseCode) >= 500) return new MailError('rejected', MESSAGES.rejected, detail);
        return new MailError('failed', MESSAGES.failed, detail);
    }
}

module.exports = { Mailer, MailError, validAddress, emailReady, MAX_RECIPIENTS };
