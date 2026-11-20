// A small, safe Markdown renderer for notes. It never uses innerHTML: the text is parsed into a tree and the tree is
// turned into DOM elements and text nodes, so a note can only ever produce the elements built here. Raw HTML in a note
// is shown as text, links must be http or https, and images are shown as links (nothing is fetched from a note).
// parse() and looks() are plain functions (tested in Node); render() needs a browser.
(function () {
    'use strict';

    var MAX_LENGTH = 200000;

    // ---- inline: **bold**, *italic*, ~~strike~~, `code`, [text](url), bare addresses, line breaks ----

    // Closers are looked for within a limited distance, so a note full of unmatched * or ` stays fast
    var CODE = /(`+)([\s\S]{0,1000}?[^`])\1(?!`)/y;
    var LINK = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
    var STRONG = /(\*\*|__)(?=\S)((?:(?!\n\n)[\s\S]){0,300}?\S)\1/y;
    var EM = /(\*|_)(?=\S)((?:(?!\n\n)[\s\S]){0,300}?\S)\1/y;
    var STRIKE = /~~(?=\S)([^\n]{0,300}?\S)~~/y;
    var BARE_URL = /https?:\/\/[^\s<>"'`]+/y;
    var ANGLE_URL = /<(https?:\/\/[^\s<>]+)>/y;

    function isWord(ch) { return /[A-Za-z0-9]/.test(ch || ''); }

    function isSafeUrl(url) {
        try {
            var parsed = new URL(url);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
        } catch (e) {
            return false;
        }
    }

    // Trailing punctuation belongs to the sentence, not the address (a ) only goes when there is no ( inside)
    function trimUrl(url) {
        for (;;) {
            var end = url.charAt(url.length - 1);
            var unbalanced = end === ')' && url.indexOf('(') === -1;
            if (/[.,;:!?'\]}]/.test(end) || unbalanced) url = url.slice(0, -1); else return url;
        }
    }

    function match(re, src, i) {
        re.lastIndex = i;
        return re.exec(src);
    }

    function parseInline(src, depth) {
        depth = depth || 0;
        var nodes = [];
        var buf = '';
        var i = 0;
        function flush() { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } }
        // Past a few levels of nesting the rest is plain text, so a crafted note cannot recurse forever
        if (depth > 6) return [{ t: 'text', v: src }];

        while (i < src.length) {
            var c = src.charAt(i);
            var m;

            if (c === '\\' && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|~>]/.test(src.charAt(i + 1))) { buf += src.charAt(i + 1); i += 2; continue; }
            if (c === '\n') { flush(); nodes.push({ t: 'br' }); i++; continue; }

            if (c === '`' && (m = match(CODE, src, i))) {
                flush();
                var codeText = m[2];
                // `` ` `` : one space either side is padding, not part of the code
                if (codeText.length > 2 && codeText.charAt(0) === ' ' && codeText.charAt(codeText.length - 1) === ' ' && codeText.trim()) codeText = codeText.slice(1, -1);
                nodes.push({ t: 'code', v: codeText });
                i += m[0].length;
                continue;
            }
            if ((c === '[' || c === '!') && (m = match(LINK, src, i))) {
                flush();
                var url = m[3];
                var label = parseInline(m[2], depth + 1);
                if (m[1] === '!') {
                    // An image is never loaded from a note: show its description as a link
                    nodes.push({ t: 'link', href: isSafeUrl(url) ? url : null, children: label.length ? label : [{ t: 'text', v: url }], image: true });
                } else {
                    nodes.push({ t: 'link', href: isSafeUrl(url) ? url : null, children: label });
                }
                i += m[0].length;
                continue;
            }
            if (c === '<' && (m = match(ANGLE_URL, src, i)) && isSafeUrl(m[1])) {
                flush();
                nodes.push({ t: 'link', href: m[1], children: [{ t: 'text', v: m[1] }] });
                i += m[0].length;
                continue;
            }
            if (c === 'h' && !isWord(src.charAt(i - 1)) && (m = match(BARE_URL, src, i))) {
                var bare = trimUrl(m[0]);
                if (isSafeUrl(bare)) {
                    flush();
                    nodes.push({ t: 'link', href: bare, children: [{ t: 'text', v: bare }] });
                    i += bare.length;
                    continue;
                }
            }
            if ((c === '*' || c === '_') && src.charAt(i + 1) === c && (m = match(STRONG, src, i))) {
                if (!(c === '_' && isWord(src.charAt(i - 1))) && !(c === '_' && isWord(src.charAt(i + m[0].length)))) {
                    flush();
                    nodes.push({ t: 'strong', children: parseInline(m[2], depth + 1) });
                    i += m[0].length;
                    continue;
                }
            }
            if ((c === '*' || c === '_') && (m = match(EM, src, i))) {
                // snake_case_names are not emphasis: an underscore must not touch a letter or digit on the outside
                if (!(c === '_' && (isWord(src.charAt(i - 1)) || isWord(src.charAt(i + m[0].length))))) {
                    flush();
                    nodes.push({ t: 'em', children: parseInline(m[2], depth + 1) });
                    i += m[0].length;
                    continue;
                }
            }
            if (c === '~' && src.charAt(i + 1) === '~' && (m = match(STRIKE, src, i))) {
                flush();
                nodes.push({ t: 'del', children: parseInline(m[1], depth + 1) });
                i += m[0].length;
                continue;
            }
            buf += c;
            i++;
        }
        flush();
        return nodes;
    }

    // ---- blocks: headings, paragraphs, lists (nested, tasks), quotes, fenced code, tables, rules ----

    var FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
    var HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
    var HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
    var QUOTE = /^ {0,3}>[ \t]?(.*)$/;
    var LIST_ITEM = /^( {0,3}|\t?)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
    var TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

    function indentOf(line) { return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length; }
    function isBlank(line) { return !line.trim(); }

    function splitRow(line) {
        var row = line.trim();
        if (row.charAt(0) === '|') row = row.slice(1);
        if (row.charAt(row.length - 1) === '|' && row.charAt(row.length - 2) !== '\\') row = row.slice(0, -1);
        // Split on | but not on \|
        var cells = [];
        var cell = '';
        for (var i = 0; i < row.length; i++) {
            if (row.charAt(i) === '\\' && row.charAt(i + 1) === '|') { cell += '|'; i++; }
            else if (row.charAt(i) === '|') { cells.push(cell.trim()); cell = ''; }
            else cell += row.charAt(i);
        }
        cells.push(cell.trim());
        return cells;
    }

    function startsBlock(lines, i) {
        var line = lines[i];
        return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) ||
            (line.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1);
    }

    function parseList(lines, start, depth) {
        var first = LIST_ITEM.exec(lines[start]);
        var ordered = /\d/.test(first[2].charAt(0));
        var baseIndent = indentOf(lines[start]);
        var items = [];
        var i = start;
        var current = null;

        while (i < lines.length) {
            var line = lines[i];
            var item = LIST_ITEM.exec(line);
            var indent = indentOf(line);
            if (item && indent <= baseIndent + 1 && /\d/.test(item[2].charAt(0)) === ordered) {
                current = { lines: [item[3]], markerWidth: indent + item[2].length + 1 };
                items.push(current);
                i++;
            } else if (isBlank(line)) {
                // A blank line keeps the list going only when what follows is indented (more of this item) or another item
                var next = i + 1;
                while (next < lines.length && isBlank(lines[next])) next++;
                if (next >= lines.length) break;
                var nextItem = LIST_ITEM.exec(lines[next]);
                if (indentOf(lines[next]) > baseIndent || (nextItem && indentOf(lines[next]) <= baseIndent + 1 && /\d/.test(nextItem[2].charAt(0)) === ordered)) {
                    current.lines.push('');
                    i++;
                } else break;
            } else if (indent > baseIndent && current) {
                // More of this item: take off the indentation that belongs to the item itself, so a nested list or a
                // code block inside it keeps its own
                var strip = Math.min(indent, Math.max(2, current.markerWidth - baseIndent));
                current.lines.push(' '.repeat(Math.max(0, indent - strip)) + line.replace(/^[ \t]+/, ''));
                i++;
            } else break;
        }

        var parsed = items.map(function (it) {
            var task = null;
            var first = it.lines[0];
            var t = /^\[( |x|X)\][ \t]+(.*)$/.exec(first);
            if (t) { task = t[1] !== ' '; it.lines[0] = t[2]; }
            return { task: task, blocks: parseBlocks(it.lines, depth + 1) };
        });
        return { block: { t: 'list', ordered: ordered, start: ordered ? parseInt(first[2], 10) : 1, items: parsed }, next: i };
    }

    // Lists and quotes inside lists and quotes: past a sensible depth the rest is plain text, so a crafted note cannot
    // nest deeply enough to overflow the stack
    var MAX_BLOCK_DEPTH = 12;

    function parseBlocks(lines, depth) {
        depth = depth || 0;
        if (depth > MAX_BLOCK_DEPTH) return [{ t: 'p', children: [{ t: 'text', v: lines.join('\n') }] }];
        var blocks = [];
        var i = 0;
        while (i < lines.length) {
            var line = lines[i];
            var m;
            if (isBlank(line)) { i++; continue; }

            if ((m = FENCE.exec(line))) {
                var fence = m[1];
                var code = [];
                i++;
                while (i < lines.length && !(lines[i].trim().charAt(0) === fence.charAt(0) && new RegExp('^ {0,3}' + (fence.charAt(0) === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$').test(lines[i]))) { code.push(lines[i]); i++; }
                i++; // the closing fence (or the end of the note)
                blocks.push({ t: 'code', lang: m[2] || '', text: code.join('\n') });
                continue;
            }
            if ((m = HEADING.exec(line))) { blocks.push({ t: 'heading', level: m[1].length, children: parseInline(m[2]) }); i++; continue; }
            if (HR.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
            if (QUOTE.test(line)) {
                var quoted = [];
                while (i < lines.length && QUOTE.test(lines[i])) { quoted.push(QUOTE.exec(lines[i])[1]); i++; }
                blocks.push({ t: 'quote', children: parseBlocks(quoted, depth + 1) });
                continue;
            }
            if (LIST_ITEM.test(line)) {
                var list = parseList(lines, i, depth);
                blocks.push(list.block);
                i = list.next;
                continue;
            }
            if (line.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1) {
                var header = splitRow(line);
                var aligns = splitRow(lines[i + 1]).map(function (cell) {
                    return /^:-+:$/.test(cell) ? 'center' : /-+:$/.test(cell) ? 'right' : /^:-+/.test(cell) ? 'left' : null;
                });
                var rows = [];
                i += 2;
                while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1) { rows.push(splitRow(lines[i])); i++; }
                blocks.push({
                    t: 'table',
                    aligns: aligns,
                    header: header.map(function (cell) { return parseInline(cell); }),
                    rows: rows.map(function (row) { return header.map(function (_, c) { return parseInline(row[c] || ''); }); }),
                });
                continue;
            }

            // A paragraph runs until a blank line or the start of another block
            var para = [line];
            i++;
            while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) { para.push(lines[i]); i++; }
            blocks.push({ t: 'p', children: parseInline(para.join('\n')) });
        }
        return blocks;
    }

    function parse(text) {
        return parseBlocks(String(text || '').replace(/\r\n?/g, '\n').split('\n'));
    }

    // ---- does a note look like Markdown? Cautious: plain notes stay plain ----

    function hasFence(text) { return /^ {0,3}(```|~~~)/m.test(text) && /^ {0,3}(```|~~~)[\s\S]*^ {0,3}(```|~~~)\s*$/m.test(text); }

    function looks(text) {
        var t = String(text || '');
        if (t.length < 8 || t.length > MAX_LENGTH) return false;
        if (hasFence(t)) return true;
        var lines = t.split('\n');
        var count = function (re) { return lines.filter(function (line) { return re.test(line); }).length; };
        var heading = count(/^ {0,3}#{1,6}[ \t]+\S/);
        var items = count(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/);
        var kinds = 0;
        if (heading) kinds++;
        if (items >= 2) kinds++;
        if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(t)) kinds++;
        if (/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(t)) kinds++;
        if (count(/^ {0,3}>[ \t]?\S/) >= 1) kinds++;
        // A table (a row of | cells followed by a |---| line) is unmistakable on its own
        if (lines.some(function (line, i) { return line.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1; })) return true;
        if (kinds >= 2) return true;
        // A heading with paragraphs under it, or a real list of three or more things
        if (heading && lines.length >= 3 && /\n[ \t]*\n/.test(t)) return true;
        return items >= 3;
    }

    // ---- DOM ----

    function renderInline(nodes, parent) {
        nodes.forEach(function (node) {
            var el;
            switch (node.t) {
                case 'text': parent.appendChild(document.createTextNode(node.v)); break;
                case 'br': parent.appendChild(document.createElement('br')); break;
                case 'code': el = document.createElement('code'); el.className = 'md-inline-code'; el.textContent = node.v; parent.appendChild(el); break;
                case 'strong': el = document.createElement('strong'); renderInline(node.children, el); parent.appendChild(el); break;
                case 'em': el = document.createElement('em'); renderInline(node.children, el); parent.appendChild(el); break;
                case 'del': el = document.createElement('del'); renderInline(node.children, el); parent.appendChild(el); break;
                case 'link':
                    if (node.href) {
                        el = document.createElement('a');
                        el.className = 'note-link';
                        el.href = node.href;
                        el.target = '_blank';
                        el.rel = 'noopener noreferrer';
                        renderInline(node.children, el);
                        if (node.image) el.insertBefore(document.createTextNode('image: '), el.firstChild);
                        parent.appendChild(el);
                    } else {
                        // A link that is not http(s) is shown as its text only
                        renderInline(node.children, parent);
                    }
                    break;
                default: break;
            }
        });
    }

    function renderBlocks(blocks, parent, highlighter, tight) {
        blocks.forEach(function (block) {
            var el;
            switch (block.t) {
                case 'heading': el = document.createElement('h' + Math.min(6, block.level + 1)); el.className = 'md-h md-h' + block.level; renderInline(block.children, el); parent.appendChild(el); break;
                case 'p':
                    if (tight) { renderInline(block.children, parent); } else { el = document.createElement('p'); renderInline(block.children, el); parent.appendChild(el); }
                    break;
                case 'hr': parent.appendChild(document.createElement('hr')); break;
                case 'quote': el = document.createElement('blockquote'); renderBlocks(block.children, el, highlighter, false); parent.appendChild(el); break;
                case 'code': {
                    el = document.createElement('pre');
                    el.className = 'md-code';
                    var codeEl = document.createElement('code');
                    var language = highlighter && highlighter.resolve ? highlighter.resolve(block.lang) : null;
                    if (language && highlighter.render) codeEl.appendChild(highlighter.render(block.text, language)); else codeEl.textContent = block.text;
                    el.appendChild(codeEl);
                    if (block.lang && language) el.setAttribute('data-lang', block.lang);
                    parent.appendChild(el);
                    break;
                }
                case 'list': {
                    el = document.createElement(block.ordered ? 'ol' : 'ul');
                    if (block.ordered && block.start !== 1) el.setAttribute('start', String(block.start));
                    block.items.forEach(function (item) {
                        var li = document.createElement('li');
                        if (item.task !== null) { li.className = 'md-task'; li.appendChild(document.createTextNode(item.task ? '☑ ' : '☐ ')); }
                        // One paragraph in an item is shown without paragraph spacing
                        var onlyText = item.blocks.length === 1 && item.blocks[0].t === 'p';
                        renderBlocks(item.blocks, li, highlighter, onlyText || (item.blocks.length > 0 && item.blocks[0].t === 'p'));
                        el.appendChild(li);
                    });
                    parent.appendChild(el);
                    break;
                }
                case 'table': {
                    el = document.createElement('table');
                    el.className = 'md-table';
                    var thead = document.createElement('thead');
                    var hr = document.createElement('tr');
                    block.header.forEach(function (cell, c) {
                        var th = document.createElement('th');
                        if (block.aligns[c]) th.style.textAlign = block.aligns[c];
                        renderInline(cell, th);
                        hr.appendChild(th);
                    });
                    thead.appendChild(hr);
                    el.appendChild(thead);
                    var tbody = document.createElement('tbody');
                    block.rows.forEach(function (row) {
                        var tr = document.createElement('tr');
                        row.forEach(function (cell, c) {
                            var td = document.createElement('td');
                            if (block.aligns[c]) td.style.textAlign = block.aligns[c];
                            renderInline(cell, td);
                            tr.appendChild(td);
                        });
                        tbody.appendChild(tr);
                    });
                    el.appendChild(tbody);
                    parent.appendChild(el);
                    break;
                }
                default: break;
            }
        });
    }

    // highlighter is window.StashlyHighlight (used to colour fenced code); it is optional
    function render(text, highlighter) {
        var fragment = document.createDocumentFragment();
        if (String(text || '').length > MAX_LENGTH) { fragment.appendChild(document.createTextNode(text)); return fragment; }
        renderBlocks(parse(text), fragment, highlighter, false);
        return fragment;
    }

    var api = { parse: parse, parseInline: parseInline, looks: looks, hasFence: hasFence, render: render };
    if (typeof window !== 'undefined') window.StashlyMarkdown = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
