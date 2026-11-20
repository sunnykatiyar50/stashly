const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Converts a calendar date (YYYY-MM-DD) in the caller's time zone to the ISO instant it starts at.
// `tz` is the browser's Date.getTimezoneOffset() in minutes (minutes behind UTC), 0 when absent.
function dayStart(value, tz = 0) {
    const match = DATE_RE.exec(value || '');
    if (!match) return null;
    const [, y, m, d] = match.map(Number);
    const ms = Date.UTC(y, m - 1, d);
    const check = new Date(ms);
    // Rejects dates like 2026-02-31 that JavaScript would roll over
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    return new Date(ms + tz * 60000);
}

// Inclusive range: from the start of startDate up to (not including) the start of the day after endDate
function dateRange({ startDate, endDate, tz }) {
    const offset = Number.isFinite(Number(tz)) ? Number(tz) : 0;
    const range = {};
    if (startDate) {
        const from = dayStart(startDate, offset);
        if (!from) return { error: 'startDate must look like 2026-01-31.' };
        range.from = from.toISOString();
    }
    if (endDate) {
        const to = dayStart(endDate, offset);
        if (!to) return { error: 'endDate must look like 2026-01-31.' };
        range.to = new Date(to.getTime() + 24 * 60 * 60 * 1000).toISOString();
    }
    if (range.from && range.to && range.from >= range.to) return { error: 'startDate must not be after endDate.' };
    return range;
}

module.exports = { dateRange };
