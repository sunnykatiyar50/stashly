// The audit log (AUDIT_LOG=stdout): one JSON line for each thing that changes who can reach what. Like the access
// log it carries no stash name (a keyed hash instead), no password, token, cookie, note text or file name.
//
// Controllers get the `audit` function through their constructor and call it in one line:
//     this.audit('stash.deleted', { req, stash, detail: { reason: 'visitor' } });
// The default is a function that does nothing, so code that builds a controller without logging keeps working.
const { writeLine, stashTag } = require('./logLine');

const noopAudit = () => {};
noopAudit.tag = () => null;

// mode: 'off' or 'stdout'. `stash` may be a name or a stash row; it is logged as a keyed hash only.
function createAudit({ mode = 'off', out = writeLine, secret, now = () => new Date() } = {}) {
    if (mode !== 'stdout') return noopAudit;
    const audit = (event, { req, stash, actor, detail } = {}) => {
        try {
            const slug = stash && typeof stash === 'object' ? stash.slug : stash;
            out(
                JSON.stringify({
                    time: now().toISOString(),
                    level: 'audit',
                    event,
                    ip: (req && req.ip) || null,
                    stash: stashTag(secret, slug),
                    // No request means the server did it by itself (an expiry); otherwise the caller says who
                    actor: actor || (req ? 'visitor' : 'system'),
                    detail: detail || {},
                })
            );
        } catch {
            // an audit line that cannot be written must not undo what was audited
        }
    };
    audit.tag = slug => stashTag(secret, slug);
    return audit;
}

module.exports = { createAudit, noopAudit };
