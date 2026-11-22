const { signToken, verifyToken, parseCookies } = require('./token');

const COOKIE = 'stashly_user';
const DAY = 24 * 60 * 60 * 1000;

// Signing in as a user. The cookie is "<user id>.<expiry>.<signature>": the signature covers the user id and a salt made
// of the user's password salt and session version, so a new password, a new role, a disable or "sign out everywhere"
// (which all change one of those) ends every session of that user at once. A cookie that does not check out is simply
// ignored: the visitor is anonymous, as if they had never signed in.
//
// Accounts are on only while the admin area is (ADMIN_PASSWORD set).
class UserAuth {
    constructor({ config, secret, users, now = () => new Date() }) {
        this.config = config;
        this.secret = secret;
        this.users = users;
        this.now = now;
    }

    get enabled() {
        return Boolean(this.config.adminPassword);
    }

    sessionMs() {
        return Math.max(1, Math.min(90, Math.floor(this.config.userSessionDays) || 7)) * DAY;
    }

    saltOf(user) {
        return `${user.password_salt}.v${user.session_version}`;
    }

    // The signed-in user as the cookie says, checked against the database every time, or null. The same check is made
    // again on each heartbeat of a live stream, so a user who is disabled or signed out stops receiving.
    resolve(req) {
        if (!this.enabled) return null;
        const value = parseCookies(req.headers.cookie)[COOKIE];
        if (typeof value !== 'string') return null;
        const dot = value.indexOf('.');
        const id = Number(value.slice(0, dot));
        if (dot < 1 || !Number.isSafeInteger(id) || id < 1) return null;
        const user = this.users.findById(id);
        if (!user || user.disabled) return null;
        if (!verifyToken(this.secret, `user:${id}`, this.saltOf(user), value.slice(dot + 1), this.now().getTime())) return null;
        return user;
    }

    // What the rest of the app sees as req.user: never the password hash or salt
    present(user) {
        return { id: user.id, username: user.username, displayName: user.display_name || null, role: user.role };
    }

    // Middleware, mounted before the routes
    load = (req, res, next) => {
        const user = this.resolve(req);
        req.user = user ? this.present(user) : null;
        next();
    };

    startSession(req, res, user) {
        const ms = this.sessionMs();
        const expiresAt = this.now().getTime() + ms;
        res.cookie(COOKIE, `${user.id}.${signToken(this.secret, `user:${user.id}`, this.saltOf(user), expiresAt)}`, {
            httpOnly: true,
            sameSite: 'strict',
            // Same rule as the stash and admin cookies: COOKIE_SECURE=true forces it, "auto" follows the connection
            secure: this.config.cookieSecure === 'true' ? true : this.config.cookieSecure === 'false' ? false : req.secure,
            path: '/',
            maxAge: ms,
        });
    }

    endSession(res) {
        res.clearCookie(COOKIE, { path: '/' });
    }
}

module.exports = { UserAuth, COOKIE };
