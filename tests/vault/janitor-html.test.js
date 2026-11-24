// The bio converter is a port of the user's `janitor2st.py` (763 lines, ~40 manual
// conversions behind it). Each block below tests one rule that exists because a
// real card broke without it, and the expected strings are what the Python emits
// — the oklab values were produced by running the Python itself, so these are
// cross-implementation checks, not self-fulfilling ones.

import { describe, test, expect } from '@jest/globals';
import {
    convertJanitorBio,
    janitorStyleString,
    oklabToHex,
    parseColor,
    parseJanitorStyle,
    serializeJanitorHtml,
    parseJanitorHtml,
} from '../../src/endpoints/weavers-vault-janitor-html.js';

const AUTHOR = { author: 'Neo', authorUrl: 'https://janitorai.com/profiles/neo' };
const convert = (html, options = {}) => convertJanitorBio(html, { ...AUTHOR, ...options });

describe('oklab() colours', () => {
    // Measured against janitor2st.py: the same five triples.
    test.each([
        [0.7, 0.1, 0.1, '#e57f4e'],
        [0.5, 0.0, 0.0, '#636363'],
        [0.9, 0.02, -0.05, '#ded8ff'],
        [0.3, -0.1, 0.15, '#1d3700'],
        [1.0, 0.0, 0.0, '#ffffff'],
    ])('oklab(%s %s %s) -> %s', (L, a, b, expected) => {
        expect(oklabToHex(L, a, b)).toBe(expected);
    });

    test('an inline oklab colour is replaced, because a browser that cannot parse it falls back to black', () => {
        const { html, log } = convert('<p style="color: oklab(0.7 0.1 0.1)">hi</p>');
        expect(html).toContain('color: #e57f4e');
        expect(html).not.toContain('oklab(');
        expect(log.some(line => line.includes('oklab() color -> #e57f4e'))).toBe(true);
    });
});

