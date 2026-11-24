// A small, safe Markdown renderer for notes. It never uses innerHTML: the text is parsed into a tree and the tree is
// turned into DOM elements and text nodes, so a note can only ever produce the elements built here. Raw HTML in a note
// is shown as text, links must be http or https, and images are shown as links (nothing is fetched from a note).
// parse() and looks() are plain functions (tested in Node); render() needs a browser.
(function () {
    'use strict';

    var MAX_LENGTH = 200000;

    // ---- emoji names, as chat apps and GitHub write them: :rocket: shows as 🚀 ----
    // A small table of the names people actually paste, not the whole set; anything not here is left as it was typed.
    // A name is looked up lowercased, and only ever becomes a text node, so it can never inject anything.
    var EMOJI = {
        zero: '0️⃣', one: '1️⃣', two: '2️⃣', three: '3️⃣', four: '4️⃣', five: '5️⃣',
        six: '6️⃣', seven: '7️⃣', eight: '8️⃣', nine: '9️⃣', ten: '🔟', hundred: '💯',
        rocket: '🚀', tada: '🎉', sparkles: '✨', sparkle: '❇️', fire: '🔥', zap: '⚡', boom: '💥',
        white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️', x: '❌',
        warning: '⚠️', information_source: 'ℹ️', exclamation: '❗', grey_exclamation: '❕',
        question: '❓', grey_question: '❔', rotating_light: '🚨', construction: '🚧', bug: '🐛',
        hammer_and_wrench: '🛠️', wrench: '🔧', hammer: '🔨', gear: '⚙️', lock: '🔒', unlocked: '🔓',
        key: '🔑', shield: '🛡️', closed_lock_with_key: '🔐', bulb: '💡', memo: '📝', spiral_note: '🗒️',
        page_facing_up: '📄', page_with_curl: '📃', clipboard: '📋', books: '📚', book: '📖',
        bookmark: '🔖', pushpin: '📌', round_pushpin: '📍', paperclip: '📎', link: '🔗', mag: '🔍',
        bell: '🔔', no_bell: '🔕', loudspeaker: '📢', mega: '📣', speech_balloon: '💬', email: '📧',
        envelope: '✉️', calendar: '📅', date: '📆', hourglass: '⌛', hourglass_flowing_sand: '⏳',
        alarm_clock: '⏰', stopwatch: '⏱️',
        clock1: '🕐', clock2: '🕑', clock3: '🕒', clock4: '🕓', clock5: '🕔', clock6: '🕕',
        clock7: '🕖', clock8: '🕗', clock9: '🕘', clock10: '🕙', clock11: '🕚', clock12: '🕛',
        wave: '👋', smile: '😄', grinning: '😁', joy: '😂', rofl: '🤣', sweat_smile: '😅',
        slightly_smiling_face: '🙂', heart_eyes: '😍', sunglasses: '😎', partying_face: '🥳',
        thinking_face: '🤔', facepalm: '🤦', eyes: '👀', see_no_evil: '🙈', sob: '😭', angry: '😠',
        scream: '😱', sleeping: '😴', pray: '🙏', muscle: '💪', clap: '👏', thumbsup: '👍', '+1': '👍',
        thumbsdown: '👎', '-1': '👎', point_right: '👉', point_left: '👈', point_up: '☝️',
        point_down: '👇', raised_hands: '🙌', ok_hand: '👌', v: '✌️', metal: '🤘', fist: '✊',
        crossed_fingers: '🤞', shrug: '🤷', brain: '🧠',
        package: '📦', computer: '💻', desktop_computer: '🖥️', iphone: '📱', robot: '🤖',
        floppy_disk: '💾', cd: '💿', file_folder: '📁', open_file_folder: '📂', bar_chart: '📊',
        chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', moneybag: '💰',
        dollar: '💵', credit_card: '💳', coffee: '☕', beer: '🍺', pizza: '🍕', apple: '🍎',
        sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️', star: '⭐', star2: '🌟',
        heart: '❤️', broken_heart: '💔', red_circle: '🔴', large_blue_circle: '🔵',
        large_green_circle: '🟢', black_circle: '⚫', white_circle: '⚪', arrow_right: '➡️',
        arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', arrows_counterclockwise: '🔄',
        recycle: '♻️', infinity: '♾️', no_entry: '⛔', no_entry_sign: '🚫', do_not_litter: '🚯',
        trophy: '🏆', medal_sports: '🏅', '1st_place_medal': '🥇', dart: '🎯', goal_net: '🥅',
        triangular_flag_on_post: '🚩', checkered_flag: '🏁', shipit: '🐿️',
        heavy_plus_sign: '➕', heavy_minus_sign: '➖', heavy_multiplication_x: '✖️',
        heavy_division_sign: '➗', ok: '🆗', new: '🆕', free: '🆓', top: '🔝', soon: '🔜'
    };

    function emojiFor(name) {
        var key = String(name || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(EMOJI, key) ? EMOJI[key] : null;
    }

    // The :names: in plain text (a title, which is never parsed as Markdown) shown as the emoji themselves. The text
    // that is stored, copied, searched and exported is never changed; only what the reader sees is.
    function shortcodes(text) {
        return String(text === undefined || text === null ? '' : text).replace(/:([a-z0-9+-][a-z0-9_+-]*):/gi, function (all, name) {
            return emojiFor(name) || all;
        });
    }

    // ---- inline: **bold**, *italic*, ~~strike~~, `code`, [text](url), bare addresses, line breaks ----

    // Closers are looked for within a limited distance, so a note full of unmatched * or ` stays fast
    var CODE = /(`+)([\s\S]{0,1000}?[^`])\1(?!`)/y;
    var LINK = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
    var STRONG = /(\*\*|__)(?=\S)((?:(?!\n\n)[\s\S]){0,300}?\S)\1/y;
    var EM = /(\*|_)(?=\S)((?:(?!\n\n)[\s\S]){0,300}?\S)\1/y;
    var STRIKE = /~~(?=\S)([^\n]{0,300}?\S)~~/y;
    var BARE_URL = /https?:\/\/[^\s<>"'`]+/y;
    var ANGLE_URL = /<(https?:\/\/[^\s<>]+)>/y;
    // Chat style (style 'slack'): one asterisk is bold, not italic, and one tilde is a strike. Bounded like the rest,
    // so a note full of unmatched markers stays fast.
    var SLACK_BOLD = /\*(?=\S)((?:(?!\n\n)[^*\n]){0,300}?\S)\*(?!\*)/y;
    var SLACK_STRIKE = /~(?=\S)([^~\n]{0,300}?\S)~(?!~)/y;
    // A :name: to turn into an emoji. Digit-leading names (for example :1st_place_medal:) are valid; only names in
    // the table are replaced, so clock times such as 10:30:00 stay as typed.
    var SHORT_NAME = /:([a-z0-9+-][a-z0-9_+-]*):/iy;

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

    function parseInline(src, depth, style) {
        depth = depth || 0;
        style = style || 'markdown';
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
                var label = parseInline(m[2], depth + 1, style);
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
                    nodes.push({ t: 'strong', children: parseInline(m[2], depth + 1, style) });
                    i += m[0].length;
                    continue;
                }
            }
            // Chat style: *one* asterisk is bold (in Markdown it is italic), and ~one~ tilde is a strike
            if (style === 'slack' && c === '*' && (m = match(SLACK_BOLD, src, i))) {
                flush();
                nodes.push({ t: 'strong', children: parseInline(m[1], depth + 1, style) });
                i += m[0].length;
                continue;
            }
            if ((c === '*' || c === '_') && (m = match(EM, src, i))) {
                // snake_case_names are not emphasis: an underscore must not touch a letter or digit on the outside
                if (!(c === '_' && (isWord(src.charAt(i - 1)) || isWord(src.charAt(i + m[0].length))))) {
                    flush();
                    nodes.push({ t: 'em', children: parseInline(m[2], depth + 1, style) });
                    i += m[0].length;
                    continue;
                }
            }
            if (c === '~' && src.charAt(i + 1) === '~' && (m = match(STRIKE, src, i))) {
                flush();
                nodes.push({ t: 'del', children: parseInline(m[1], depth + 1, style) });
                i += m[0].length;
                continue;
            }
            if (style === 'slack' && c === '~' && (m = match(SLACK_STRIKE, src, i))) {
                flush();
                nodes.push({ t: 'del', children: parseInline(m[1], depth + 1, style) });
                i += m[0].length;
                continue;
            }
            // :rocket: becomes the emoji itself; a name that is not in the table stays as it was typed
            if (c === ':' && (m = match(SHORT_NAME, src, i))) {
                var emoji = emojiFor(m[1]);
                if (emoji) {
                    flush();
                    nodes.push({ t: 'text', v: emoji });
                    i += m[0].length;
                    continue;
                }
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
    // Chat style writes a bullet with a dot, not a dash
    var SLACK_ITEM = /^( {0,3}|\t?)([•‣◦])[ \t]+(.*)$/;
    var TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

    // The list marker on this line, in the style being read: both shapes have the same groups (indent, marker, text)
    function itemAt(line, style) {
        return (style === 'slack' && SLACK_ITEM.exec(line)) || LIST_ITEM.exec(line);
    }

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

    function startsBlock(lines, i, style) {
        var line = lines[i];
        return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || Boolean(itemAt(line, style)) ||
            (line.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1);
    }

    function parseList(lines, start, depth, style) {
        var first = itemAt(lines[start], style);
        var ordered = /\d/.test(first[2].charAt(0));
        var baseIndent = indentOf(lines[start]);
        var items = [];
        var i = start;
        var current = null;

        while (i < lines.length) {
            var line = lines[i];
            var item = itemAt(line, style);
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
                var nextItem = itemAt(lines[next], style);
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
            var firstLine = it.lines[0];
            var t = /^\[( |x|X)\][ \t]+(.*)$/.exec(firstLine);
            if (t) { task = t[1] !== ' '; it.lines[0] = t[2]; }
            return { task: task, blocks: parseBlocks(it.lines, depth + 1, style) };
        });
        return { block: { t: 'list', ordered: ordered, start: ordered ? parseInt(first[2], 10) : 1, items: parsed }, next: i };
    }

    // Lists and quotes inside lists and quotes: past a sensible depth the rest is plain text, so a crafted note cannot
    // nest deeply enough to overflow the stack
    var MAX_BLOCK_DEPTH = 12;

    function parseBlocks(lines, depth, style) {
        depth = depth || 0;
        style = style || 'markdown';
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
            if ((m = HEADING.exec(line))) { blocks.push({ t: 'heading', level: m[1].length, children: parseInline(m[2], 0, style) }); i++; continue; }
            if (HR.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
            if (QUOTE.test(line)) {
                var quoted = [];
                while (i < lines.length && QUOTE.test(lines[i])) { quoted.push(QUOTE.exec(lines[i])[1]); i++; }
                blocks.push({ t: 'quote', children: parseBlocks(quoted, depth + 1, style) });
                continue;
            }
            if (itemAt(line, style)) {
                var list = parseList(lines, i, depth, style);
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
                    header: header.map(function (cell) { return parseInline(cell, 0, style); }),
                    rows: rows.map(function (row) { return header.map(function (_, c) { return parseInline(row[c] || '', 0, style); }); }),
                });
                continue;
            }

            // A paragraph runs until a blank line or the start of another block
            var para = [line];
            i++;
            while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i, style)) { para.push(lines[i]); i++; }
            blocks.push({ t: 'p', children: parseInline(para.join('\n'), 0, style) });
        }
        return blocks;
    }

    // style 'markdown' (the default) or 'slack': chat style adds *bold*, ~strike~, • bullets and :emoji: names
    function parse(text, style) {
        return parseBlocks(String(text || '').replace(/\r\n?/g, '\n').split('\n'), 0, style === 'slack' ? 'slack' : 'markdown');
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

    // ---- does a note look like it was pasted from a chat app (Slack, Teams, Discord)? ----
    // Those write bold with one asterisk (*text*, italic in Markdown), bullets with a dot (•) and emoji as names
    // (:rocket:). Two or more bullets, two or more bold lines, or one known emoji name are enough; a lone bullet or a
    // lone pair of asterisks is not, because a line like "files: *.log *.tmp" would otherwise read as bold.
    var BULLET_LINE = /^ {0,3}[•‣◦][ \t]+\S/;
    var SLACK_BOLD_LINE = /(^|[\s([>])[*_](?=\S)[^*_\n]{2,}?[*_](?=[\s.,;:!?)\]}]|$)/;
    var ANY_SHORT_NAME = /:([a-z0-9+-][a-z0-9_+-]*):/gi;

    function looksSlack(text) {
        var t = String(text || '');
        if (t.length < 8 || t.length > MAX_LENGTH) return false;
        var lines = t.split('\n');
        var bullets = 0;
        var bold = 0;
        for (var i = 0; i < lines.length; i++) {
            if (BULLET_LINE.test(lines[i])) bullets++;
            if (SLACK_BOLD_LINE.test(lines[i])) bold++;
            if (bullets >= 2 || bold >= 2) return true;
        }
        ANY_SHORT_NAME.lastIndex = 0;
        var m;
        while ((m = ANY_SHORT_NAME.exec(t))) if (emojiFor(m[1])) return true;
        return false;
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

    // highlighter is window.StashlyHighlight (used to colour fenced code); it is optional. style is 'markdown' (the
    // default) or 'slack', which also understands chat formatting and :emoji: names.
    function render(text, highlighter, style) {
        var fragment = document.createDocumentFragment();
        if (String(text || '').length > MAX_LENGTH) { fragment.appendChild(document.createTextNode(text)); return fragment; }
        renderBlocks(parse(text, style), fragment, highlighter, false);
        return fragment;
    }

    var api = { parse: parse, parseInline: parseInline, looks: looks, looksSlack: looksSlack, hasFence: hasFence, render: render, shortcodes: shortcodes, EMOJI: EMOJI };
    if (typeof window !== 'undefined') window.StashlyMarkdown = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
