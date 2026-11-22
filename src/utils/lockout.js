// Wrong-password counting for the stash unlock. Held in memory, so a restart clears it. Two counts per stash:
//  - per visitor (IP): `stashUnlockFailures` wrong passwords lock that visitor out, so a stranger cannot lock the owner
//    out of their own stash;
//  - for the whole stash: `stashUnlockFailures` x GLOBAL_FACTOR from anyone, against guessing from many addresses.
// The limits are read from `config` on each call, because the admin can change them while the server runs.

// The whole stash locks after this many times the per-visitor limit of wrong passwords
const GLOBAL_FACTOR = 5;

class UnlockLockout {
    constructor({ config, now = () => new Date() }) {
        this.config = config;
        this.now = now;
        this.global = new Map(); // slug -> { start, count }, wrong passwords from anyone
        this.perIp = new Map(); // slug -> Map(ip -> { start, count })
    }

    // Milliseconds left on a lock in `map` for `key`, or 0 (also forgets a count whose window has passed)
    left(map, key, max) {
        const entry = map.get(key);
        if (!max || !entry) return 0;
        const now = this.now().getTime();
        if (now - entry.start >= this.config.stashUnlockWindowMs) {
            map.delete(key);
            return 0;
        }
        return entry.count >= max ? entry.start + this.config.stashUnlockWindowMs - now : 0;
    }

    count(map, key) {
        const now = this.now().getTime();
        const entry = map.get(key);
        if (!entry || now - entry.start >= this.config.stashUnlockWindowMs) map.set(key, { start: now, count: 1 });
        else entry.count += 1;
    }

    // How long this visitor must wait before trying `slug` again (ms), or 0
    locked(slug, ip) {
        const max = this.config.stashUnlockFailures;
        const visitors = this.perIp.get(slug);
        const own = visitors ? this.left(visitors, ip, max) : 0;
        if (visitors && !visitors.size) this.perIp.delete(slug);
        return Math.max(own, this.left(this.global, slug, max * GLOBAL_FACTOR));
    }

    note(slug, ip) {
        this.count(this.global, slug);
        if (!this.perIp.has(slug)) this.perIp.set(slug, new Map());
        this.count(this.perIp.get(slug), ip);
    }

    // A right password, a new password or a deleted stash: forget the counts
    clear(slug) {
        this.global.delete(slug);
        this.perIp.delete(slug);
    }

    // The stash was renamed: the counts belong to the stash, not the name
    rename(from, to) {
        const global = this.global.get(from);
        if (global) this.global.set(to, global);
        const visitors = this.perIp.get(from);
        if (visitors) this.perIp.set(to, visitors);
        this.clear(from);
    }

    // Forgets counts whose window has passed
    sweep() {
        const window = this.config.stashUnlockWindowMs;
        const now = this.now().getTime();
        for (const [slug, entry] of this.global) if (now - entry.start >= window) this.global.delete(slug);
        for (const [slug, visitors] of this.perIp) {
            for (const [ip, entry] of visitors) if (now - entry.start >= window) visitors.delete(ip);
            if (!visitors.size) this.perIp.delete(slug);
        }
    }
}

module.exports = { UnlockLockout, GLOBAL_FACTOR };
