/**
 * The page script injected into janitorai.com before its own scripts run.
 *
 * Ported VERBATIM from Glaze 0.10.1 `janitor_webview_proxy.dart`
 * (`_captureUserScript`, lines 162-500), AGPL-3.0, because every selector and
 * every timing in it was earned against the live site: the React native-setter
 * trick (a plain `el.value = …` leaves React's state empty and the send no-ops),
 * the forced `keyCode`/`which` (the KeyboardEvent constructor zeroes them), the
 * English-`aria-label` assumption, the stop-button abort loop, the composer
 * tagging, and the bounded `__glazeAlphaLog` that turns a bare timeout into
 * "never fired / refused / not a prompt".
 *
 * Loaded by `weavers-vault-janitor-capture.js` and installed through CDP's
 * `Page.addScriptToEvaluateOnNewDocument`, so it hooks `fetch`/`XMLHttpRequest`
 * before the site's bundle captures its own reference.
 *
 * It is a plain file, not a module: it is read as text and injected.
 */
(function () {
    if (window.__glazeHooked) return;
    window.__glazeHooked = true;
    window.__glazeAlpha = null;

    const looksLikePayload = (o) =>
      o && Array.isArray(o.messages) &&
      o.messages.some((m) => m && m.role === 'system' && typeof m.content === 'string');

    // Every `/generateAlpha` round trip we observe, matched or not. A capture
    // that times out is otherwise indistinguishable between "the request never
    // fired", "it fired and the server refused" and "the body wasn't a prompt";
    // the Dart side reads this log on timeout and reports which one happened.
    window.__glazeAlphaLog = [];
    // Every request the page makes that is not a GET, whatever its path. The
    // alpha log above only keeps `/generateAlpha`, so when the site renames its
    // generate endpoint a timeout reports "nothing was requested" while the page
    // is demonstrably sending something. Measured on the live site: the send went
    // out, the composer cleared, and this log is the only way to see where it went.
    window.__glazeNetLog = [];
    const noteNet = (method, url, status) => {
      try {
        const path = String(url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 120);
        window.__glazeNetLog.push({ m: method, u: path, s: status, t: Math.round(performance.now()) });
        while (window.__glazeNetLog.length > 40) window.__glazeNetLog.shift();
      } catch (e) {}
    };
    const noteAlpha = (entry) => {
      try {
        entry.t = Math.round(performance.now());
        window.__glazeAlphaLog.push(entry);
        // Bounded: a long capture must not grow the page's memory unbounded.
        while (window.__glazeAlphaLog.length > 12) window.__glazeAlphaLog.shift();
      } catch (e) {}
    };
    // Records one response body and, when it is the assembled prompt, keeps it.
    const takeAlpha = (via, status, text) => {
      let j = null;
      try { j = JSON.parse(text); } catch (e) {}
      const matched = !!looksLikePayload(j);
      if (matched) window.__glazeAlpha = j;
      noteAlpha({
        via: via,
        status: status,
        matched: matched,
        body: matched ? '' : (text || '').slice(0, 300),
      });
    };
    const isAlphaUrl = (u) =>
      typeof u === 'string' && u.indexOf('/generateAlpha') >= 0;

    // --- fetch hook ---
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (origFetch) {
      window.fetch = async function (...args) {
        let alpha = false;
        let netUrl = '';
        let netMethod = 'GET';
        try {
          const a0 = args[0];
          alpha = isAlphaUrl((a0 && a0.url) ? a0.url : a0);
          netUrl = (a0 && a0.url) ? a0.url : a0;
          const init = args[1];
          netMethod = (init && init.method) || 'GET';
        } catch (e) {}
        let res;
        try {
          res = await origFetch(...args);
        } catch (e) {
          if (String(netMethod).toUpperCase() !== 'GET') noteNet(netMethod, netUrl, 0);
          // A transport-level failure never reaches the `load` path below, so
          // log it here or the timeout would look like silence.
          if (alpha) noteAlpha({ via: 'fetch', status: 0, matched: false, body: 'network error: ' + e });
          throw e;
        }
        try {
          if (String(netMethod).toUpperCase() !== 'GET') noteNet(netMethod, netUrl, res.status);
        } catch (e) {}
        try {
          if (alpha) {
            const status = res.status;
            res.clone().text()
              .then((txt) => takeAlpha('fetch', status, txt))
              .catch((e) => noteAlpha({ via: 'fetch', status: status, matched: false, body: 'unreadable body: ' + e }));
          }
        } catch (e) {}
        return res;
      };
    }

    // --- XMLHttpRequest hook ---
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const open = OrigXHR.prototype.open;
      OrigXHR.prototype.open = function (method, url) {
        this.__glazeUrl = url;
        this.__glazeMethod = method;
        return open.apply(this, arguments);
      };
      OrigXHR.prototype.addEventListener &&
        (function () {
          const send = OrigXHR.prototype.send;
          OrigXHR.prototype.send = function () {
            try {
              const xhrMethod = this.__glazeMethod || 'GET';
              if (String(xhrMethod).toUpperCase() !== 'GET') {
                this.addEventListener('load', () => noteNet(xhrMethod, this.__glazeUrl, this.status));
              }
            } catch (e) {}
            this.addEventListener('load', function () {
              try {
                if (isAlphaUrl(this.__glazeUrl)) {
                  takeAlpha('xhr', this.status, this.responseText);
                }
              } catch (e) {}
            });
            this.addEventListener('error', function () {
              try {
                if (isAlphaUrl(this.__glazeUrl)) {
                  noteAlpha({ via: 'xhr', status: this.status || 0, matched: false, body: 'network error' });
                }
              } catch (e) {}
            });
            return send.apply(this, arguments);
          };
        })();
    }

    // --- chat input + send ---
    const SEL = ['textarea[placeholder]', 'form textarea', 'textarea', 'div[contenteditable="true"]'];
    const findInput = () => {
      for (const s of SEL) {
        const els = document.querySelectorAll(s);
        for (let i = els.length - 1; i >= 0; i--) {
          const el = els[i];
          if (el && el.offsetParent !== null) return el;
        }
      }
      return null;
    };
    const setReactValue = (el, val) => {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.focus();
        el.textContent = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    };
    const pressEnter = (el) => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const ev = new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        });
        // The KeyboardEvent constructor ignores keyCode/which (they stay 0), but
        // legacy "send on Enter" handlers often gate on e.keyCode/e.which === 13.
        // Force them so a synthetic Enter can still trigger a send.
        try {
          Object.defineProperty(ev, 'keyCode', { get: () => 13 });
          Object.defineProperty(ev, 'which', { get: () => 13 });
        } catch (e) {}
        el.dispatchEvent(ev);
      }
    };
    // Whether a button is a live, clickable "send" control (not a stop/cancel).
    // aria-label stays English across UI locales (confirmed on a Polish client),
    // so it's the reliable signal; the hashed `_sendButton_…` class is a backup.
    const isSendBtn = (b) => {
      if (!b || b.offsetParent === null || b.disabled) return false;
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (label.indexOf('stop') >= 0 || label.indexOf('cancel') >= 0) return false;
      return true;
    };
    // Locate the composer's send button. JanitorAI's composer no longer submits
    // on a bare Enter in every layout (the text just sits unsent), so we click
    // its send button: `<button aria-label="Send" class="_sendButton_…">` (not a
    // submit, not inside a <form>). Fall back to the last live button in the
    // container holding the input.
    const findSendButton = (input) => {
      const cands = document.querySelectorAll(
        'button[aria-label*="send" i], ' +
        'button[class*="sendButton" i], ' +
        'button[type="submit"]');
      for (let i = 0; i < cands.length; i++) {
        if (isSendBtn(cands[i])) return cands[i];
      }
      const scope = input.closest('form') || input.parentElement;
      if (scope) {
        const btns = Array.prototype.slice
          .call(scope.querySelectorAll('button')).filter(isSendBtn);
        if (btns.length) return btns[btns.length - 1];
      }
      return null;
    };
    // A visible stop/cancel button means a previous send is still streaming (or
    // hanging against the unreachable dummy proxy), which disables the composer.
    const findStopButton = () => {
      const btns = document.querySelectorAll(
        'button[aria-label*="stop" i], button[aria-label*="cancel" i]');
      for (let i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent !== null && !btns[i].disabled) return btns[i];
      }
      return null;
    };
    // JanitorAI occasionally throws a modal over the chat (persona picker,
    // content disclaimer, "what's new" popup…). Its backdrop (`_modalOverlay_…`)
    // sits above the composer and swallows the interaction, so the send never
    // lands. Best-effort dismiss: click an explicit close control inside the
    // dialog, else press Escape, and wait for the overlay to detach. No-op when
    // nothing is open. Port of JAR's dismissModals().
    const findOverlay = () => {
      const els = document.querySelectorAll(
        '[class*="modalOverlay" i], [class*="ModalOverlay"]');
      for (let i = els.length - 1; i >= 0; i--) {
        if (els[i] && els[i].offsetParent !== null) return els[i];
      }
      return null;
    };
    const pressEscape = () => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const ev = new KeyboardEvent(type, {
          key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        });
        // The KeyboardEvent constructor leaves keyCode/which at 0; legacy
        // "close on Escape" handlers gate on e.keyCode === 27, so force it.
        try {
          Object.defineProperty(ev, 'keyCode', { get: () => 27 });
          Object.defineProperty(ev, 'which', { get: () => 27 });
        } catch (e) {}
        (document.activeElement || document.body).dispatchEvent(ev);
        document.dispatchEvent(ev);
      }
    };
    const dismissModals = async (timeout) => {
      const deadline = Date.now() + (timeout || 4000);
      while (Date.now() < deadline) {
        const overlay = findOverlay();
        if (!overlay) return;
        // Prefer an explicit close button inside the dialog over dismissing blindly.
        const close = document.querySelector(
          '[class*="modal" i] button[aria-label*="close" i], ' +
          '[role="dialog"] button[aria-label*="close" i]');
        if (close && close.offsetParent !== null) {
          close.click();
        } else {
          pressEscape();
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    // The text currently sitting in the tagged composer ('' when it is gone).
    const composerText = () => {
      const t = document.querySelector('[data-glaze-composer]');
      if (!t) return '';
      return (t.value !== undefined && t.value !== null ? t.value : t.textContent) || '';
    };
    const waitComposerCleared = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 400));
        if (!composerText().trim()) return true;
      }
      return false;
    };
    // A compact snapshot of the composer area for the error message: which text
    // boxes exist, which one we drove, and what buttons sit next to it. Enough
    // to tell "an overlay is up" from "we typed into the wrong box".
    const describeComposer = () => {
      try {
        const areas = [];
        const nodes = document.querySelectorAll('textarea, div[contenteditable="true"]');
        for (let i = 0; i < nodes.length && i < 6; i++) {
          const t = nodes[i];
          areas.push({
            ph: (t.placeholder || '').slice(0, 20),
            shown: t.offsetParent !== null,
            chosen: t.hasAttribute('data-glaze-composer'),
            value: ((t.value !== undefined && t.value !== null ? t.value : t.textContent) || '').slice(0, 12),
            disabled: !!t.disabled,
          });
        }
        const btns = [];
        const all = document.querySelectorAll('button');
        for (let i = 0; i < all.length && btns.length < 8; i++) {
          const b = all[i];
          if (b.offsetParent === null) continue;
          btns.push({
            label: ((b.getAttribute('aria-label') || b.textContent || '').trim()).slice(0, 20),
            disabled: !!b.disabled,
          });
        }
        return JSON.stringify({ overlay: !!findOverlay(), areas: areas, buttons: btns });
      } catch (e) {
        return 'unreadable';
      }
    };
    window.__glazeSend = async (text) => {
      // 0) A modal overlay (persona picker, disclaimer, promo popup…) can sit
      //    over the composer and swallow the interaction; clear it before we
      //    touch the input. Mirrors JAR's dismissModals() call in sendMessage.
      await dismissModals();
      const el = findInput();
      if (!el) return { ok: false, reason: 'no-input' };
      // 1) Abort any leftover generation from a previous send — it may still be
      //    streaming / hanging against the unreachable dummy proxy, which keeps
      //    the composer disabled so the next message can't go out. We already
      //    captured the generateAlpha payload (it fires BEFORE the proxy POST),
      //    so aborting the dead-proxy call is safe.
      const abortDeadline = Date.now() + 15000;
      while (Date.now() < abortDeadline) {
        const stop = findStopButton();
        if (!stop) break;
        stop.click();
        await new Promise((r) => setTimeout(r, 300));
      }
      // 2) Type the message into the now-idle composer. Tag it so the
      //    "did it actually send?" check below reads THIS box and not whichever
      //    hidden textarea (character notes, drawers) comes first in the DOM.
      const stale = document.querySelectorAll('[data-glaze-composer]');
      for (let i = 0; i < stale.length; i++) {
        stale[i].removeAttribute('data-glaze-composer');
      }
      el.setAttribute('data-glaze-composer', '1');
      el.focus();
      setReactValue(el, text);
      // 3) Poll for the enabled send button (it enables a few frames after React
      //    ingests the value) and click it. A new overlay may have slipped in
      //    between the dismiss above and now (JanitorAI pops the persona picker
      //    on the first send of a fresh chat), so clear it once more first.
      await dismissModals();
      let btn = null;
      // Generous: on a slow phone React can take many seconds to enable the
      // button after it ingests the value, and giving up early loses the run.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        btn = findSendButton(el);
        if (btn) break;
      }
      // 4) Send, then VERIFY. The composer clears on a real send, so text still
      //    sitting in it means the send was swallowed — a modal that reopened, a
      //    disabled composer, or a click React never saw. Without this check a
      //    swallowed send is indistinguishable from a model that never answered:
      //    the Dart side just waits out its whole timeout.
      let how;
      if (btn) { btn.click(); how = 'click'; } else { pressEnter(el); how = 'enter'; }
      let cleared = await waitComposerCleared(3000);
      if (!cleared && btn) {
        // The click didn't take. Some layouts only send on Enter; and a fresh
        // overlay may have eaten the click, so clear it and try the key path.
        await dismissModals(2000);
        pressEnter(el);
        how += '+enter';
        cleared = await waitComposerCleared(3000);
      }
      return { ok: true, sent: how, cleared: cleared, diag: cleared ? '' : describeComposer() };
    };
    // Whether the chat composer has hydrated (React mounted a visible input).
    // The Dart side POLLS this instead of sleeping a fixed interval: how long
    // hydration takes depends on the device and the network, so any constant is
    // either too short on a slow phone or wasted time on a fast one.
    window.__glazeComposerReady = () => !!findInput();
  })();
