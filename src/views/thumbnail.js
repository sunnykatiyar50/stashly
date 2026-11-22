// Makes a small thumbnail of an image in the browser, because the server has no image library. Exposed as
// window.StashlyThumb; the stash page (stash-share.js) sends the result to the server.
//
//   StashlyThumb.make(blob, { maxBytes }) -> Promise of a Blob (WebP, or JPEG where the browser cannot encode WebP),
//   at most 256 px on its longer side, or of null when the image cannot be decoded or no small enough picture came out.
//
// A GIF (animated or not) is decoded as its first frame, which is what the browser draws for it. Nothing here throws:
// a thumbnail is a nicety, so every failure is just "no thumbnail".
(function () {
    'use strict';

    var MAX_EDGE = 256;
    // Tried in turn until the result fits the server's size limit: the normal size, then a lower quality, then smaller
    var ATTEMPTS = [{ edge: MAX_EDGE, quality: 0.8 }, { edge: MAX_EDGE, quality: 0.6 }, { edge: 160, quality: 0.6 }, { edge: 96, quality: 0.5 }];

    // Draws the image into a canvas no bigger than `edge` on its longer side. A big picture is halved step by step
    // before the last draw, which keeps thin lines and text from turning into noise (one big jump skips most pixels).
    function draw(bitmap, edge, flatten) {
        var width = bitmap.width;
        var height = bitmap.height;
        var scale = Math.min(1, edge / Math.max(width, height));
        var targetW = Math.max(1, Math.round(width * scale));
        var targetH = Math.max(1, Math.round(height * scale));
        var source = bitmap;
        var w = width;
        var h = height;
        while (w / 2 >= targetW && h / 2 >= targetH) {
            var half = document.createElement('canvas');
            w = Math.max(targetW, Math.floor(w / 2));
            h = Math.max(targetH, Math.floor(h / 2));
            half.width = w;
            half.height = h;
            var halfContext = half.getContext('2d');
            halfContext.imageSmoothingQuality = 'high';
            halfContext.drawImage(source, 0, 0, w, h);
            source = half;
        }
        var canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        var context = canvas.getContext('2d');
        // JPEG has no transparency (it would come out black), so it is drawn on white
        if (flatten) {
            context.fillStyle = '#fff';
            context.fillRect(0, 0, targetW, targetH);
        }
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, targetW, targetH);
        return canvas;
    }

    function encode(canvas, type, quality) {
        return new Promise(function (resolve) {
            try { canvas.toBlob(function (blob) { resolve(blob); }, type, quality); } catch (e) { resolve(null); }
        });
    }

    // WebP where the browser can encode it (transparency kept), otherwise JPEG
    function encodeOnce(bitmap, attempt) {
        return encode(draw(bitmap, attempt.edge, false), 'image/webp', attempt.quality).then(function (blob) {
            if (blob && blob.type === 'image/webp') return blob;
            return encode(draw(bitmap, attempt.edge, true), 'image/jpeg', attempt.quality);
        });
    }

    function make(blob, options) {
        var maxBytes = (options && options.maxBytes) || 200 * 1024;
        if (!blob || !window.createImageBitmap) return Promise.resolve(null);
        // (an <img> would need a blob: address, which the page's content security policy does not allow)
        return createImageBitmap(blob).then(function (bitmap) {
            if (!bitmap.width || !bitmap.height) { if (bitmap.close) bitmap.close(); return null; }
            var index = 0;
            function next() {
                if (index >= ATTEMPTS.length) return null;
                return encodeOnce(bitmap, ATTEMPTS[index++]).then(function (out) {
                    if (out && out.size && out.size <= maxBytes && /^image\/(webp|jpeg)$/.test(out.type)) return out;
                    return next();
                });
            }
            return Promise.resolve(next()).then(function (out) {
                if (bitmap.close) bitmap.close();
                return out;
            });
        }).catch(function () { return null; });
    }

    window.StashlyThumb = { make: make, MAX_EDGE: MAX_EDGE };
})();
