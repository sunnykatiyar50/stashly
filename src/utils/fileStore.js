const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Where uploaded files live: one plain file per item, named by the item's id, in a folder next to the database.
// Keeping them out of SQLite means a download streams straight from disk (no 25 MB copy in memory, and the database
// stays small and quick to back up), and an upload is written as it arrives.
//
// The folder is created when first needed. An upload is received into tmp/ and moved to its final name once the
// database row exists, so a half-finished upload is never taken for a file. Anything left behind by a crash (a file
// with no item, a stale tmp/ upload) is removed by sweep() at startup.
const HEAD_BYTES = 8192; // what file type detection looks at

class FileStore {
    constructor(dir) {
        this.dir = dir;
        this.tmpDir = path.join(dir, 'tmp');
    }

    ensure() {
        fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    }

    pathOf(id) {
        return path.join(this.dir, String(Number(id)));
    }

    // ---- writing ----

    // Reads a request body into a new file under tmp/, without holding it in memory. Resolves with
    // { tmp, size, head } (head = the first bytes, for file type detection). Rejects with err.code 'TOO_LARGE' when it
    // passes maxBytes (the upload is dropped and the connection should be closed), or when the client goes away.
    receive(req, maxBytes) {
        this.ensure();
        const tmp = path.join(this.tmpDir, crypto.randomBytes(12).toString('hex'));
        return new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
            const heads = [];
            let headLength = 0;
            let size = 0;
            let done = false;

            const finish = err => {
                if (done) return;
                done = true;
                req.off('data', onData);
                req.off('end', onEnd);
                req.off('error', onError);
                req.off('aborted', onError);
                req.off('close', onClose);
                if (!err) return resolve({ tmp, size, head: Buffer.concat(heads, headLength) });
                req.pause();
                out.destroy();
                fs.rm(tmp, { force: true }, () => reject(err));
            };
            const onData = chunk => {
                size += chunk.length;
                if (size > maxBytes) {
                    const err = new Error('The file is too large.');
                    err.code = 'TOO_LARGE';
                    return finish(err);
                }
                if (headLength < HEAD_BYTES) {
                    const part = chunk.subarray(0, HEAD_BYTES - headLength);
                    heads.push(part);
                    headLength += part.length;
                }
                // Wait for the disk when it cannot keep up with the network
                if (!out.write(chunk)) {
                    req.pause();
                    out.once('drain', () => req.resume());
                }
            };
            const onEnd = () => out.end(() => finish(null));
            const onError = err => finish(err instanceof Error ? err : new Error('The upload was interrupted.'));
            const onClose = () => {
                // Closed before the body finished
                if (!req.complete) finish(new Error('The upload was interrupted.'));
            };
            out.on('error', finish);
            req.on('data', onData);
            req.on('end', onEnd);
            req.on('error', onError);
            req.on('aborted', onError);
            req.on('close', onClose);
        });
    }

    // Gives a received upload its final name (it is the item's file from now on)
    adopt(tmp, id) {
        fs.renameSync(tmp, this.pathOf(id));
    }

    // Drops an upload that was not used
    discard(tmp) {
        if (tmp) fs.rmSync(tmp, { force: true });
    }

    // Writes a file's bytes under its item id (used when moving files out of the old database layout)
    write(id, bytes) {
        this.ensure();
        fs.writeFileSync(this.pathOf(id), bytes, { mode: 0o600 });
    }

    // ---- reading ----

    exists(id) {
        try {
            return fs.statSync(this.pathOf(id)).isFile();
        } catch {
            return false;
        }
    }

    size(id) {
        try {
            return fs.statSync(this.pathOf(id)).size;
        } catch {
            return null;
        }
    }

    // A stream of the file, or of just bytes start..end (both inclusive) for a range request
    stream(id, range) {
        return fs.createReadStream(this.pathOf(id), range ? { start: range.start, end: range.end } : undefined);
    }

    readAll(id) {
        return fs.promises.readFile(this.pathOf(id));
    }

    // ---- removing ----

    // Deletes files. Like the database (secure_delete), the bytes are overwritten with zeros first, so a deleted or
    // expired file cannot be read back from free disk space by a simple undelete.
    remove(ids) {
        for (const id of ids) this.wipe(this.pathOf(id));
    }

    // Overwrites a file with zeros, then removes it
    wipe(file) {
        try {
            const { size } = fs.statSync(file);
            const fd = fs.openSync(file, 'r+');
            try {
                const zeros = Buffer.alloc(Math.min(size, 1 << 20));
                for (let written = 0; written < size; written += zeros.length) {
                    fs.writeSync(fd, zeros, 0, Math.min(zeros.length, size - written), written);
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // missing or unreadable: still try to remove it below
        }
        try {
            fs.rmSync(file, { force: true });
        } catch {
            // not a file we can remove (for example a folder someone put here): leave it
        }
    }

    // Removes every file whose item no longer exists, and any leftover upload. `liveIds` is the set of item ids that
    // should have a file. Returns how many files were removed.
    sweep(liveIds) {
        if (!fs.existsSync(this.dir)) return 0;
        let removed = 0;
        for (const name of fs.readdirSync(this.dir)) {
            if (name === 'tmp') continue;
            if (!/^\d+$/.test(name) || !liveIds.has(Number(name))) {
                this.wipe(path.join(this.dir, name));
                removed++;
            }
        }
        if (fs.existsSync(this.tmpDir)) {
            for (const name of fs.readdirSync(this.tmpDir)) {
                fs.rmSync(path.join(this.tmpDir, name), { force: true });
                removed++;
            }
        }
        return removed;
    }

    // How many files are stored (for tests and the admin)
    count() {
        if (!fs.existsSync(this.dir)) return 0;
        return fs.readdirSync(this.dir).filter(name => /^\d+$/.test(name)).length;
    }
}

module.exports = { FileStore, HEAD_BYTES };
