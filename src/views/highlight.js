// Clickable links and a small syntax highlighter for the text of a note. No libraries: the page's content policy only
// allows scripts from this server, and a note is short. The tokenizer and the detector are plain functions (tested in
// Node); render() builds DOM nodes with textContent only, so a note can never inject markup.
(function () {
    'use strict';

    // Very large notes are shown as they are: highlighting them would only slow the page down
    var MAX_HIGHLIGHT = 200000;

    var NUMBER = /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;
    var DQ = /"(?:[^"\\\n]|\\.)*"/;
    var SQ = /'(?:[^'\\\n]|\\.)*'/;

    function words(list) { return new RegExp('\\b(?:' + list.join('|') + ')\\b'); }

    // Rules are tried in order at each position; the first that matches wins. No rule may contain a capture group.
    var LANGUAGES = {
        json: {
            label: 'JSON',
            rules: [['key', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/], ['string', DQ], ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/], ['keyword', /\b(?:true|false|null)\b/]],
        },
        javascript: {
            label: 'JavaScript',
            rules: [
                ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
                ['string', /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
                ['number', NUMBER],
                ['keyword', words(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'null', 'undefined', 'true', 'false', 'of', 'in', 'yield', 'static', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'readonly'])],
            ],
        },
        python: {
            label: 'Python',
            rules: [
                ['comment', /#[^\n]*/],
                ['string', /(?:[rbfRBF]{0,2})(?:"""[\s\S]*?"""|'''[\s\S]*?''')|(?:[rbfRBF]{0,2})(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/],
                ['number', NUMBER],
                ['keyword', words(['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue', 'lambda', 'None', 'True', 'False', 'self', 'yield', 'global', 'async', 'await'])],
            ],
        },
        shell: {
            label: 'Shell',
            rules: [
                ['comment', /#[^\n]*/],
                ['string', /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/],
                ['variable', /\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/],
                ['number', NUMBER],
                ['keyword', words(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'in', 'echo', 'cd', 'export', 'return', 'exit', 'sudo'])],
            ],
        },
        sql: {
            label: 'SQL',
            caseInsensitive: true,
            rules: [
                ['comment', /--[^\n]*|\/\*[\s\S]*?\*\//],
                ['string', /'(?:[^'\\]|\\.|'')*'/],
                ['number', NUMBER],
                ['keyword', words(['select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'alter', 'drop', 'index', 'and', 'or', 'not', 'null', 'as', 'distinct', 'limit', 'offset', 'union', 'all', 'in', 'is', 'like', 'between', 'exists', 'case', 'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'count', 'sum', 'avg', 'min', 'max', 'asc', 'desc'])],
            ],
        },
        css: {
            label: 'CSS',
            rules: [['comment', /\/\*[\s\S]*?\*\//], ['string', DQ], ['string', SQ], ['keyword', /@[A-Za-z-]+/], ['key', /[A-Za-z-]+(?=\s*:)/], ['number', /#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/]],
        },
        markup: {
            label: 'HTML',
            rules: [['comment', /<!--[\s\S]*?-->/], ['string', DQ], ['string', SQ], ['keyword', /<\/?[A-Za-z][\w:-]*|\/?>/], ['key', /[A-Za-z_:][\w:.-]*(?=\s*=)/]],
        },
        yaml: {
            label: 'YAML',
            rules: [['comment', /#[^\n]*/], ['key', /^[ \t-]*[\w./-]+(?=\s*:(?:\s|$))/m], ['string', DQ], ['string', SQ], ['number', NUMBER], ['keyword', /\b(?:true|false|null|yes|no)\b/]],
        },
    };

    var C_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//;
    var C_NUMBER = /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*)\b/;

    LANGUAGES.go = {
        label: 'Go',
        rules: [['comment', C_COMMENT], ['string', /`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/], ['number', C_NUMBER],
            ['keyword', words(['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'go', 'defer', 'select', 'chan', 'map', 'struct', 'interface', 'type', 'var', 'const', 'nil', 'true', 'false'])]],
    };
    LANGUAGES.rust = {
        label: 'Rust',
        rules: [['comment', C_COMMENT], ['string', DQ], ['number', C_NUMBER],
            ['keyword', words(['fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'use', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self', 'crate', 'as', 'in', 'ref', 'move', 'async', 'await', 'true', 'false', 'where', 'const', 'static', 'type', 'unsafe', 'dyn'])]],
    };
    LANGUAGES.java = {
        label: 'Java',
        rules: [['comment', C_COMMENT], ['string', DQ], ['string', SQ], ['number', C_NUMBER],
            ['keyword', words(['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'static', 'final', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'this', 'super', 'null', 'true', 'false', 'abstract', 'enum', 'instanceof', 'synchronized'])]],
    };
    LANGUAGES.csharp = {
        label: 'C#',
        rules: [['comment', C_COMMENT], ['string', /@?"(?:[^"\\\n]|\\.)*"/], ['string', SQ], ['number', C_NUMBER],
            ['keyword', words(['using', 'namespace', 'class', 'struct', 'interface', 'enum', 'public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'void', 'int', 'string', 'bool', 'var', 'new', 'return', 'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'null', 'true', 'false', 'this', 'base', 'override', 'virtual', 'abstract', 'get', 'set'])]],
    };
    LANGUAGES.c = {
        label: 'C/C++',
        rules: [['comment', C_COMMENT], ['keyword', /^[ \t]*#[ \t]*\w+[^\n]*/], ['string', DQ], ['string', SQ], ['number', C_NUMBER],
            ['keyword', words(['int', 'char', 'long', 'short', 'float', 'double', 'void', 'unsigned', 'signed', 'struct', 'union', 'enum', 'typedef', 'static', 'const', 'extern', 'sizeof', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'goto', 'class', 'public', 'private', 'protected', 'template', 'typename', 'namespace', 'using', 'new', 'delete', 'virtual', 'nullptr', 'true', 'false', 'bool', 'this', 'inline', 'auto'])]],
    };
    LANGUAGES.php = {
        label: 'PHP',
        rules: [['comment', /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//], ['string', DQ], ['string', SQ], ['keyword', /<\?php|<\?=|\?>/], ['variable', /\$[A-Za-z_]\w*/], ['number', NUMBER],
            ['keyword', words(['function', 'return', 'if', 'else', 'elseif', 'foreach', 'for', 'while', 'class', 'public', 'private', 'protected', 'static', 'new', 'echo', 'use', 'namespace', 'null', 'true', 'false', 'array', 'as', 'extends', 'implements', 'try', 'catch', 'throw'])]],
    };
    LANGUAGES.ruby = {
        label: 'Ruby',
        rules: [['comment', /#[^\n]*/], ['string', DQ], ['string', SQ], ['variable', /@{1,2}[A-Za-z_]\w*|:[A-Za-z_]\w*/], ['number', NUMBER],
            ['keyword', words(['def', 'end', 'class', 'module', 'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'in', 'do', 'return', 'yield', 'begin', 'rescue', 'ensure', 'nil', 'true', 'false', 'self', 'require', 'puts', 'attr_accessor', 'attr_reader', 'then', 'case', 'when'])]],
    };
    LANGUAGES.powershell = {
        label: 'PowerShell',
        rules: [['comment', /<#[\s\S]*?#>|#[^\n]*/], ['string', DQ], ['string', SQ], ['variable', /\$(?:env:)?[A-Za-z_][\w]*|\$\{[^}\n]*\}/], ['number', NUMBER],
            ['keyword', /\b[A-Z][a-z]+-[A-Z]\w+\b|\s-(?:eq|ne|gt|lt|ge|le|like|match|contains|and|or|not)\b/],
            ['keyword', /\b(?:function|param|if|else|elseif|foreach|for|while|return|switch|try|catch|finally|throw|begin|process|end)\b/i]],
    };
    LANGUAGES.ini = {
        label: 'INI/TOML',
        rules: [['comment', /^[ \t]*[#;][^\n]*/], ['keyword', /^\[[^\]\n]+\]/], ['key', /^[ \t]*[\w.\-]+(?=[ \t]*=)/], ['string', DQ], ['string', SQ], ['number', NUMBER], ['keyword', /\b(?:true|false)\b/]],
    };
    LANGUAGES.dockerfile = {
        label: 'Dockerfile',
        rules: [['comment', /^[ \t]*#[^\n]*/], ['keyword', /^[ \t]*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i], ['string', DQ], ['string', SQ], ['variable', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*/], ['number', NUMBER]],
    };
    LANGUAGES.diff = {
        label: 'Diff',
        rules: [['keyword', /^(?:\+\+\+|---) [^\n]*|^diff [^\n]*|^index [^\n]*/], ['hunk', /^@@[^\n]*/], ['add', /^\+[^\n]*/], ['del', /^-[^\n]*/]],
    };

    // Names people put after a fence (```py) or in a file name, mapped to the languages above
    var ALIASES = {
        js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', typescript: 'javascript', node: 'javascript', mjs: 'javascript',
        py: 'python', python3: 'python',
        sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shell: 'shell',
        html: 'markup', xml: 'markup', svg: 'markup', htm: 'markup',
        yml: 'yaml', json5: 'json', jsonc: 'json',
        ps1: 'powershell', pwsh: 'powershell', ps: 'powershell',
        cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cc: 'c',
        cs: 'csharp', 'c#': 'csharp',
        golang: 'go', rs: 'rust', rb: 'ruby',
        toml: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
        docker: 'dockerfile', patch: 'diff',
    };

    // The language for a fence label or alias, or null when it is not one we colour
    var has = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };

    function resolve(name) {
        var key = String(name || '').trim().toLowerCase();
        if (!key) return null;
        if (has(LANGUAGES, key)) return key;
        return has(ALIASES, key) && has(LANGUAGES, ALIASES[key]) ? ALIASES[key] : null;
    }

    // One combined expression per language, built once
    Object.keys(LANGUAGES).forEach(function (name) {
        var lang = LANGUAGES[name];
        lang.regex = new RegExp(lang.rules.map(function (rule) { return '(' + rule[1].source + ')'; }).join('|'), 'gm' + (lang.caseInsensitive ? 'i' : ''));
    });

    // Splits text into [{ type, text }]. type is 'plain' for everything that is not highlighted.
    function tokenize(text, language) {
        var lang = has(LANGUAGES, language) ? LANGUAGES[language] : null;
        if (!lang || text.length > MAX_HIGHLIGHT) return [{ type: 'plain', text: text }];
        var tokens = [];
        var last = 0;
        var regex = new RegExp(lang.regex.source, lang.regex.flags);
        var match;
        while ((match = regex.exec(text)) !== null) {
            if (match[0] === '') { regex.lastIndex++; continue; }
            if (match.index > last) tokens.push({ type: 'plain', text: text.slice(last, match.index) });
            var type = 'plain';
            for (var i = 1; i < match.length; i++) if (match[i] !== undefined) { type = lang.rules[i - 1][0]; break; }
            tokens.push({ type: type, text: match[0] });
            last = match.index + match[0].length;
        }
        if (last < text.length) tokens.push({ type: 'plain', text: text.slice(last) });
        return tokens;
    }

    // Guesses the language of a note, or returns null when it looks like plain text. Cautious on purpose: the reader
    // can always switch highlighting off, but a wrong guess on ordinary prose would be annoying.
    function detect(text) {
        var t = String(text || '').trim();
        if (t.length < 12 || t.length > MAX_HIGHLIGHT) return null;
        var lines = t.split('\n');

        if (/^[{[]/.test(t)) {
            try { JSON.parse(t); return 'json'; } catch (e) { /* not JSON, keep looking */ }
        }
        if (/^</.test(t) && />$/.test(t) && /<\/[A-Za-z]|\/>/.test(t)) return 'markup';
        if (/^#!\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z)?sh\b/.test(t)) return 'shell';
        if (/\bSELECT\b[\s\S]+\bFROM\b|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i.test(t) && /;|\n/.test(t)) return 'sql';

        var count = function (re) { return lines.filter(function (line) { return re.test(line); }).length; };

        // Formats with a clear fingerprint
        if (/^<\?php\b/.test(t)) return 'php';
        if (/^diff --git |^@@ -\d+(?:,\d+)? \+\d+/m.test(t) || (/^--- \S/m.test(t) && /^\+\+\+ \S/m.test(t))) return 'diff';
        var firstCode = lines.filter(function (line) { return line.trim() && !/^\s*#/.test(line); })[0] || '';
        if (/^FROM\s+\S/.test(firstCode) && count(/^(?:RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|ARG|LABEL)\s/) >= 1) return 'dockerfile';
        // INI / TOML: at least one [section] and a couple of key = value lines, and nothing that looks like code
        if (count(/^\[[^\]\n]+\]\s*$/) >= 1 && count(/^[\w.\-]+\s*=\s*\S/) >= 2 && !/[{};]|=>/.test(t.replace(/^[ \t]*[#;].*$/gm, '').replace(/"[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]/g, ''))) return 'ini';

        var score = {
            javascript: count(/\b(?:const|let|var)\s+[\w{[]+[^=\n]*=|=>|\bfunction\b\s*\w*\s*\(|\brequire\(|^\s*import\s.+\sfrom\s|console\.\w+\(|^\s*export\s+(?:default|const|function|class)/),
            python: count(/^\s*def\s+\w+\(.*\)\s*(?:->.*)?:|^\s*class\s+\w+.*:|^\s*(?:import\s+\w+|from\s+[\w.]+\s+import\s)|\bself\.\w+|^\s*elif\b|\bprint\(|__name__\s*==/),
            shell: count(/^\s*\$?\s*(?:sudo|apt(?:-get)?|npm|npx|yarn|git|docker|curl|wget|cd|ls|export|chmod|mkdir|pip3?|brew|echo|cat|grep|ssh|scp|kubectl)\s/),
            css: count(/^\s*[\w.#*:>\s,-]+\{\s*$|^\s*[\w-]+\s*:\s*[^;]+;\s*$|^\s*@(?:media|import|font-face)/),
            yaml: count(/^\s*(?:-\s+)?[\w./-]+:(?:\s+\S.*|\s*)$/),
            go: count(/^package\s+\w+|^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\(|\w+\s*:=\s*|^import\s+\(|\bfmt\.\w+\(/),
            rust: count(/^\s*(?:pub\s+)?fn\s+\w+|\blet\s+mut\b|^\s*impl\b|^use\s+std::|\bprintln!|^\s*#\[derive/),
            java: count(/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|void|int|String|boolean)\b|System\.out\.print|^import\s+java\.|@Override/),
            csharp: count(/^using\s+System|^namespace\s+[\w.]+|Console\.Write(?:Line)?\(|^\s*(?:public|private|internal)\s+(?:static\s+)?class\b|\bvar\s+\w+\s*=\s*new\b/),
            c: count(/^\s*#\s*include\s*[<"]|\bint\s+main\s*\(|\bstd::|\bprintf\s*\(|^\s*(?:static\s+)?(?:void|int|char)\s+\w+\s*\([^)]*\)\s*\{?\s*$/),
            ruby: count(/^\s*def\s+\w+[?!]?(?:\(.*\))?\s*$|^\s*end\s*$|\bputs\s|^\s*require\s+['"]|^\s*attr_(?:accessor|reader)|^\s*(?:class|module)\s+[A-Z]\w*\s*$/),
            powershell: count(/\b(?:Get|Set|New|Remove|Write|Invoke|Import|Start|Stop)-[A-Z]\w+|^\s*param\s*\(|\$env:\w+|\s-(?:eq|ne|gt|lt|like|match)\s/),
        };
        // YAML looks like many other things, so it must be nearly all key lines and have no code punctuation
        var nonBlank = lines.filter(function (line) { return line.trim(); });
        var yamlLines = nonBlank.filter(function (line) { return /^(?:\s*#.*|\s*-\s+\S.*|\s*(?:-\s+)?[\w./-]+:(?:\s+\S.*|\s*)|\s+\S.*)$/.test(line); }).length;
        if (/[{};=]/.test(t) || score.yaml < 3 || yamlLines < nonBlank.length) score.yaml = 0;
        if (lines.length < 2) {
            score.javascript = score.javascript >= 1 && /[;{]|=>/.test(t) ? 2 : 0;
            ['python', 'css', 'shell', 'go', 'rust', 'java', 'csharp', 'c', 'ruby', 'powershell'].forEach(function (name) { score[name] = 0; });
        }
        var best = null;
        Object.keys(score).forEach(function (name) { if (score[name] >= 2 && (!best || score[name] > score[best])) best = name; });
        return best;
    }

    var URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

    // [{ link: bool, text }] where each link is an http(s) address without the punctuation that ends a sentence
    function splitLinks(text) {
        var parts = [];
        var last = 0;
        var match;
        URL_PATTERN.lastIndex = 0;
        while ((match = URL_PATTERN.exec(text)) !== null) {
            var url = match[0];
            // Trailing punctuation belongs to the sentence, not the address. A ) only goes if the address has no (.
            for (;;) {
                var end = url.charAt(url.length - 1);
                var unbalanced = end === ')' && url.indexOf('(') === -1;
                if (/[.,;:!?'\]}]/.test(end) || unbalanced) url = url.slice(0, -1); else break;
            }
            if (!isSafeUrl(url)) continue;
            if (match.index > last) parts.push({ link: false, text: text.slice(last, match.index) });
            parts.push({ link: true, text: url });
            last = match.index + url.length;
            URL_PATTERN.lastIndex = last;
        }
        if (last < text.length) parts.push({ link: false, text: text.slice(last) });
        return parts;
    }

    function isSafeUrl(url) {
        try {
            var parsed = new URL(url);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
        } catch (e) {
            return false;
        }
    }

    // ---- DOM ----

    function appendLinked(parent, text) {
        splitLinks(text).forEach(function (part) {
            if (!part.link) { parent.appendChild(document.createTextNode(part.text)); return; }
            var a = document.createElement('a');
            a.className = 'note-link';
            a.href = part.text;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = part.text;
            parent.appendChild(a);
        });
    }

    // Plain text with its web addresses made clickable. language (from detect) adds colour.
    function render(text, language) {
        var fragment = document.createDocumentFragment();
        tokenize(text, language).forEach(function (token) {
            if (token.type === 'plain') { appendLinked(fragment, token.text); return; }
            var span = document.createElement('span');
            span.className = 'tok tok-' + token.type;
            // An address inside a comment or a string is still worth a click
            if (token.type === 'comment' || token.type === 'string') appendLinked(span, token.text);
            else span.textContent = token.text;
            fragment.appendChild(span);
        });
        return fragment;
    }

    var api = { tokenize: tokenize, detect: detect, resolve: resolve, splitLinks: splitLinks, render: render, label: function (language) { return has(LANGUAGES, language) ? LANGUAGES[language].label : ''; } };
    if (typeof window !== 'undefined') window.StashlyHighlight = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
