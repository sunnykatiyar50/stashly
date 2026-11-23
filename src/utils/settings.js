const MB = 1024 * 1024;
const round = value => Math.round(value * 100) / 100;

// The limits the admin can change at runtime. The environment gives the defaults; changes made in the admin
// page are saved in the database and win over them (until "Reset to defaults"). `group` is the tab the admin
// page shows the setting under; tabs appear in the order their first setting appears here.
const FIELDS = {
    maxFileMb: {
        group: 'Limits', label: 'Largest file', unit: 'MB', type: 'int', min: 1, max: 2048,
        help: 'The biggest single file that can be uploaded.',
        read: c => round(c.maxFileBytes / MB), write: (c, v) => { c.maxFileBytes = v * MB; },
    },
    maxFilesPerStash: {
        group: 'Limits', label: 'Files per stash', unit: 'files', type: 'int', min: 1, max: 100000,
        help: 'How many files one stash can hold.',
        read: c => c.maxFilesPerStash, write: (c, v) => { c.maxFilesPerStash = v; },
    },
    maxItemsPerStash: {
        group: 'Limits', label: 'Items per stash', unit: 'items', type: 'int', min: 1, max: 200000,
        help: 'Notes and files together. Keep it at or above the file limit.',
        read: c => c.maxItemsPerStash, write: (c, v) => { c.maxItemsPerStash = v; },
    },
    maxStashMb: {
        group: 'Limits', label: 'File space per stash', unit: 'MB', type: 'int', min: 1, max: 1048576,
        help: 'Total size of the files in one stash.',
        read: c => round(c.maxStashBytes / MB), write: (c, v) => { c.maxStashBytes = v * MB; },
    },
    maxTotalMb: {
        group: 'Limits', label: 'File space on the server', unit: 'MB', type: 'int', min: 1, max: 10485760,
        help: 'Total size of all files in all stashes. Protects the disk.',
        read: c => round(c.maxTotalBytes / MB), write: (c, v) => { c.maxTotalBytes = v * MB; },
    },
    maxNoteKb: {
        group: 'Limits', label: 'Largest note', unit: 'KB', type: 'int', min: 1, max: 10240,
        help: 'The biggest single note.',
        read: c => round(c.maxNoteBytes / 1024), write: (c, v) => { c.maxNoteBytes = v * 1024; },
    },
    maxStashes: {
        group: 'Limits', label: 'Stashes on the server', unit: 'stashes', type: 'int', min: 1, max: 1000000,
        help: 'New stashes are refused once this many exist.',
        read: c => c.maxStashes, write: (c, v) => { c.maxStashes = v; },
    },
    minOpenNameLength: {
        group: 'Security', label: 'Shortest name without a password', unit: 'characters', type: 'int', min: 0, max: 64,
        help: 'A stash with no password is protected only by its name. Names shorter than this need a password. 0 turns the rule off. Stashes that already exist are not changed.',
        read: c => c.minOpenNameLength, write: (c, v) => { c.minOpenNameLength = v; },
    },
    minPasswordLength: {
        group: 'Security', label: 'Shortest stash password', unit: 'characters', type: 'int', min: 4, max: 200,
        help: 'Applies when a password is set or changed. Passwords that already exist keep working.',
        read: c => c.minPasswordLength, write: (c, v) => { c.minPasswordLength = v; },
    },
    reserveOldNamesDays: {
        group: 'Security', label: 'Keep old names reserved', unit: 'days', type: 'int', min: 0, max: 3650,
        help: 'A name given up by a deleted, expired or renamed stash cannot be used by a new stash for this long, so a device or script still using it does not send to someone else. 0 turns it off.',
        read: c => c.reserveOldNamesDays, write: (c, v) => { c.reserveOldNamesDays = v; },
    },
    userSessionDays: {
        group: 'Security', label: 'Account sign-in lasts', unit: 'days', type: 'int', min: 1, max: 90,
        help: 'How long a user stays signed in on one browser. People already signed in keep the length they got when they signed in.',
        read: c => c.userSessionDays, write: (c, v) => { c.userSessionDays = v; },
    },
    signInAttempts: {
        group: 'Security', label: 'Wrong account passwords allowed', unit: 'per 15 minutes', type: 'int', min: 1, max: 1000,
        help: 'How many wrong passwords one address may try at the sign-in (users and the admin) before it is made to wait. Typing it right never counts.',
        read: c => c.rateUserLogin, write: (c, v) => { c.rateUserLogin = v; c.rateAdminLogin = v; },
    },
    stashUnlockFailures: {
        group: 'Security', label: 'Wrong stash passwords before a lockout', unit: 'attempts', type: 'int', min: 0, max: 1000,
        help: 'After this many wrong passwords on one stash from one address, unlocking it is refused until the wait below ends. 0 turns the lockout off.',
        read: c => c.stashUnlockFailures, write: (c, v) => { c.stashUnlockFailures = v; },
    },
    stashUnlockWindowMin: {
        group: 'Security', label: 'Lockout wait', unit: 'minutes', type: 'int', min: 1, max: 1440,
        help: 'How long a lockout lasts, and how long wrong passwords are counted for.',
        read: c => Math.round(c.stashUnlockWindowMs / 60000), write: (c, v) => { c.stashUnlockWindowMs = v * 60000; },
    },
    fileTypes: {
        group: 'Files', label: 'File types', type: 'choice',
        options: [
            { value: 'safe', label: 'Safe list: images, audio, video, PDF, zip, Office files, certificates, text' },
            { value: 'no-programs', label: 'Any file except programs' },
            { value: 'any', label: 'Any file at all' },
        ],
        help: 'Which files can be uploaded. "Except programs" also allows archives and other binaries, but still refuses executables, SVG and macro-enabled Office files. Uploads are never run or shown by Stashly, whatever the type.',
        read: c => c.fileTypes, write: (c, v) => { c.fileTypes = v; },
    },
    allowNoExpiry: {
        group: 'Stashes', label: 'Allow stashes that never expire', type: 'bool',
        help: 'Adds a "Never" choice to the expiry list.',
        read: c => c.allowNoExpiry,
        write: (c, v) => {
            c.allowNoExpiry = v;
            c.ttlOptions = c.ttlOptions.filter(option => option.key !== 'never');
            if (v) c.ttlOptions.push({ key: 'never', label: 'Never', ms: null });
        },
    },
    defaultTtl: {
        group: 'Stashes', label: 'Default expiry', type: 'choice',
        // The choices follow the expiry list, which grows a "Never" once that is allowed
        options: c => c.ttlOptions.map(option => ({ value: option.key, label: option.label })),
        help: 'What the expiry box on the home page starts on. People can still pick another.',
        read: c => c.defaultTtl, write: (c, v) => { c.defaultTtl = v; },
    },
    undoSeconds: {
        group: 'Stashes', label: 'Undo a delete for', unit: 'seconds', type: 'int', min: 0, max: 3600,
        help: 'After someone deletes a note or file, it can be brought back for this long (a deleted item stays in the database until then). Burn-after-reading and secret notes, and anything removed automatically, are never kept. 0 turns undo off: deletes are immediate.',
        read: c => c.undoSeconds, write: (c, v) => { c.undoSeconds = v; },
    },
    requireAdminToCreate: {
        group: 'Stashes', label: 'Only the admin can create stashes', type: 'bool',
        help: 'Visitors can still open and use stashes they have the link to.',
        read: c => c.requireAdminToCreate, write: (c, v) => { c.requireAdminToCreate = v; },
    },
    adminCanResetStashPasswords: {
        group: 'Stashes', label: 'Admin can reset passwords of stashes', type: 'bool',
        help: 'Lets an admin choose a new password for a stash that no signed-in user made (and so get into it). Stashes with an owner can never be reset by an admin. Turn it off and the admin can only delete or extend such a stash.',
        read: c => c.adminCanResetStashPasswords, write: (c, v) => { c.adminCanResetStashPasswords = v; },
    },
    rateCreate: {
        group: 'Rate limits', label: 'Stashes created', unit: 'per minute per address', type: 'int', min: 1, max: 100000,
        help: 'How many stashes one address may create a minute.',
        read: c => c.rateCreate, write: (c, v) => { c.rateCreate = v; },
    },
    ratePost: {
        group: 'Rate limits', label: 'Notes added', unit: 'per minute per address', type: 'int', min: 1, max: 100000,
        help: 'How many notes, pins and other changes one address may make a minute.',
        read: c => c.ratePost, write: (c, v) => { c.ratePost = v; },
    },
    rateUpload: {
        group: 'Rate limits', label: 'Files uploaded', unit: 'per minute per address', type: 'int', min: 1, max: 100000,
        help: 'How many files one address may start uploading a minute.',
        read: c => c.rateUpload, write: (c, v) => { c.rateUpload = v; },
    },
    rateRead: {
        group: 'Rate limits', label: 'Reading', unit: 'per minute per address', type: 'int', min: 10, max: 1000000,
        help: 'Opening stashes, listing items and downloading files. Pages and live updates count too, so keep it generous.',
        read: c => c.rateRead, write: (c, v) => { c.rateRead = v; },
    },
    requireLoginToCreate: {
        group: 'Stashes', label: 'Only signed-in users can create stashes', type: 'bool',
        help: 'Users the admin made, and admins, can create stashes; anyone else can still open and use stashes they have the link to. "Only the admin" above wins when both are on.',
        read: c => c.requireLoginToCreate, write: (c, v) => { c.requireLoginToCreate = v; },
    },
};

