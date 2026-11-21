const crypto = require('crypto');
const { signToken, verifyToken, parseCookies } = require('./token');

const COOKIE = 'stashly_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

const digest = value => crypto.createHash('sha256').update(String(value)).digest();

// One admin, set by ADMIN_PASSWORD. Without it the admin area is switched off.
// The session cookie is bound to the password, so changing ADMIN_PASSWORD signs everyone out.
class AdminAuth {
    constructor({ config, secret, now = () => new Date() }) {
        this.config = config;
        this.secret = secret;
        this.now = now;
    }

    get enabled() {
        return Boolean(this.config.adminPassword);
    }

    get salt() {
        return digest(this.config.adminPassword).toString('hex').slice(0, 16);
    }

    checkPassword(password) {
        if (!this.enabled || typeof password !== 'string') return false;
        return crypto.timingSafeEqual(digest(password), digest(this.config.adminPassword));
    }

    isAdmin = req => {
        if (!this.enabled) return false;
        const token = parseCookies(req.headers.cookie)[COOKIE];
        return Boolean(verifyToken(this.secret, 'admin', this.salt, token, this.now().getTime()));
    };

    startSession(req, res) {
        const expiresAt = this.now().getTime() + SESSION_MS;
        res.cookie(COOKIE, signToken(this.secret, 'admin', this.salt, expiresAt), {
            httpOnly: true,
            sameSite: 'strict',
            secure: req.secure,
            path: '/',
            maxAge: SESSION_MS,
        });
    }

    endSession(res) {
        res.clearCookie(COOKIE, { path: '/' });
    }

    // Middleware for the admin API
    require = (req, res, next) => {
        if (!this.enabled) return res.status(404).json({ error: 'Admin is not enabled on this server.' });
        if (!this.isAdmin(req)) return res.status(401).json({ error: 'Sign in as admin first.', signedIn: false });
        next();
    };
}

module.exports = { AdminAuth };
