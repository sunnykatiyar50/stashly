// Uploads: one file at a time, queued, each with a progress bar. A small file goes up in one request. A big one goes up
// in pieces (resumable uploads, see the README): each piece is checked by the server, a dropped connection costs at
// most one piece, and picking the same file again after a reload carries on where it stopped.
// Exposed as window.StashlyUpload; stash.js wires it to the page.
(function () {
    'use strict';

    // Files bigger than this go up in pieces; smaller ones use the single request
    var CHUNKED_ABOVE = 8 * 1024 * 1024;
    // The size of a piece (the server may ask for smaller ones)
    var CHUNK_SIZE = 4 * 1024 * 1024;
    // A piece that fails is tried again this many times before the upload stops (and can be resumed by hand)
    var CHUNK_RETRIES = 3;
    var RETRY_DELAY_MS = 800; // doubled for each try

    // Pasted screenshots arrive as a generic "image.png"; give them a useful name
    function nameFor(file) {
        var name = file.name || '';
        var generic = !name || /^image\.(png|jpe?g|gif|webp)$/i.test(name);
        var ext = /\.[A-Za-z0-9]+$/.test(name) ? name.slice(name.lastIndexOf('.')) : '';
        if (!ext) {
            var fromType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.type];
            ext = fromType || '';
        }
        if (!generic) return name + (name.indexOf('.') === -1 ? ext : '');
        var d = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
        return 'pasted-' + stamp + (ext || '.png');
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    // The id of an unfinished upload is kept for this tab (sessionStorage) under the file's name, size and date, so
    // choosing the same file again resumes it. Storage can be blocked or full: then there is just no resuming.
    function rememberKey(url, file) {
        return 'sl_upload:' + url + ':' + file.name + ':' + file.size + ':' + (file.lastModified || 0);
    }
    function remembered(key) {
        try { return window.sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
    }
    function remember(key, id) {
        try { window.sessionStorage.setItem(key, id); } catch (e) { /* no storage: it just will not resume */ }
    }
    function forget(key) {
        try { window.sessionStorage.removeItem(key); } catch (e) { /* nothing to forget */ }
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // Resolves at once when the browser thinks it is online, otherwise when it comes back
    function whenOnline() {
        if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
        return new Promise(function (resolve) {
            window.addEventListener('online', function once() {
                window.removeEventListener('online', once);
                resolve();
            });
        });
    }

    function create(options) {
        var queue = [];
        var running = false;
        var container = options.container;

        function row(name, size) {
            var el = document.createElement('div');
            el.className = 'upload-row';
            var label = document.createElement('span');
            label.className = 'upload-name';
            label.textContent = name;
            label.title = name;
            var sizeLabel = document.createElement('span');
            sizeLabel.className = 'upload-size';
            sizeLabel.textContent = formatSize(size);
            label.appendChild(sizeLabel);
            var bar = document.createElement('span');
            bar.className = 'upload-bar';
            var fill = document.createElement('span');
            bar.appendChild(fill);
            var status = document.createElement('span');
            status.className = 'upload-status';
            status.textContent = 'Waiting';
            el.appendChild(label);
            el.appendChild(bar);
            el.appendChild(status);
            container.appendChild(el);
            return { el: el, fill: fill, bar: bar, status: status };
        }

        function fail(ui, message) {
            ui.el.classList.add('failed');
            ui.status.textContent = message;
            var dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.className = 'ghost small';
            dismiss.textContent = 'Dismiss';
            dismiss.addEventListener('click', function () { ui.el.remove(); });
            ui.el.appendChild(dismiss);
        }

        function send(job) {
            if (job.file.size > CHUNKED_ABOVE && options.uploadsUrl && window.fetch && window.Blob && Blob.prototype.slice) return sendChunked(job);
            return new Promise(function (resolve) {
                var ui = job.ui;
                var xhr = new XMLHttpRequest();
                xhr.open('POST', options.url);
                xhr.withCredentials = true;
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.setRequestHeader('X-File-Name', encodeURIComponent(job.name));
                if (job.title) xhr.setRequestHeader('X-Title', encodeURIComponent(job.title));
                // Lets the page tell its own uploads from ones that arrive from another device
                if (options.tabId) xhr.setRequestHeader('X-Tab-Id', options.tabId);
                xhr.upload.onprogress = function (event) {
                    if (!event.lengthComputable) return;
                    var pct = Math.round((event.loaded / event.total) * 100);
                    ui.fill.style.width = pct + '%';
                    ui.status.textContent = pct + '%';
                };
                xhr.onload = function () {
                    var body = null;
                    try { body = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
                    if (xhr.status >= 200 && xhr.status < 300) {
                        ui.el.remove();
                        // The file is handed back too: the page makes the image's thumbnail from it, with no second download
                        if (options.onDone) options.onDone(body, job.file);
                    } else if (xhr.status === 401 && options.onLocked) {
                        ui.el.remove();
                        options.onLocked();
                    } else {
                        fail(ui, (body && body.error) || 'Upload failed (' + xhr.status + ')');
                    }
                    resolve();
                };
                xhr.onerror = function () { fail(ui, 'Could not reach the server'); resolve(); };
                ui.status.textContent = '0%';
                xhr.send(job.file);
            });
        }

        // ---- big files: a resumable upload in pieces ----

        // One request to the uploads address. Resolves { status, body, offset } and never rejects: a connection that
        // fails comes back as status 0.
        function call(method, url, init) {
            init = init || {};
            var headers = { 'X-Tab-Id': options.tabId || '' };
            if (init.json) headers['Content-Type'] = 'application/json';
            if (init.offset !== undefined) {
                headers['Upload-Offset'] = String(init.offset);
                headers['Content-Type'] = 'application/octet-stream';
            }
            return fetch(url, {
                method: method,
                credentials: 'same-origin',
                headers: headers,
                body: init.json ? JSON.stringify(init.json) : init.body,
            }).then(function (res) {
                return res.json().catch(function () { return null; }).then(function (body) {
                    var offset = body && typeof body.offset === 'number' ? body.offset : null;
                    return { status: res.status, body: body, offset: offset };
                });
            }, function () {
                return { status: 0, body: null, offset: null };
            });
        }

        function messageOf(res, fallback) {
            return (res.body && res.body.error) || fallback;
        }

        // Progress as the bar and as text (a screen reader gets it from the live status and the progressbar role)
        function showProgress(job, offset) {
            var pct = Math.min(100, Math.floor((offset / job.file.size) * 100));
            job.ui.fill.style.width = pct + '%';
            job.ui.status.textContent = pct + '%';
            job.ui.bar.setAttribute('aria-valuenow', String(pct));
            job.ui.status.setAttribute('aria-label', 'Uploading ' + job.name + ' ' + pct + '%');
        }

        function sendChunked(job) {
            return new Promise(function (resolve) {
                var ui = job.ui;
                var file = job.file;
                var uploads = options.uploadsUrl;
                var key = rememberKey(uploads, file);
                var base = null; // the address of this upload, once there is one
                var chunk = CHUNK_SIZE;
                ui.bar.setAttribute('role', 'progressbar');
                ui.bar.setAttribute('aria-label', 'Uploading ' + job.name);
                ui.bar.setAttribute('aria-valuemin', '0');
                ui.bar.setAttribute('aria-valuemax', '100');
                ui.status.setAttribute('aria-live', 'polite');

                // The stash is locked (401): the page asks for the password; nothing here can go on
                function locked() {
                    forget(key);
                    ui.el.remove();
                    if (options.onLocked) options.onLocked();
                    resolve();
                }
                // Stops with a message. keep: the upload stays on the server and in this tab's memory, so choosing the
                // same file again resumes it.
                function stop(text, keep) {
                    if (!keep) forget(key);
                    fail(ui, text);
                    resolve();
                }
                function gone() {
                    stop('The stash or the upload is gone. Choose the file again to start over.', false);
                }
                // A refusal that trying again will not change: the upload is cancelled on the server
                function refused(res) {
                    if (base) call('DELETE', base);
                    stop(messageOf(res, 'Upload failed (' + res.status + ')'), false);
                }
                function retryable(res) {
                    return res.status === 0 || res.status === 429 || res.status >= 500;
                }
                function backoff(failures) {
                    return whenOnline().then(function () { return sleep(RETRY_DELAY_MS * Math.pow(2, failures)); });
                }

                // Every byte is there: make it an item
                function finish(failures) {
                    ui.status.textContent = 'Finishing';
                    return call('POST', base + '/complete').then(function (res) {
                        if (res.status >= 200 && res.status < 300) {
                            forget(key);
                            ui.el.remove();
                            // The file is handed back too: the page makes an image's thumbnail from it
                            if (options.onDone) options.onDone(res.body, file);
                            return resolve();
                        }
                        if (res.status === 401) return locked();
                        if (res.status === 404) {
                            // The answer to a complete that worked can be lost, and then the upload no longer exists
                            if (failures) return stop('The upload may have finished. Check the list before sending it again.', false);
                            return gone();
                        }
                        if (res.status === 409 && res.offset !== null && res.offset < file.size) return sendFrom(res.offset, 0);
                        if (retryable(res)) {
                            if (failures >= CHUNK_RETRIES) return stop('Could not reach the server. Choose the file again to resume.', true);
                            return backoff(failures).then(function () { return finish(failures + 1); });
                        }
                        // Over a limit right now: the upload is kept, so it can finish once there is room
                        if (res.status === 413 || res.status === 507) return stop(messageOf(res, 'The stash has no room for this file.'), true);
                        return refused(res);
                    });
                }

                // Sends the piece that starts at offset, then the next, to the end. failures: how many tries of this
                // piece have failed.
                function sendFrom(offset, failures) {
                    if (offset >= file.size) return finish(0);
                    showProgress(job, offset);
                    var piece = file.slice(offset, Math.min(file.size, offset + chunk));
                    return call('PATCH', base, { offset: offset, body: piece }).then(function (res) {
                        if (res.status >= 200 && res.status < 300 && res.offset !== null) return sendFrom(res.offset, 0);
                        if (res.status === 401) return locked();
                        if (res.status === 404) return gone();
                        // Not where the server is (a piece got through but its answer was lost): go on from there
                        if (res.status === 409 && res.offset !== null && !(res.body && res.body.busy)) return sendFrom(res.offset, 0);
                        if (!retryable(res) && res.status !== 409) return refused(res);
                        if (failures >= CHUNK_RETRIES) {
                            return stop('The connection failed at ' + Math.floor((offset / file.size) * 100) + '%. Choose the file again to resume.', true);
                        }
                        ui.status.textContent = navigator.onLine === false ? 'Waiting for the connection' : 'Retrying';
                        // Ask the server where it is: the piece may have arrived after all
                        return backoff(failures)
                            .then(function () { return call('GET', base); })
                            .then(function (where) {
                                if (where.status === 401) return locked();
                                if (where.status === 404) return gone();
                                return sendFrom(where.offset !== null ? where.offset : offset, failures + 1);
                            });
                    });
                }

                function startNew() {
                    var payload = { name: job.name, size: file.size };
                    if (job.title) payload.title = job.title;
                    return call('POST', uploads, { json: payload }).then(function (res) {
                        if (res.status === 401) return locked();
                        if (res.status < 200 || res.status >= 300) {
                            return stop(res.status === 0 ? 'Could not reach the server' : messageOf(res, 'Upload failed (' + res.status + ')'), false);
                        }
                        base = uploads + '/' + res.body.id;
                        if (res.body.chunkSize) chunk = Math.min(CHUNK_SIZE, res.body.chunkSize);
                        remember(key, res.body.id);
                        return sendFrom(res.body.offset || 0, 0);
                    });
                }

                ui.status.textContent = '0%';
                // The same file chosen again (after a reload or a stop): is its upload still there?
                var old = remembered(key);
                if (!old) return startNew();
                base = uploads + '/' + encodeURIComponent(old);
                call('GET', base).then(function (res) {
                    if (res.status === 401) return locked();
                    if (res.status >= 200 && res.status < 300 && res.offset !== null) {
                        if (res.body.chunkSize) chunk = Math.min(CHUNK_SIZE, res.body.chunkSize);
                        // The server keeps what it already got; this goes on from there
                        return sendFrom(res.offset, 0);
                    }
                    // Gone (finished, expired, or the stash was renamed): start again
                    forget(key);
                    base = null;
                    return startNew();
                });
            });
        }

        function next() {
            if (running) return;
            var job = queue.shift();
            if (!job) return;
            running = true;
            send(job).then(function () {
                running = false;
                next();
            });
        }

        return {
            // extra.title (optional) is sent as the file's title, in the X-Title header
            add: function (files, extra) {
                var title = extra && extra.title ? String(extra.title) : '';
                Array.prototype.forEach.call(files, function (file) {
                    var name = nameFor(file);
                    var ui = row(name, file.size);
                    if (options.maxBytes && file.size > options.maxBytes) {
                        fail(ui, 'Too large (' + formatSize(file.size) + '; the limit is ' + formatSize(options.maxBytes) + ')');
                        return;
                    }
                    if (!file.size) {
                        fail(ui, 'The file is empty');
                        return;
                    }
                    queue.push({ file: file, name: name, ui: ui, title: title });
                });
                next();
            },
        };
    }

    window.StashlyUpload = { create: create, formatSize: formatSize };
})();
