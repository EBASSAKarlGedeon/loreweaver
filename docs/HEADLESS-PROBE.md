# Headless probe (embedded-engine Step 2, probe 1)

**Question.** Can the vault's browser run as `--headless=new` with a user-agent
override and still look like the headful Chrome it is today — without contacting
janitorai.com to find out?

**Answer (measured 2026-11-25).** On everything this probe can see, yes: the two
variants produced byte-identical request headers, in the same order, for a
navigation and for an in-page `fetch()`, and the page-visible fingerprint matched
field for field except `screen.availHeight`. That is a laboratory result: it says
the headless browser is not *trivially* detectable, not that Cloudflare clears it.

Hardware/versions: Windows 11, Chrome `158.0.8127.37`, display `1536x864 @ 1.25`,
window `1281x883` (inner `1280x795`). Tool: `scripts/probe-headless.mjs`.
**Zero** requests to any site: the page and the report endpoint are a throwaway
HTTP server on `127.0.0.1`.

## Method

For each variant the probe starts Chrome with a fresh profile on a random port,
navigates once to the local page, and the page `fetch()`es back a JSON snapshot of
what it can see. The server records the raw header list of both requests
(`req.rawHeaders`), order included.

- **A — today's production launch**: headful, `--window-position=-32000,-32000`,
  every flag `weavers-vault-chrome-backend.js` passes today.
- **B — the candidate**: the same flags plus `--headless=new`, launched on
  `about:blank`, then
  `Emulation.setUserAgentOverride` (built from A's own answers),
  `Emulation.setDeviceMetricsOverride` (A's screen and inner size),
  `Browser.setWindowBounds` (A's outer size), and only then the navigation.

## Result

Identical between A and B:

- navigation headers: full ordered list, values included;
- the in-page `fetch()` headers: same, `sec-ch-ua*` included;
- `navigator.userAgent`, `appVersion`, `platform`, `vendor`, `language(s)`,
- `navigator.userAgentData` brands/mobile/platform and every high-entropy value
  (`fullVersionList`, `platformVersion`, `architecture`, `bitness`, `wow64`);
- `navigator.webdriver` (`false`), `plugins.length` (5), `mimeTypes.length` (2),
  `pdfViewerEnabled` (`true`), `hardwareConcurrency`, `deviceMemory`,
- `window.chrome` (`csi`, `loadTimes`, `app` — `runtime` false in both, this
  machine's real Chrome included),
- WebGL renderer and vendor, **unmasked** values included (the real GPU:
  `ANGLE (Intel, Intel(R) UHD Graphics ..., D3D11)`, not SwiftShader),
- `screen.width/height`, `devicePixelRatio`, `innerWidth/Height`,
  `outerWidth/Height`, `document.visibilityState`, `hasFocus`, timezone.

The one difference:

| | A (headful) | B (headless) |
|---|---|---|
| `screen.availHeight` | `816` | `864` |

A headful window reports the monitor's *work area* (864 minus a 48 px taskbar); a
headless browser has no taskbar, so `availHeight` equals `screen.height`. CDP has
no knob for it. A real Windows desktop with the taskbar set to auto-hide reports
exactly what B reports, so the value is plausible rather than a headless marker —
but it is not a match.

## What had to be overridden, and what breaks without it

Each of these was found by a failing run of the probe:

1. **UA string.** Headless says `HeadlessChrome/158.0.8127.37`; A says
   `Chrome/158.0.0.0` — desktop Chrome freezes the UA to
   `<major>.0.0.0` (UA reduction). Copying A's string verbatim is the only
   faithful option; "restoring" the full build number into the UA would be a
   mismatch no real Chrome shows.
2. **Client hints.** `userAgentMetadata` must carry A's brands *and* the GREASE
   entry's unrelated version (`Not.A/Brand` = `24.0.0.0` next to Chromium
   `158.0.8127.37`); forcing one version onto every entry is a tell.
3. **`acceptLanguage` in the override reorders headers.** Setting it makes Chrome
   emit `accept-language` between `user-agent` and `accept` instead of last. Left
   out, headless sends the same value *and* the same position as A.
4. **Screen.** Headless defaults to `800x600 @ 1`. `Emulation.setDeviceMetricsOverride`
   with A's screen, inner size and DPR fixes `screen.*`, `innerWidth/Height` and
   `devicePixelRatio` — but it zeroes `outerWidth/Height` (a classic headless
   tell), so the window must be given A's outer size back with
   `Browser.setWindowBounds`. That call must pass an explicit position and
   `windowState: 'normal'`: without them the page flips to
   `visibilityState: "hidden"`, which a challenge would treat as a background tab.

## What this does not cover

- **Cloudflare.** Nothing here proves `cf_clearance` still appears. That is probe 2
  (site trials, alternating A/B, fresh profile per trial) and it needs the user's
  go-ahead, because every trial is a request to janitorai.com.
- TLS/HTTP2 fingerprint: same binary, same stack, so expected identical — not
  measured here.
- Things this probe does not read: fonts, codecs (`canPlayType`), WebRTC,
  `navigator.connection`, permissions/`Notification`, media devices, the
  `screen.availTop/Left` pair, and timing behaviour.

## Running it

```
node scripts/probe-headless.mjs                 # A vs B, B mirrors A; exit 1 on any diff
node scripts/probe-headless.mjs --reduced       # B claims only Chrome/<major>.0.0.0
node scripts/probe-headless.mjs --json          # machine-readable report
node scripts/probe-headless.mjs --keep          # leave the two temp profiles
```

Two HTTP requests per run, both to `127.0.0.1`; no other traffic.
