import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Contract guards for the vault client and the automation window.
 *
 * The client has no DOM harness: `index.js` runs inside the page and reads
 * SillyTavern globals at import time, so its behaviour is verified in the real UI
 * (see docs/PITFALLS.md checks). What *can* be pinned here is the exact contract
 * that broke, so the same regression cannot come back unnoticed:
 *
 *  - PITFALLS #33: the JanitorAI search must send `mode`, or "Show NSFW off" is
 *    only a label.
 *  - PITFALLS #34: the HTML guard must contain the two characters `\` `b`, not a
 *    stray control byte (a regex with a literal backspace compiles and never
 *    matches).
 *  - The NSFW artwork blur is gone for good (user decision, 2026-11-26).
 *  - PITFALLS #35: `reveal()` must re-apply the taskbar style it just removed.
 *
 * The automation window's process/CDP/window code now lives in the Chrome backend
 * (EMBEDDED-ENGINE-PLAN Phase 1), so the guards below read both modules: they pin
 * what the code does, not which file it happens to sit in.
 */

const clientDir = path.resolve('public/scripts/extensions/weavers-vault');
const clientJs = fs.readFileSync(path.join(clientDir, 'index.js'), 'utf8');
const clientCss = fs.readFileSync(path.join(clientDir, 'style.css'), 'utf8');
const browserJs = [
    fs.readFileSync(path.resolve('src/endpoints/weavers-vault-browser.js'), 'utf8'),
    fs.readFileSync(path.resolve('src/endpoints/weavers-vault-chrome-backend.js'), 'utf8'),
].join('\n');

describe('janitor search request', () => {
    test('sends the SFW/NSFW switch as the site mode parameter', () => {
        // The branch that builds the janitor query string.
        const start = clientJs.indexOf("params.set('mode'");
        expect(start).toBeGreaterThan(-1);
        const line = clientJs.slice(start, clientJs.indexOf('\n', start));
        expect(line).toMatch(/mode.*sfw.*all|all.*sfw/);
        // And it reads the switch, not a constant.
        expect(line).toMatch(/f\.nsfw/);
        // The grid refuses NSFW rows while the switch is off, whatever the site
        // chooses to list.
        expect(clientJs).toMatch(/if \(item\.nsfw && !state\.filters\?\.nsfw\) continue;/);
    });
});

describe('converted janitor bio', () => {
    test('the HTML guard uses a real word boundary, not a control byte', () => {
        const guard = clientJs.match(/const isHtml = [^\n]+/)?.[0] ?? '';
        expect(guard).toContain('blockquote');
        expect(guard).toContain('\\b');
        expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clientJs)).toBe(false);
    });
});

describe('nsfw artwork', () => {
    test('is never blurred', () => {
        expect(clientJs).not.toMatch(/wv-blur|wv-reveal|wv-blurred/);
        expect(clientCss).not.toMatch(/wv-blur|wv-reveal|blur\(16px\)/);
        // The kebab no longer offers an unblur action.
        expect(clientJs).not.toMatch(/Unblur NSFW/);
    });
});

describe('reused automation session', () => {
    test('adoption re-asserts the window state instead of inheriting it', () => {
        const adopt = browserJs.slice(browserJs.indexOf('async adoptExisting'));
        const body = adopt.slice(0, adopt.indexOf('async start()'));
        // Every request after the first reuses the running browser; leaving the
        // window where the last human step put it is PITFALLS #37.
        expect(body).toMatch(/this\.isHeld\(\)[\s\S]{0,120}park\(\)/);
        // And park() must be able to find the window without a prior reveal.
        const park = browserJs.slice(browserJs.indexOf('async park()'));
        expect(park.slice(0, park.indexOf('async hideWindow'))).toContain('Browser.getWindowForTarget');
    });
});