class SettingsStore {
    constructor({ model, config }) {
        this.model = model;
        this.config = config;
        this.defaults = this.values();
        const saved = model.loadSettings();
        for (const key of Object.keys(saved)) {
            if (FIELDS[key] && this.check(key, saved[key], { ...this.values(), ...saved }) === null) FIELDS[key].write(config, saved[key]);
        }
        this.normalise();
    }

    // "Only the admin can create" makes no sense when there is no admin, and accounts only exist with the admin area
    normalise() {
        if (!this.config.ttlOptions.some(option => option.key === this.config.defaultTtl)) this.config.defaultTtl = '1d';
        if (!this.config.adminPassword) {
            this.config.requireAdminToCreate = false;
            this.config.requireLoginToCreate = false;
        }
    }

    values() {
        const out = {};
        for (const key of Object.keys(FIELDS)) out[key] = FIELDS[key].read(this.config);
        return out;
    }

    // What the admin page needs to draw the form
    describe() {
        const values = this.values();
        return Object.keys(FIELDS).map(key => {
            const { group, label, unit, type, min, max, help } = FIELDS[key];
            return { key, group, label, unit, type, min, max, help, options: this.optionsOf(key), value: values[key], default: this.defaults[key] };
        });
    }

    // The choices of a "choice" field: a fixed list, or one worked out from the current settings
    optionsOf(key) {
        const options = FIELDS[key].options;
        return typeof options === 'function' ? options(this.config) : options;
    }

