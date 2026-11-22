// The admin account that ADMIN_USERNAME and ADMIN_PASSWORD describe, kept as a real user row so it signs in like everyone
// else and works with sessions, the follow list, the audit log and role checks. `managed` marks it: the admin area
// refuses to edit it, because the server's environment is the one place it is changed.
const { hashPasswordSync, verifyPasswordSync } = require('./password');

// Makes the row match the environment. Runs at startup (createApp) before any request, and does nothing when the admin
// area is off (no ADMIN_PASSWORD). Returns what it did, for the log and the tests: 'created', 'updated' or 'unchanged'.
//  - no row yet: it is created;
//  - a managed row whose password no longer matches ADMIN_PASSWORD (or that someone changed in the database): it is set
//    back and its sessions end; one that already matches is left alone, so a restart signs nobody out;
//  - a row with this name that is NOT managed is a regular user who got there first: refuse to start, so the owner
//    chooses (another ADMIN_USERNAME, or delete that user) instead of the server quietly taking the account over or
//    leaving ADMIN_PASSWORD without effect;
//  - a managed row under another name (ADMIN_USERNAME was changed) is released: a disabled, ordinary user that the admin
//    can delete. It is not deleted here so its follow list is not lost without anyone asking.
function syncAdminUser({ users, config, log = () => {} }) {
    if (!config.adminPassword) return 'unchanged';
    const username = config.adminUsername;

    for (const old of users.managedUsers()) {
        if (old.username === username) continue;
        users.releaseManaged(old.id);
        log(`ADMIN_USERNAME is now "${username}": the old admin account "${old.username}" is disabled and no longer managed. Delete it under Admin > Users if you do not need it.`);
    }

    const existing = users.findByUsername(username);
    if (!existing) {
        const hashed = hashPasswordSync(config.adminPassword);
        users.create({ username, hash: hashed.hash, salt: hashed.salt, role: 'admin', createdBy: 'environment', managed: true });
        return 'created';
    }
    if (!existing.managed) {
        throw new Error(`A user named "${username}" already exists, but that name is ADMIN_USERNAME. Set ADMIN_USERNAME to another name, or delete that user, then start again.`);
    }
    const matches = verifyPasswordSync(config.adminPassword, existing.password_hash, existing.password_salt);
    if (matches && existing.role === 'admin' && !existing.disabled) return 'unchanged';
    users.resetManaged(existing.id, matches ? null : hashPasswordSync(config.adminPassword));
    return 'updated';
}

module.exports = { syncAdminUser };
