// A small SMTP server on a free local port that keeps what it receives, for tests of the email features.
// Plain (no TLS), so a test sets the security to "none".
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

// auth: { user, pass } makes the server require that login. rejectRecipient(address) -> true refuses that recipient.
async function startSmtp({ auth = null, rejectRecipient = null } = {}) {
    const messages = [];
    const server = new SMTPServer({
        authOptional: !auth,
        allowInsecureAuth: true,
        disabledCommands: ['STARTTLS'],
        logger: false,
        onAuth(credentials, session, done) {
            if (auth && credentials.username === auth.user && credentials.password === auth.pass) return done(null, { user: credentials.username });
            const err = new Error('Invalid username or password');
            err.responseCode = 535;
            return done(err);
        },
        onRcptTo(address, session, done) {
            if (rejectRecipient && rejectRecipient(address.address)) {
                const err = new Error('Mailbox unavailable');
                err.responseCode = 550;
                return done(err);
            }
            return done();
        },
        onData(stream, session, done) {
            simpleParser(stream).then(mail => {
                messages.push({
                    from: mail.from && mail.from.value[0],
                    to: (mail.to ? mail.to.value : []).map(entry => entry.address),
                    envelopeTo: session.envelope.rcptTo.map(entry => entry.address),
                    subject: mail.subject,
                    text: mail.text,
                    html: mail.html,
                    headers: mail.headers,
                    user: session.user || null,
                });
                done();
            }).catch(done);
        },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.server.address().port,
        messages,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = { startSmtp };