    // Returns an error message, or null when the value is fine. `merged` is every value as it would be after the update
    // (a default expiry of "Never" is fine when "Never" is being allowed in the same save).
    check(key, value, merged) {
        const field = FIELDS[key];
        if (field.type === 'bool') return typeof value === 'boolean' ? null : 'Must be on or off.';
        if (key === 'defaultTtl') {
            const keys = this.config.ttlOptions.filter(option => option.key !== 'never').map(option => option.key);
            if (merged && merged.allowNoExpiry) keys.push('never');
            return keys.includes(value) ? null : 'Pick one of the expiry choices.';
        }
        if (field.type === 'choice') return this.optionsOf(key).some(option => option.value === value) ? null : 'Pick one of the choices.';
        if (!Number.isInteger(value)) return 'Enter a whole number.';
        if (value < field.min || value > field.max) return `Enter a number from ${field.min} to ${field.max}.`;
        return null;
    }

    // Applies and saves a partial update. Returns { values } or { errors } (nothing is applied on errors).
    update(input) {
        const errors = {};
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: 'Send the settings to change.' } };
        const merged = { ...this.values(), ...input };
        for (const key of Object.keys(input)) {
            if (!FIELDS[key]) errors[key] = 'Unknown setting.';
            else {
                const problem = this.check(key, input[key], merged);
                if (problem) errors[key] = problem;
            }
        }
        if (!errors.maxItemsPerStash && !errors.maxFilesPerStash && merged.maxItemsPerStash < merged.maxFilesPerStash) {
            errors.maxItemsPerStash = 'Must be at least the number of files per stash.';
        }
        if (merged.requireAdminToCreate && !this.config.adminPassword) errors.requireAdminToCreate = 'Admin is not enabled.';
        if (merged.requireLoginToCreate && !this.config.adminPassword) errors.requireLoginToCreate = 'Accounts are not enabled (they need the admin area).';
        if (Object.keys(errors).length) return { errors };

        for (const key of Object.keys(input)) FIELDS[key].write(this.config, input[key]);
        this.normalise();
        this.save();
        return { values: this.values() };
    }

    // Only what differs from the defaults is stored, so untouched settings keep following the environment
    save() {
        const values = this.values();
        const overrides = {};
        for (const key of Object.keys(FIELDS)) {
            if (values[key] !== this.defaults[key]) overrides[key] = values[key];
        }
        this.model.saveSettings(overrides);
    }

    reset() {
        for (const key of Object.keys(FIELDS)) FIELDS[key].write(this.config, this.defaults[key]);
        this.normalise();
        this.model.saveSettings({});
        return { values: this.values() };
    }
}

module.exports = { SettingsStore, FIELDS };
