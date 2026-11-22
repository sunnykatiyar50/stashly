// A tiny in-memory metrics registry that writes the Prometheus text format (version 0.0.4), with no dependency.
// Counters and the request histogram live here and start from zero at every restart, as Prometheus expects. Gauges
// (how many stashes, items, bytes...) are not stored: they are read from the database when /metrics is scraped.
//
// Labels are limited to values the server itself chooses (route PATTERNS, status classes, kinds). Never put a stash
// name or anything a visitor typed into a label: every new value would be a new series, and a name is a secret.

// Seconds. Event streams stay open much longer than the last bucket; they land in +Inf.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

// name -> { type, help, labels (names, in order), initial (label sets that show 0 before the first event) }
const DEFINITIONS = {
    stashly_http_requests_total: { type: 'counter', help: 'Finished HTTP requests, by method, route pattern and status class.', labels: ['method', 'route', 'status_class'] },
    stashly_http_request_duration_seconds: { type: 'histogram', help: 'Time to answer a request, by route pattern.', labels: ['route'] },
    stashly_unlock_failures_total: { type: 'counter', help: 'Wrong stash passwords entered.', labels: [] },
    stashly_uploads_total: { type: 'counter', help: 'Files uploaded.', labels: [] },
    stashly_uploaded_bytes_total: { type: 'counter', help: 'Bytes of files uploaded.', labels: [] },
    stashly_exports_total: { type: 'counter', help: 'Stash exports started.', labels: [] },
    stashly_admin_logins_total: {
        type: 'counter',
        help: 'Admin sign-in attempts that reached the server, by result.',
        labels: ['result'],
        initial: [['success'], ['failure']],
    },
    stashly_user_logins_total: {
        type: 'counter',
        help: 'User account sign-in attempts that reached the server, by result.',
        labels: ['result'],
        initial: [['success'], ['failure']],
    },
};

const escapeLabel = value => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const formatLabels = (names, values, extra = '') => {
    const parts = names.map((name, i) => `${name}="${escapeLabel(values[i])}"`);
    if (extra) parts.push(extra);
    return parts.length ? `{${parts.join(',')}}` : '';
};

class Metrics {
    constructor() {
        this.series = new Map(); // metric name -> Map(label key -> { values, value } or histogram state)
        for (const [name, def] of Object.entries(DEFINITIONS)) {
            const map = new Map();
            this.series.set(name, map);
            for (const values of def.initial || []) map.set(values.join('\u0000'), { values, value: 0 });
            if (def.type === 'counter' && !def.labels.length) map.set('', { values: [], value: 0 });
        }
    }

    // Adds to a counter. `values` are the label values in the order the metric defines them.
    inc(name, values = [], by = 1) {
        const map = this.series.get(name);
        if (!map) return;
        const key = values.join('\u0000');
        const entry = map.get(key);
        if (entry) entry.value += by;
        else map.set(key, { values, value: by });
    }

    // Records one duration (seconds) in a histogram
    observe(name, values, seconds) {
        const map = this.series.get(name);
        if (!map) return;
        const key = values.join('\u0000');
        let entry = map.get(key);
        if (!entry) {
            entry = { values, counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
            map.set(key, entry);
        }
        BUCKETS.forEach((bound, i) => {
            if (seconds <= bound) entry.counts[i] += 1;
        });
        entry.sum += seconds;
        entry.count += 1;
    }

    // Fed by the access log: one finished request
    recordRequest({ method, route, status, ms }) {
        this.inc('stashly_http_requests_total', [method, route, `${Math.floor(status / 100)}xx`]);
        this.observe('stashly_http_request_duration_seconds', [route], ms / 1000);
    }

    // The exposition text. `gauges` are read by the caller at scrape time:
    // [{ name, help, samples: [{ labels: { kind: 'note' }, value: 3 }] }]
    render(gauges = []) {
        const lines = [];
        for (const [name, def] of Object.entries(DEFINITIONS)) {
            lines.push(`# HELP ${name} ${def.help}`, `# TYPE ${name} ${def.type}`);
            const entries = [...this.series.get(name).values()].sort((a, b) => a.values.join('/').localeCompare(b.values.join('/')));
            for (const entry of entries) {
                if (def.type === 'counter') {
                    lines.push(`${name}${formatLabels(def.labels, entry.values)} ${entry.value}`);
                    continue;
                }
                BUCKETS.forEach((bound, i) => lines.push(`${name}_bucket${formatLabels(def.labels, entry.values, `le="${bound}"`)} ${entry.counts[i]}`));
                lines.push(`${name}_bucket${formatLabels(def.labels, entry.values, 'le="+Inf"')} ${entry.count}`);
                lines.push(`${name}_sum${formatLabels(def.labels, entry.values)} ${entry.sum}`);
                lines.push(`${name}_count${formatLabels(def.labels, entry.values)} ${entry.count}`);
            }
        }
        for (const gauge of gauges) {
            lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
            for (const sample of gauge.samples) {
                const names = Object.keys(sample.labels || {});
                lines.push(`${gauge.name}${formatLabels(names, names.map(n => sample.labels[n]))} ${sample.value}`);
            }
        }
        return `${lines.join('\n')}\n`;
    }
}

const noopMetrics = { inc() {}, observe() {}, recordRequest() {} };

module.exports = { Metrics, noopMetrics, BUCKETS };