describe('revealed automation window', () => {
    test('takes its own hold so the idle teardown cannot close it', () => {
        const reveal = browserJs.slice(browserJs.indexOf('async reveal()'));
        const body = reveal.slice(0, reveal.indexOf('async placeWindowOnScreen'));
        expect(body).toMatch(/if \(!this\.isHeld\(\)\) this\.hold\(/);
    });

    test('leaves a normal window (taskbar button and Alt-Tab) for the human', () => {
        const reveal = browserJs.slice(browserJs.indexOf('async reveal()'));
        const body = reveal.slice(0, reveal.indexOf('async placeWindowOnScreen'));
        // This test used to assert the opposite. Stripping the taskbar button
        // from the window a human has to sign in through left it with neither a
        // taskbar button nor an Alt-Tab entry, i.e. findable only by luck (the
        // user's complaint, 2026-11-26). park() restores the tool style on release.
        expect(body).not.toMatch(/hideWindow/);
        expect(body).toContain('this.taskbarHidden = false;');
    });

    test('stops the taskbar watcher before it hands the window over', () => {
        const reveal = browserJs.slice(browserJs.indexOf('async reveal()'));
        const body = reveal.slice(0, reveal.indexOf('async placeWindowOnScreen'));
        // The watcher restyles every window it sees for its whole budget; left
        // running, it would strip the button again a tick after normalizeProfileWindows().
        const stop = body.indexOf('this.stopTaskbarWatch()');
        expect(stop).toBeGreaterThan(-1);
        expect(stop).toBeLessThan(body.indexOf('focusPage()'));
    });
});

describe('launch sequence', () => {
    test('parks the window before the challenge wait', () => {
        const start = browserJs.slice(browserJs.indexOf('async start()'));
        const body = start.slice(0, start.indexOf('async prepareProfile('));
        const park = body.indexOf('await this.park()');
        const wait = body.indexOf('await this.waitForPage()');
        // waitForPage() can spend the whole challenge budget. Parking after it
        // left the window wherever Chrome restored its saved placement — on
        // screen, mid-desktop, for the entire wait (measured 2026-11-26).
        expect(park).toBeGreaterThan(-1);
        expect(wait).toBeGreaterThan(-1);
        expect(park).toBeLessThan(wait);
        // And still a safety net after the wait, for a window Chrome created late.
        expect(body.lastIndexOf('await this.park()')).toBeGreaterThan(wait);
    });
});

describe('detail sheet accordion', () => {
    test('the open body has no pixel height cap (PITFALLS #44)', () => {
        // The bug was a contract choice, not a typo: 'max-height: 2000px' plus
        // 'overflow: hidden' painted 1956px of a 5665px description and left the
        // sheet's own scrollbar ending at 2511px, i.e. the rest was unreachable.
        // Measured 2026-11-26 in a stylesheet harness: 2511px scrollable before,
        // 6160px after (content fully inside).
        const rule = clientCss.slice(clientCss.indexOf('.wv-acc.open .wv-accbody'));
        const openBlock = rule.slice(0, rule.indexOf('}'));
        expect(openBlock).toMatch(/max-height:\s*none;/);
        expect(openBlock).not.toMatch(/max-height:\s*\d+px/);
        // The closed state keeps its 3-line clamp: only the open one is uncapped.
        const closed = clientCss.slice(clientCss.indexOf('.wv-accbody {'));
        expect(closed.slice(0, closed.indexOf('}'))).toMatch(/max-height:\s*\d+px;/);
    });

    test('the expansion is measured, not guessed', () => {
        const all = clientJs.slice(clientJs.indexOf("popup.querySelectorAll('.wv-acc')"));
        const handler = all.slice(0, all.indexOf('wv-greetrow'));
        // Open: hand the real content height to the transition...
        expect(handler).toContain('body.scrollHeight');
        // ...then release it, or the body stays frozen at that height.
        expect(handler).toContain('body.style.maxHeight =');
        expect(handler).toContain('none');
        // Closing pins the height first; from 'none' the transition would snap.
        expect(handler).toContain('void body.offsetHeight');
    });
});

describe('engine binary resolution', () => {
    test('keeps the candidate list with the helper that reads it', () => {
        // Splitting the engine out once moved findBrowserBinary() but left its
        // candidate list behind: everything passed, because no unit test starts a
        // browser and only start() reads that constant (PITFALLS #39).
        expect(browserJs).toContain('const BROWSER_CANDIDATES = [');
        const helper = browserJs.slice(browserJs.indexOf('function findBrowserBinary'));
        const body = helper.slice(0, helper.indexOf('\n}'));
        expect(body).toContain('BROWSER_CANDIDATES');
        // And the list is still a real list, not an empty array left by a delete.
        const list = browserJs.slice(browserJs.indexOf('const BROWSER_CANDIDATES = ['));
        expect(list.slice(0, list.indexOf('].filter(Boolean)'))).toContain('chrome.exe');
    });
});