describe('macros', () => {
    test('single-brace macros become {{user}}/{{char}}, in any case and with spaces', () => {
        const { html, log } = convert('<p>{user} meets {User} and { char } and {CHAR}</p>');
        expect(html).toContain('{{user}} meets {{user}} and {{char}} and {{char}}');
        expect(log.some(line => line.includes('Converted 4 single-brace macro'))).toBe(true);
    });

    test('an existing double-brace macro is never touched', () => {
        const { html } = convert('<p>{{user}} and {{char}} and {user}</p>');
        expect(html).toContain('{{user}} and {{char}} and {{user}}');
        // The `{user}` above is the only one that may have been rewritten, and it
        // became `{{user}}` — so the count of `{{` is 3, not 5.
        expect((html.match(/\{\{/g) ?? []).length).toBe(3);
    });

    test('a macro inside nested markup is converted too', () => {
        const { html } = convert('<p><strong>{char}</strong> looks at <em>{user}</em>.</p>');
        expect(html).toContain('<strong>{{char}}</strong> looks at <em>{{user}}</em>.');
    });
});

describe('inline style hazards', () => {
    test("the editor's `text: center` typo becomes text-align", () => {
        const { html, log } = convert('<p style="text: center">x</p>');
        expect(html).toContain('text-align: center');
        expect(html).not.toContain('text: center');
        expect(log.some(line => line.includes("Invalid 'text: center' -> 'text-align: center'"))).toBe(true);
    });

    test('the legacy align attribute becomes a style and the attribute is dropped', () => {
        const { html, log } = convert('<p align="center">x</p>');
        expect(html).toContain('style="text-align: center"');
        expect(html).not.toContain('align="center"');
        expect(log.some(line => line.includes('Legacy align attribute'))).toBe(true);
    });

    test('a single wrapping div keeps its children but not its own attributes', () => {
        // The wrapper div is replaced by ours, so anything on it would vanish
        // anyway; the content must still come through.
        const { html } = convert('<div class="markdown-body" align="center"><p>a</p><p>b</p></div>');
        expect(html).toContain('<p>a</p>');
        expect(html).toContain('<p>b</p>');
        expect(html).not.toContain('align=');
        expect(html).not.toContain('class=');
    });

    test('-webkit- prefixes and cursor:pointer are dropped', () => {
        const { html } = convert('<p style="-webkit-text-fill-color: red; cursor: pointer; color: blue">x</p>');
        expect(html).toContain('color: blue');
        expect(html).not.toContain('-webkit-');
        expect(html).not.toContain('cursor');
    });

    test('a data: url in a style survives, because semicolons inside parens are not separators', () => {
        const style = parseJanitorStyle('background-image: url(data:image/png;base64,AA;BB); color: red');
        expect(style.get('background-image')).toBe('url(data:image/png;base64,AA;BB)');
        expect(style.get('color')).toBe('red');
        expect(janitorStyleString(style)).toBe('background-image: url(data:image/png;base64,AA;BB); color: red');
    });
});

describe('attributes the editor leaves behind', () => {
    test('lightbox/framework attributes and empty titles go', () => {
        const { html, log } = convert('<p><img src="https://x/a.png" node="1" draggable="false" aria-hidden="true" title="">text</p>');
        expect(html).not.toMatch(/node=|draggable|aria-hidden|title=/);
        expect(log.some(line => line.includes('Removed 4 lightbox/framework attributes'))).toBe(true);
    });

    test('every class attribute is gone — a class without its stylesheet is dead weight', () => {
        const { html } = convert('<div class="css-abc"><p class="chakra-text _x">x</p><span class="ds-markdown">y</span></div>');
        expect(html).not.toContain('class=');
    });

    test('svg and style elements are removed entirely', () => {
        const { html } = convert('<p>a</p><svg><path d="M0 0"/></svg><style>.a{color:red}</style><p>b</p>');
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('<style');
        expect(html).toContain('<p>a</p>');
        expect(html).toContain('<p>b</p>');
    });
});

describe('empty spacer paragraphs', () => {
    test('a paragraph with no text and no image is removed', () => {
        const { html, log } = convert('<p>a</p><p> </p><p>&nbsp;</p><p>\u200b</p><p>b</p>');
        expect((html.match(/<p>/g) ?? []).length).toBe(2);
        expect(log.some(line => line.includes('Removed 3 empty spacer paragraphs'))).toBe(true);
    });

    test('a paragraph holding an image, an <hr> or a link is kept', () => {
        const { html } = convert('<p><img src="https://x/a.png"></p><p><hr></p><p><a href="https://x"> </a></p>');
        expect(html).toContain('<img');
        expect(html).toContain('<hr');
        expect(html).toContain('<a href="https://x"');
    });

    test('empty headings are removed as well', () => {
        const { html } = convert('<h2></h2><h2>Title</h2>');
        expect((html.match(/<h2>/g) ?? []).length).toBe(1);
    });
});

describe('images', () => {
    test('a fixed pixel width becomes a responsive max-width, with height and radius filled in', () => {
        const { html, log } = convert('<p><img src="https://x/a.png" style="width: 300px"></p>');
        expect(html).toContain('max-width: min(300px, 100%)');
        expect(html).toContain('height: auto');
        expect(html).toContain('border-radius: 8px');
        expect(html).not.toContain('width: 300px');
        expect(log.some(line => line.includes('Normalized 1 image style'))).toBe(true);
    });

    test('an image with no width gets max-width 100% — the fallback the Python added', () => {
        const { html } = convert('<p><img src="https://x/a.png"></p>');
        expect(html).toContain('max-width: 100%');
    });

    test('an existing height and radius are preserved', () => {
        const { html } = convert('<p><img src="https://x/a.png" style="height: 120px; border-radius: 2px"></p>');
        expect(html).toContain('height: 120px');
        expect(html).toContain('border-radius: 2px');
    });

    test('an image-only span wrapper is unwrapped', () => {
        const { html, log } = convert('<p><span><img src="https://x/a.png"></span></p>');
        expect(html).not.toContain('<span>');
        expect(html).toContain('<img');
        expect(log.some(line => line.includes('Unwrapped 1 image-only <span>'))).toBe(true);
    });

    test('a block fusing text and an image is split into separate blocks', () => {
        const { html, log } = convert('<p>before<img src="https://x/a.png">after</p>');
        expect(html).toContain('<p>before</p>');
        expect(html).toContain('after');
        // The image ends up in its own paragraph, not inside the text run.
        expect(/<p><img[^>]*><\/p>/.test(html)).toBe(true);
        expect(log.some(line => line.includes('Split 1 block(s) fusing images with text'))).toBe(true);
    });

    test('the split keeps the block alignment', () => {
        const { html } = convert('<p style="text-align: center">text<img src="https://x/a.png"></p>');
        expect(html).toContain('<p style="text-align: center;"><img');
    });

    test('a block with nested block structure is left alone', () => {
        const { html } = convert('<div><p>a</p><img src="https://x/a.png"><p>b</p></div>');
        // Top-level children are joined with newlines, so match across them.
        expect(html).toMatch(/<p>a<\/p>\s*<img/);
    });
});

describe('dark-on-dark <mark>', () => {
    test('a dark mark with inherited text gets white text', () => {
        const { html, log } = convert('<p><mark style="background-color: #000000">hidden</mark></p>');
        expect(html).toContain('color: #ffffff');
        expect(log.some(line => line.includes('Dark <mark> with dark/inherit text'))).toBe(true);
    });

    test('a dark mark with explicitly dark text gets white too', () => {
        const { html } = convert('<p><mark style="background-color: #111; color: #222">x</mark></p>');
        expect(html).toContain('color: #ffffff');
    });

    test('a light mark is untouched', () => {
        const { html } = convert('<p><mark style="background-color: #ffff00">x</mark></p>');
        expect(html).not.toContain('color: #ffffff');
    });

    test('parseColor understands the forms the editor emits', () => {
        expect(parseColor('black')).toEqual([0, 0, 0]);
        expect(parseColor('#fff')).toEqual([1, 1, 1]);
        expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual([0, 0, 0]);
        expect(parseColor('inherit')).toBeNull();
        expect(parseColor('')).toBeNull();
    });
});

describe('links', () => {
    // Measured: the Python's EXTLINK regex needs a second `?`/`&` before `to=`, so
    // the common `/external-link?to=…` form was never decoded — it was absolutized
    // into a redirect through JanitorAI. The port reads the parameter instead.
    test('a /external-link?to= redirect is decoded, not linked through JanitorAI', () => {
        const { html, log } = convert('<p><a href="/external-link?to=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1">go</a></p>');
        expect(html).toContain('href="https://example.com/a?b=1"');
        expect(html).not.toContain('external-link');
        expect(log.some(line => line.includes('Decoded 1 JanitorAI redirect link'))).toBe(true);
    });

    test('a relative link becomes absolute', () => {
        const { html, log } = convert('<p><a href="/profiles/someone">profile</a></p>');
        expect(html).toContain('href="https://janitorai.com/profiles/someone"');
        expect(log.some(line => line.includes('Absolutized 1 relative link'))).toBe(true);
    });

    test('external links open in a new tab with rel=noopener', () => {
        const { html } = convert('<p><a href="https://example.com">x</a></p>');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test('the ibb.co.com mirror domain is reported', () => {
        const { log } = convert('<p><a href="https://ibb.co.com/x">img</a></p>');
        expect(log.some(line => line.includes('ibb.co.com mirror-domain'))).toBe(true);
    });
});

describe('the output wrapper and credit line', () => {
    test('the content is wrapped at the card width', () => {
        const { html } = convert('<p>x</p>');
        expect(html.startsWith('<div style="max-width: 700px; margin: 0 auto; font-family: inherit;">')).toBe(true);
        expect(html.trimEnd().endsWith('</div>')).toBe(true);
    });

    test('the width can be changed', () => {
        const { html } = convert('<p>x</p>', { width: 900 });
        expect(html).toContain('max-width: 900px');
    });

    test('the credit line names the creator and links the profile', () => {
        const { html } = convert('<p>x</p>');
        const credit = html.split('<hr>')[1] ?? '';
        expect(credit).toContain('Original bot by');
        expect(credit).toContain('href="https://janitorai.com/profiles/neo"');
        expect(credit).toContain('@Neo</a> on JanitorAI');
        expect(credit).toContain('text-align: center');
    });

    test('without a profile URL the credit is plain text', () => {
        const { html } = convert('<p>x</p>', { author: 'Neo', authorUrl: '' });
        expect(html).toContain('Original bot by @Neo on JanitorAI');
        expect(html).not.toContain('<a href="https://janitorai.com/profiles/neo"');
    });

    test('without an author the credit says so instead of inventing one', () => {
        const { html, log } = convert('<p>x</p>', { author: '', authorUrl: '' });
        expect(html).toContain('Original bot by @AUTHOR on JanitorAI');
        expect(log.some(line => line.includes('No author found'))).toBe(true);
    });

    test('the credit can be turned off', () => {
        const { html } = convert('<p>x</p>', { credit: false });
        expect(html).not.toContain('Original bot by');
        expect(html).not.toContain('<hr>');
    });

    test('the author is taken from the editor’s own profile link when none is given', () => {
        const { html } = convert('<p><a href="https://janitorai.com/profiles/other">@OtherName</a> wrote this</p>', { author: '', authorUrl: '' });
        expect(html).toContain('Original bot by <a href="https://janitorai.com/profiles/other"');
        expect(html).toContain('@OtherName</a> on JanitorAI');
    });
});

describe('the review log', () => {
    test('hotlinked images are counted', () => {
        const { log } = convert('<p><img src="https://ella.janitorai.com/a.png"></p><p><img src="https://ella.janitorai.com/b.png"></p>');
        expect(log.some(line => line.includes('2 image(s) hotlinked'))).toBe(true);
    });

    test('light text colours trigger the dark-theme warning', () => {
        const { log } = convert('<p style="color: #ffffff">x</p>');
        expect(log.some(line => line.includes('light/white text color'))).toBe(true);
    });

    test('double-word typos are reported, with the harmless ones excluded', () => {
        // The Python's rule matches words of 3+ letters and drops "that"/"had",
        // which are legitimate repeats in speech.
        const { log } = convert('<p>this is broken broken and that that is fine</p>');
        const line = log.find(entry => entry.includes('double-word')) ?? '';
        expect(line).toContain("'broken broken'");
        expect(line).not.toContain('that that');
    });

    test('a human review note is always the last entry', () => {
        const { log } = convert('<p>x</p>');
        expect(log[log.length - 1]).toContain('Human review still needed');
    });

    test('a clean card produces no fix entries', () => {
        const { log } = convert('<p>Just text.</p>');
        expect(log.filter(entry => entry.startsWith('[FIX]'))).toEqual([]);
    });
});

describe('executable content', () => {
    // The Python never needed this: a human pasted its output. Ours is rendered
    // with innerHTML and stored in a card automatically, and a bio is third-party.
    test('script, style, iframe, object, embed and form are removed', () => {
        const { html } = convert('<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="https://e"></iframe><object data="x"></object><embed src="x"><form><input value="x"></form>');
        expect(html).not.toMatch(/<(script|style|iframe|object|embed|form|input)/i);
        expect(html).toContain('<p>a</p>');
    });

    test('every on* handler is removed and counted', () => {
        const { html, log } = convert('<p onclick="steal()">a</p><img src="https://x/a.png" onerror="steal()">');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('onerror');
        expect(log.some(line => line.includes('Removed 2 executable attribute(s)'))).toBe(true);
    });

    test('javascript: URLs are removed, and only those', () => {
        const { html } = convert('<p><a href="javascript:alert(1)">x</a><a href="https://example.com">y</a></p>');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('href="https://example.com"');
    });

    test('ordinary attributes survive', () => {
        const { html } = convert('<p><img src="https://x/a.png" alt="a cat" loading="lazy"></p>');
        expect(html).toContain('alt="a cat"');
        expect(html).toContain('loading="lazy"');
    });
});

describe('text handling', () => {
    test('existing entities survive and bare characters are escaped', () => {
        const { html } = convert('<p>Tom &amp; Jerry &lt;3 a &lt; b & c</p>');
        expect(html).toContain('Tom &amp; Jerry &lt;3 a &lt; b &amp; c');
        // No double-escaping of the entity that was already there.
        expect(html).not.toContain('&amp;amp;');
    });

    test('attribute values are escaped', () => {
        const { html } = convert('<p><a href="https://x/?a=1&b=2">x</a></p>');
        expect(html).toContain('href="https://x/?a=1&amp;b=2"');
    });

    test('a stray closing tag does not throw or swallow the text', () => {
        const { html } = convert('<p>a</span>b</p>');
        expect(html).toContain('ab');
    });

    test('an unclosed paragraph still yields its text', () => {
        const { html } = convert('<p>unclosed text');
        expect(html).toContain('unclosed text');
    });
});

describe('the parser itself', () => {
    test('it builds the expected tree for the shapes a bio uses', () => {
        const tree = parseJanitorHtml('<p>a<br>b</p><img src="x"><div><span>c</span></div>');
        expect(tree.children.map(child => child.name)).toEqual(['p', 'img', 'div']);
        expect(tree.children[0].children.map(child => child.name ?? 'text')).toEqual(['text', 'br', 'text']);
    });

    test('it serializes back to the same markup', () => {
        expect(serializeJanitorHtml(parseJanitorHtml('<p class="a">x<br>y</p>'))).toBe('<p class="a">x<br>y</p>');
    });

    test('a block start closes an open paragraph the way a browser does', () => {
        const tree = parseJanitorHtml('<p>a<div>b</div>');
        // Without the auto-close this would nest the div inside the paragraph.
        expect(tree.children.map(child => child.name)).toEqual(['p', 'div']);
    });
});
