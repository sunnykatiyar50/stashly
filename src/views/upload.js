// Uploads: one file per request with a progress bar, queued so files go up one after another.
// Exposed as window.StashlyUpload; stash.js wires it to the page.
(function () {
    'use strict';

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

    function create(options) {
        var queue = [];
        var running = false;
        var container = options.container;

        function row(name) {
            var el = document.createElement('div');
            el.className = 'upload-row';
            var label = document.createElement('span');
            label.className = 'upload-name';
            label.textContent = name;
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
            return { el: el, fill: fill, status: status };
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
            return new Promise(function (resolve) {
                var ui = job.ui;
                var xhr = new XMLHttpRequest();
                xhr.open('POST', options.url);
                xhr.withCredentials = true;
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.setRequestHeader('X-File-Name', encodeURIComponent(job.name));
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
                        if (options.onDone) options.onDone(body);
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
            add: function (files) {
                Array.prototype.forEach.call(files, function (file) {
                    var name = nameFor(file);
                    var ui = row(name);
                    if (options.maxBytes && file.size > options.maxBytes) {
                        fail(ui, 'Too large (' + formatSize(file.size) + '; the limit is ' + formatSize(options.maxBytes) + ')');
                        return;
                    }
                    if (!file.size) {
                        fail(ui, 'The file is empty');
                        return;
                    }
                    queue.push({ file: file, name: name, ui: ui });
                });
                next();
            },
        };
    }

    window.StashlyUpload = { create: create, formatSize: formatSize };
})();
