// Weaver's Vault — JanitorAI bio HTML -> SillyTavern creator notes.
//
// Port of the user's `janitor2st.py` (763 lines, ~40 manual conversions behind
// it). Every rule below exists because a real card needed it; the comments name
// the hazard, not the code.
//
// Differences from the Python, all deliberate:
//   * No BeautifulSoup and no jsdom. The converter runs in the browser (it paints
//     the bio) *and* in the server (it builds `creator_notes`), so it parses with
//     a small, quote-aware tokenizer that produces the same tree shape for the
//     subset of HTML a JanitorAI bio uses. Adding jsdom would ship a browser to
//     the browser.
//   * The `div.css-ly0sg4` content-root heuristic is dropped: our input is the
//     API's bio field, not a pasted page, so there is no page around it to find.
//     The root is the fragment, or its single wrapping `<div>`.
//   * Page-CSS class inlining (`parse_css`, `_apply_class_css`, `resolve_vars`)
//     is dropped: the bio arrives from the API with no stylesheet, so there is
//     nothing to resolve. `--var()` fallbacks and the unresolved-class warning
//     go with it.
// Everything else — the strip order, the regexes, the credit line — follows the
// Python step for step.

const BASE = 'https://janitorai.com';
const ZW = /[\u200b\u200c\u2060\ufeff\u00ad]/g;
const MACRO = /(?<!\{)\{\s*(user|char)\s*\}(?!\})/gi;
const OKLAB = /oklab\(\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\)/g;
const EXTLINK = /^(?:https?:\/\/janitorai\.com)?\/external-link\?.*?[?&]to=([^&\s]+)/i;
const DOUBLE_WORD = /\b([A-Za-z]{3,})\s+\1\b/gi;

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track']);
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li']);
const PARAGRAPH_CLOSERS = new Set([...BLOCK_TAGS, 'div', 'ul', 'ol', 'table', 'section', 'article', 'pre', 'figure', 'header', 'footer', 'hr', 'form', 'dl', 'details']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// ------------------------------------------------------------------ colour ---

/**
 * oklab() -> #rrggbb. JanitorAI's editor emits oklab for coloured text; an
 * unrenderable colour in a card is a black text on black background bug.
 */
export function oklabToHex(L, a, b) {
    const l_ = Number(L) + 0.3963377774 * Number(a) + 0.2158037573 * Number(b);
    const m_ = Number(L) - 0.1055613458 * Number(a) - 0.0638541728 * Number(b);
    const s_ = Number(L) - 0.0894841775 * Number(a) - 1.2914855480 * Number(b);
    const l = l_ ** 3;
    const m = m_ ** 3;
    const s = s_ ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b2 = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    const lin2srgb = c => {
        const value = Math.max(0, Math.min(1, c));
        return value <= 0.0031308 ? value * 12.92 : 1.055 * (value ** (1 / 2.4)) - 0.055;
    };
    const hex = c => Math.round(lin2srgb(c) * 255).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b2)}`;
}

/** A colour's luminance, or null for inherit/transparent/unknown. */
export function parseColor(value) {
    if (!value) return null;
    const text = String(value).trim().toLowerCase();
    if (['inherit', 'transparent', 'initial', 'unset', 'currentcolor', 'auto'].includes(text)) return null;
    if (text === 'black') return [0, 0, 0];
    if (text === 'white') return [1, 1, 1];
    let match = /^#([0-9a-f]{3})$/.exec(text);
    if (match) return [...match[1]].map(c => parseInt(c + c, 16) / 255);
    match = /^#([0-9a-f]{6})/.exec(text);
    if (match) {
        const h = match[1];
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    }
    match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(text);
    if (match) return match.slice(1, 4).map(x => Number(x) / 255);
    return null;
}

export function luminance(color) {
    return color === null ? null : 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

// -------------------------------------------------------------- inline CSS ---

/**
 * Inline style string -> ordered map.
 * Paren-aware, so `url(data:image/png;base64,...)` is not cut at its semicolons.
 */
export function parseJanitorStyle(style) {
    const out = new Map();
    if (!style) return out;
    const parts = [];
    let buffer = '';
    let depth = 0;
    for (const ch of String(style)) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        if (ch === ';' && depth === 0) {
            parts.push(buffer);
            buffer = '';
        } else {
            buffer += ch;
        }
    }
    if (buffer) parts.push(buffer);
    for (const declaration of parts) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const key = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        if (key && value) out.set(key, value);
    }
    return out;
}

export function janitorStyleString(style) {
    return [...style.entries()].map(([key, value]) => `${key}: ${value}`).join('; ');
}

// -------------------------------------------------------------------- tree ---

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
    lsquo: '‘', ldquo: '“', rdquo: '”', times: '×',
};

/**
 * Decode the entities a bio actually contains.
 *
 * BeautifulSoup decodes them all, and the difference is visible: a paragraph
 * holding only `&nbsp;` is an empty spacer and must be removed, but a text node
 * that still reads "&nbsp;" is six characters of content. Unknown named entities
 * are left alone so they survive serialization instead of becoming `&amp;name;`.
 */
export function decodeJanitorEntities(value) {
    return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? match : named;
    });
}

const element = (name, attrs = {}) => ({ type: 'element', name, attrs, children: [], parent: null });
const textNode = value => ({ type: 'text', value, parent: null });

function appendChild(parent, node) {
    node.parent = parent;
    parent.children.push(node);
    return node;
}

function removeNode(node) {
    if (!node.parent) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
}

function replaceWith(node, replacement) {
    const parent = node.parent;
    if (!parent) return;
    const index = parent.children.indexOf(node);
    if (index < 0) return;
    parent.children.splice(index, 1, replacement);
    replacement.parent = parent;
    node.parent = null;
}

/** Drop a node but keep its children in its place (BeautifulSoup's `unwrap`). */
function unwrap(node) {
    const parent = node.parent;
    if (!parent) return;
    const index = parent.children.indexOf(node);
    if (index < 0) return;
    for (const child of node.children) child.parent = parent;
    parent.children.splice(index, 1, ...node.children);
    node.children = [];
    node.parent = null;
}

function insertBefore(reference, node) {
    const parent = reference.parent;
    if (!parent) return;
    const index = parent.children.indexOf(reference);
    parent.children.splice(index, 0, node);
    node.parent = parent;
}

/** Every element under `node`, depth-first, in document order. */
function elementsUnder(node, into = []) {
    for (const child of node.children) {
        if (child.type !== 'element') continue;
        into.push(child);
        elementsUnder(child, into);
    }
    return into;
}

function textOf(node) {
    if (node.type === 'text') return node.value;
    return node.children.map(textOf).join('');
}

function hasText(node) {
    return textOf(node).trim().length > 0;
}

function hasElement(node, names) {
    return elementsUnder(node).some(child => names.has(child.name));
}

// ------------------------------------------------------------------ parser ---

function findTagEnd(text, start) {
    let quote = null;
    for (let i = start + 1; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '>') {
            return i;
        }
    }
    return -1;
}

function parseAttributes(raw) {
    const attrs = {};
    const pattern = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        const name = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        if (!(name in attrs)) attrs[name] = value;
    }
    return attrs;
}

/**
 * Parse a fragment into a document node.
 *
 * Not a browser parser: it handles the tags a bio contains, auto-closes `<p>`
 * the way a browser does (or a `<div>` inside `<p>` would nest wrongly and the
 * output would nest blocks forever), and ignores stray end tags rather than
 * throwing. Anything it cannot read becomes text, so no content is ever lost.
 */
export function parseJanitorHtml(html) {
    const root = element('#document');
    const stack = [root];
    const source = String(html ?? '');
    const top = () => stack[stack.length - 1];
    const addText = raw => {
        const value = decodeJanitorEntities(raw);
        if (!value) return;
        const last = top().children[top().children.length - 1];
        // Merge adjacent text so a split entity is not two nodes.
        if (last && last.type === 'text') last.value += value;
        else appendChild(top(), textNode(value));
    };

    let i = 0;
    while (i < source.length) {
        const lt = source.indexOf('<', i);
        if (lt < 0) {
            addText(source.slice(i));
            break;
        }
        if (lt > i) addText(source.slice(i, lt));
        if (source.startsWith('<!--', lt)) {
            const end = source.indexOf('-->', lt + 4);
            i = end < 0 ? source.length : end + 3;
            continue;
        }
        if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
            const end = source.indexOf('>', lt);
            i = end < 0 ? source.length : end + 1;
            continue;
        }
        const gt = findTagEnd(source, lt);
        if (gt < 0) {
            addText(source.slice(lt));
            break;
        }
        const raw = source.slice(lt + 1, gt);
        i = gt + 1;
        if (raw.startsWith('/')) {
            const name = raw.slice(1).trim().toLowerCase();
            for (let depth = stack.length - 1; depth > 0; depth -= 1) {
                if (stack[depth].name === name) {
                    stack.length = depth;
                    break;
                }
            }
            continue;
        }
        const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(raw.trim());
        if (!nameMatch) continue;
        const name = nameMatch[1].toLowerCase();
        const selfClosing = raw.trim().endsWith('/');
        if (PARAGRAPH_CLOSERS.has(name) && top().name === 'p') stack.pop();
        const node = element(name, parseAttributes(raw.slice(nameMatch[0].length)));
        appendChild(top(), node);
        if (!VOID_TAGS.has(name) && !selfClosing) stack.push(node);
    }
    return root;
}

// -------------------------------------------------------------- serializer ---

function escapeText(value) {
    return String(value)
        // Only bare ampersands: `&amp;` must not become `&amp;amp;`.
        .replace(/&(?!#?\w+;)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
    return escapeText(value).replace(/"/g, '&quot;');
}

export function serializeJanitorHtml(node) {
    if (node.type === 'text') return escapeText(node.value);
    const attrs = Object.entries(node.attrs ?? {})
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => (value === '' ? ` ${key}=""` : ` ${key}="${escapeAttribute(value)}"`))
        .join('');
    if (node.name === '#document') return node.children.map(serializeJanitorHtml).join('');
    if (VOID_TAGS.has(node.name)) return `<${node.name}${attrs}>`;
    return `<${node.name}${attrs}>${node.children.map(serializeJanitorHtml).join('')}</${node.name}>`;
}

// ------------------------------------------------------------- the pipeline ---

const DEFAULTS = {
    width: 700,
    credit: true,
    splitImages: true,
    fixMarks: true,
    convertMacros: true,
    fixLinks: true,
    fixImages: true,
    stripEmpty: true,
    dropWebkit: true,
    unwrapSpans: true,
    doubleWord: true,
};

/**
 * Convert one bio.
 * @param {string} html the API's `description` (creator's bio HTML)
 * @param {{author?: string, authorUrl?: string, width?: number} & Partial<typeof DEFAULTS>} [options]
 * @returns {{html: string, log: string[]}}
 */
export function convertJanitorBio(html, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const log = [];
    const note = message => log.push(message);

    const tree = parseJanitorHtml(html);
    // The Python only drops svg/style, because its output is pasted by hand and a
    // human sees what lands there. Ours is rendered with innerHTML and stored in a
    // card automatically, so anything executable goes: script-bearing elements,
    // `on*` handlers and `javascript:` URLs. A bio is third-party content.
    const DANGEROUS_TAGS = new Set(['script', 'style', 'svg', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link']);
    for (const junk of elementsUnder(tree).filter(node => DANGEROUS_TAGS.has(node.name))) {
        removeNode(junk);
    }
    let sanitized = 0;
    for (const node of elementsUnder(tree)) {
        for (const attr of Object.keys(node.attrs)) {
            const name = attr.toLowerCase();
            const value = String(node.attrs[attr]);
            if (name.startsWith('on')) {
                delete node.attrs[attr];
                sanitized += 1;
                continue;
            }
            if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(value)) {
                delete node.attrs[attr];
                sanitized += 1;
            }
        }
    }
    if (sanitized) note(`[SAFE] Removed ${sanitized} executable attribute(s) from the bio`);

    // ---- credit -----------------------------------------------------------
    let authorName = String(settings.author ?? '').trim().replace(/^@/, '');
    let authorUrl = String(settings.authorUrl ?? '').trim();
    if (!authorName) {
        const link = elementsUnder(tree).find(node => node.name === 'a' && String(node.attrs.href ?? '').includes('/profiles/'));
        if (link) {
            authorName = textOf(link).replace(/\s+/g, ' ').trim().replace(/^@/, '');
            const href = String(link.attrs.href ?? '');
            authorUrl = href.startsWith('/') ? BASE + href : href;
        }
    }
    if (!authorName && settings.credit) {
        note('[WARN] No author found — add the credit manually (author name missing).');
    }

    // ---- content root ------------------------------------------------------
    const topLevel = tree.children.filter(node => node.type === 'element');
    const root = topLevel.length === 1 && topLevel[0].name === 'div' ? topLevel[0] : tree;

    // ---- attributes the editor leaves behind ------------------------------
    let stripped = 0;
    for (const node of elementsUnder(root)) {
        for (const attr of ['node', 'draggable', 'data-discover', 'aria-hidden']) {
            if (attr in node.attrs) {
                delete node.attrs[attr];
                stripped += 1;
            }
        }
        if (node.attrs.title === '' || node.attrs.title === ' ') {
            delete node.attrs.title;
            stripped += 1;
        }
    }
    if (stripped) note(`[STRIP] Removed ${stripped} lightbox/framework attributes`);

    // ---- oklab() colours ---------------------------------------------------
    let okalbs = 0;
    for (const node of elementsUnder(root)) {
        if (!('style' in node.attrs)) continue;
        const replaced = String(node.attrs.style).replace(OKLAB, (_match, L, a, b) => {
            const hex = oklabToHex(Number(L), Number(a), Number(b));
            okalbs += 1;
            note(`[FIX] oklab() color -> ${hex}`);
            return hex;
        });
        node.attrs.style = replaced;
    }

    // ---- inline style cleanup ---------------------------------------------
    let textAlignFixes = 0;
    for (const node of elementsUnder(root)) {
        if (!('style' in node.attrs)) continue;
        const cleaned = new Map();
        for (const [key, value] of parseJanitorStyle(node.attrs.style)) {
            if (key === 'cursor' && value.includes('pointer')) continue;
            if (settings.dropWebkit && key.startsWith('-webkit-')) continue;
            if (key === 'text' && ['center', 'left', 'right', 'justify'].includes(value.trim())) {
                note(`[FIX] Invalid 'text: ${value}' -> 'text-align: ${value}' (JAI paste typo)`);
                cleaned.set('text-align', value);
                textAlignFixes += 1;
                continue;
            }
            cleaned.set(key, value);
        }
        const serialized = janitorStyleString(cleaned);
        if (serialized) node.attrs.style = serialized;
        else delete node.attrs.style;
    }
    if (textAlignFixes) note(`[FIX] Repaired ${textAlignFixes} broken text-align declarations`);

    // ---- legacy align="" ---------------------------------------------------
    for (const node of elementsUnder(root)) {
        if (!('align' in node.attrs)) continue;
        const style = parseJanitorStyle(node.attrs.style ?? '');
        style.set('text-align', node.attrs.align);
        node.attrs.style = janitorStyleString(style);
        delete node.attrs.align;
        note('[FIX] Legacy align attribute -> text-align style');
    }

    // ---- image-only <span> wrappers ---------------------------------------
    if (settings.unwrapSpans) {
        let unwrapped = 0;
        for (const span of elementsUnder(root).filter(node => node.name === 'span')) {
            const children = elementsUnder(span);
            if (children.length && children.every(child => child.name === 'img') && !hasText(span)) {
                unwrap(span);
                unwrapped += 1;
            }
        }
        if (unwrapped) note(`[STRIP] Unwrapped ${unwrapped} image-only <span> wrappers`);
    }

    // ---- empty spacer blocks ----------------------------------------------
    if (settings.stripEmpty) {
        let emptied = 0;
        for (const node of elementsUnder(root).filter(child => BLOCK_TAGS.has(child.name) || HEADINGS.has(child.name))) {
            if (hasElement(node, new Set(['img', 'hr', 'iframe']))) continue;
            const text = textOf(node).replace(ZW, '').replace(/\xa0/g, ' ');
            if (!text.trim() && !elementsUnder(node).some(child => child.name === 'a')) {
                removeNode(node);
                emptied += 1;
            }
        }
        if (emptied) note(`[STRIP] Removed ${emptied} empty spacer paragraphs`);
    }

    // ---- blocks that fuse images with text --------------------------------
    const trimTrailingBreaks = block => {
        for (;;) {
            const kids = block.children.filter(child => !(child.type === 'text' && !child.value.trim()));
            const last = kids[kids.length - 1];
            if (last && last.type === 'element' && last.name === 'br') removeNode(last);
            else break;
        }
    };

    if (settings.splitImages) {
        let split = 0;
        for (const block of elementsUnder(root).filter(node => BLOCK_TAGS.has(node.name))) {
            const images = elementsUnder(block).filter(child => child.name === 'img');
            if (!images.length) continue;
            // Nested block structure (panel divs): leave it alone.
            if (elementsUnder(block).some(child => BLOCK_TAGS.has(child.name))) continue;
            if (images.length < 2 && !hasText(block)) {
                trimTrailingBreaks(block);
                continue;
            }
            const align = parseJanitorStyle(block.attrs.style ?? '').get('text-align') ?? '';
            const runs = [];
            let pending = [];
            const flush = () => {
                if (pending.length) runs.push(['inline', pending]);
                pending = [];
            };
            for (const child of [...block.children]) {
                if (child.type === 'text') {
                    if (child.value.replace(ZW, '').trim() === '') removeNode(child);
                    else pending.push(child);
                    continue;
                }
                if (child.name === 'br') {
                    flush();
                    removeNode(child);
                    continue;
                }
                if (child.name === 'img') {
                    flush();
                    runs.push(['img', child]);
                    continue;
                }
                if (child.name === 'span' && elementsUnder(child).some(node => node.name === 'img') && !hasText(child)) {
                    flush();
                    for (const image of elementsUnder(child).filter(node => node.name === 'img')) runs.push(['img', image]);
                    removeNode(child);
                    continue;
                }
                pending.push(child);
            }
            flush();
            if (runs.length <= 1) {
                trimTrailingBreaks(block);
                continue;
            }
            for (const [kind, payload] of runs) {
                let replacement;
                if (kind === 'img') {
                    replacement = element('p', align ? { style: `text-align: ${align};` } : {});
                    appendChild(replacement, payload);
                } else {
                    replacement = element(block.name, block.attrs.style ? { style: block.attrs.style } : {});
                    for (const child of payload) appendChild(replacement, child);
                }
                insertBefore(block, replacement);
            }
            removeNode(block);
            split += 1;
        }
        if (split) note(`[SPLIT] Split ${split} block(s) fusing images with text`);
    }

    // ---- responsive images ------------------------------------------------
    if (settings.fixImages) {
        let images = 0;
        for (const image of elementsUnder(root).filter(node => node.name === 'img')) {
            const style = parseJanitorStyle(image.attrs.style ?? '');
            const width = style.get('width') ?? '';
            const match = /^([\d.]+)px$/.exec(width);
            if (match) {
                style.delete('width');
                style.set('max-width', `min(${Math.round(Number(match[1]))}px, 100%)`);
            } else if (!style.has('max-width') && width !== '100%') {
                style.set('max-width', '100%'); // the missing fallback
            }
            if (!style.has('height')) style.set('height', 'auto');
            if (!style.has('border-radius')) style.set('border-radius', '8px');
            style.delete('cursor');
            image.attrs.style = janitorStyleString(style);
            images += 1;
        }
        if (images) note(`[IMG] Normalized ${images} image style(s) to responsive rules`);
    }

    // ---- macros -----------------------------------------------------------
    let macros = 0;
    const convertInText = node => {
        for (const child of [...node.children]) {
            if (child.type !== 'text') {
                convertInText(child);
                continue;
            }
            if (!child.value.includes('{')) continue;
            const count = (child.value.match(MACRO) ?? []).length;
            if (!count) continue;
            child.value = child.value.replace(MACRO, (_match, name) => `{{${name.toLowerCase()}}}`);
            macros += count;
        }
    };
    if (settings.convertMacros) {
        convertInText(root);
        if (macros) note(`[MACRO] Converted ${macros} single-brace macro(s) -> {{user}}/{{char}}`);
    }

    // ---- black-on-black <mark> -------------------------------------------
    if (settings.fixMarks) {
        for (const mark of elementsUnder(root).filter(node => node.name === 'mark')) {
            const style = parseJanitorStyle(mark.attrs.style ?? '');
            const background = parseColor(style.get('background-color') ?? style.get('background') ?? '');
            const foreground = parseColor(style.get('color') ?? '');
            if (background && luminance(background) < 0.22 && (foreground === null || luminance(foreground) < 0.22)) {
                style.set('color', '#ffffff');
                mark.attrs.style = janitorStyleString(style);
                note('[FIX] Dark <mark> with dark/inherit text -> forced white text (was unreadable)');
            }
        }
    }

    // ---- links ------------------------------------------------------------
    if (settings.fixLinks) {
        let decoded = 0;
        let absolutized = 0;
        let mirror = false;
        for (const anchor of elementsUnder(root).filter(node => node.name === 'a' && 'href' in node.attrs)) {
            let href = String(anchor.attrs.href ?? '');
            let target = null;
            const external = EXTLINK.exec(href);
            if (external) {
                try {
                    target = decodeURIComponent(external[1]);
                } catch {
                    target = external[1];
                }
            } else if (/^(?:https?:\/\/[^/]+)?\/external-link\?/i.test(href)) {
                // Measured against the Python: `/external-link?to=…` — the common
                // form — does not match EXTLINK at all, so those links stayed a
                // redirect through JanitorAI. Read the parameter instead.
                try {
                    target = new URL(href, BASE).searchParams.get('to');
                } catch {
                    target = null;
                }
            }
            if (target) {
                href = target;
                decoded += 1;
            } else if (href.startsWith('/')) {
                href = BASE + href;
                absolutized += 1;
            }
            anchor.attrs.href = href;
            if (href.startsWith('http')) {
                anchor.attrs.target = '_blank';
                anchor.attrs.rel = 'noopener noreferrer';
            }
            if (href.includes('ibb.co.com')) mirror = true;
        }
        if (decoded) note(`[LINK] Decoded ${decoded} JanitorAI redirect link(s)`);
        if (absolutized) note(`[LINK] Absolutized ${absolutized} relative link(s)`);
        if (mirror) note('[WARN] ibb.co.com mirror-domain gallery links present - if they ever fail to load, use ibb.co instead');
    }

    // ---- classes ----------------------------------------------------------
    for (const node of elementsUnder(root)) {
        if ('class' in node.attrs) delete node.attrs.class;
    }

    // ---- output -----------------------------------------------------------
    const wrapStyle = `max-width: ${settings.width}px; margin: 0 auto; font-family: inherit;`;
    const body = [];
    for (const child of [...root.children]) {
        if (child.type === 'text' && !child.value.trim()) continue;
        const serialized = serializeJanitorHtml(child).trim();
        if (serialized) body.push(serialized);
    }
    if (settings.credit) {
        let credit;
        if (authorName && authorUrl) {
            credit = `Original bot by <a href="${authorUrl}" target="_blank" rel="noopener noreferrer">@${authorName}</a> on JanitorAI`;
        } else if (authorName) {
            credit = `Original bot by @${authorName} on JanitorAI`;
        } else {
            credit = 'Original bot by @AUTHOR on JanitorAI';
        }
        body.push('<hr>');
        body.push(`<p style="text-align: center; font-size: 0.85em; opacity: 0.7;">${credit}</p>`);
    }
    const output = `<div style="${wrapStyle}">\n${body.join('\n')}\n</div>`;

    // ---- review log -------------------------------------------------------
    // The boundary class includes quotes: `style="color: #fff"` has the colour as
    // its first declaration, and the Python's `[;\s]` boundary missed exactly that.
    const lightColours = [...output.matchAll(/(?:^|[;\s"'])(color|background-color|background)\s*:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))/g)]
        .map(match => parseColor(match[2]))
        .filter(color => color && luminance(color) > 0.85).length;
    if (lightColours) {
        note(`[WARN] ${lightColours} light/white text color(s) detected - this card expects a DARK SillyTavern theme`);
    }
    const imageCount = (output.match(/<img\b/g) ?? []).length;
    if (imageCount) note(`[INFO] ${imageCount} image(s) hotlinked from JanitorAI CDN - rehost them if you want the card self-contained`);
    if (settings.doubleWord) {
        const text = output.replace(/<[^>]+>/g, ' ');
        const hits = new Set();
        for (const match of text.matchAll(DOUBLE_WORD)) {
            if (!['that', 'had'].includes(match[1].toLowerCase())) hits.add(match[0]);
        }
        if (hits.size) note(`[MANUAL] Possible double-word typos to check: ${[...hits].sort().slice(0, 8).map(hit => `'${hit}'`).join('; ')}`);
    }
    note('[MANUAL] Human review still needed: typos/grammar, scenario numbering, judgment calls, creator-voice edits');

    return { html: output, log };
}
