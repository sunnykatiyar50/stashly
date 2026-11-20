const MB = 1024 * 1024;
const round = value => Math.round(value * 100) / 100;

// The limits the admin can change at runtime. The environment gives the defaults; changes made in the admin
// page are saved in the database and win over them (until "Reset to defaults").
const FIELDS = {
    maxFileMb: {
        label: 'Largest file', unit: 'MB', type: 'int', min: 1, max: 2048,
        help: 'The biggest single file that can be uploaded.',
        read: c => round(c.maxFileBytes / MB), write: (c, v) => { c.maxFileBytes = v * MB; },
    },
    maxFilesPerStash: {
        label: 'Files per stash', unit: 'files', type: 'int', min: 1, max: 100000,
        help: 'How many files one stash can hold.',
        read: c => c.maxFilesPerStash, write: (c, v) => { c.maxFilesPerStash = v; },
    },
    maxItemsPerStash: {
        label: 'Items per stash', unit: 'items', type: 'int', min: 1, max: 200000,
        help: 'Notes and files together. Keep it at or above the file limit.',
        read: c => c.maxItemsPerStash, write: (c, v) => { c.maxItemsPerStash = v; },
    },
    maxStashMb: {
        label: 'File space per stash', unit: 'MB', type: 'int', min: 1, max: 1048576,
        help: 'Total size of the files in one stash.',
        read: c => round(c.maxStashBytes / MB), write: (c, v) => { c.maxStashBytes = v * MB; },
    },
    maxTotalMb: {
        label: 'File space on the server', unit: 'MB', type: 'int', min: 1, max: 10485760,
        help: 'Total size of all files in all stashes. Protects the disk.',
        read: c => round(c.maxTotalBytes / MB), write: (c, v) => { c.maxTotalBytes = v * MB; },
    },
    maxNoteKb: {
        label: 'Largest note', unit: 'KB', type: 'int', min: 1, max: 10240,
        help: 'The biggest single note.',
        read: c => round(c.maxNoteBytes / 1024), write: (c, v) => { c.maxNoteBytes = v * 1024; },
    },
    maxStashes: {
        label: 'Stashes on the server', unit: 'stashes', type: 'int', min: 1, max: 1000000,
        help: 'New stashes are refused once this many exist.',
        read: c => c.maxStashes, write: (c, v) => { c.maxStashes = v; },
    },
    minOpenNameLength: {
        label: 'Shortest name without a password', unit: 'characters', type: 'int', min: 0, max: 64,
        help: 'A stash with no password is protected only by its name. Names shorter than this need a password. 0 turns the rule off. Stashes that already exist are not changed.',
        read: c => c.minOpenNameLength, write: (c, v) => { c.minOpenNameLength = v; },
    },
    fileTypes: {
        label: 'File types', type: 'choice',
        options: [
            { value: 'safe', label: 'Safe list: images, audio, video, PDF, zip, Office files, certificates, text' },
            { value: 'no-programs', label: 'Any file except programs' },
            { value: 'any', label: 'Any file at all' },
        ],
        help: 'Which files can be uploaded. "Except programs" also allows archives and other binaries, but still refuses executables, SVG and macro-enabled Office files. Uploads are never run or shown by Stashly, whatever the type.',
        read: c => c.fileTypes, write: (c, v) => { c.fileTypes = v; },
    },
    allowNoExpiry: {
        label: 'Allow stashes that never expire', type: 'bool',
        help: 'Adds a "Never" choice to the expiry list.',
        read: c => c.allowNoExpiry,
        write: (c, v) => {
            c.allowNoExpiry = v;
            c.ttlOptions = c.ttlOptions.filter(option => option.key !== 'never');
            if (v) c.ttlOptions.push({ key: 'never', label: 'Never', ms: null });
        },
    },
    requireAdminToCreate: {
        label: 'Only the admin can create stashes', type: 'bool',
        help: 'Visitors can still open and use stashes they have the link to.',
        read: c => c.requireAdminToCreate, write: (c, v) => { c.requireAdminToCreate = v; },
    },
};

class SettingsStore {
    constructor({ model, config }) {
        this.model = model;
        this.config = config;
        this.defaults = this.values();
        const saved = model.loadSettings();
        for (const key of Object.keys(saved)) {
            if (FIELDS[key] && this.check(key, saved[key]) === null) FIELDS[key].write(config, saved[key]);
        }
        this.normalise();
    }

    // "Only the admin can create" makes no sense when there is no admin
    normalise() {
        if (!this.config.adminPassword) this.config.requireAdminToCreate = false;
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
            const { label, unit, type, min, max, help, options } = FIELDS[key];
            return { key, label, unit, type, min, max, help, options, value: values[key], default: this.defaults[key] };
        });
    }

    // Returns an error message, or null when the value is fine
    check(key, value) {
        const field = FIELDS[key];
        if (field.type === 'bool') return typeof value === 'boolean' ? null : 'Must be on or off.';
        if (field.type === 'choice') return field.options.some(option => option.value === value) ? null : 'Pick one of the choices.';
        if (!Number.isInteger(value)) return 'Enter a whole number.';
        if (value < field.min || value > field.max) return `Enter a number from ${field.min} to ${field.max}.`;
        return null;
    }

    // Applies and saves a partial update. Returns { values } or { errors } (nothing is applied on errors).
    update(input) {
        const errors = {};
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: 'Send the settings to change.' } };
        for (const key of Object.keys(input)) {
            if (!FIELDS[key]) errors[key] = 'Unknown setting.';
            else {
                const problem = this.check(key, input[key]);
                if (problem) errors[key] = problem;
            }
        }
        const merged = { ...this.values(), ...input };
        if (!errors.maxItemsPerStash && !errors.maxFilesPerStash && merged.maxItemsPerStash < merged.maxFilesPerStash) {
            errors.maxItemsPerStash = 'Must be at least the number of files per stash.';
        }
        if (merged.requireAdminToCreate && !this.config.adminPassword) errors.requireAdminToCreate = 'Admin is not enabled.';
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
