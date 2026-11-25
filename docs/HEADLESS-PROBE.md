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

## Probe 2 — the site trials (run 2026-11-25, with the user's go-ahead)

10 sessions, a brand-new profile each, variants alternating so neither always ran
on a warmer machine: 5 trials with today's headful launch (A) and 5 with
`--headless=new` + the override above (B). Per trial: one navigation to
`https://janitorai.com/` and one in-page `fetch()` of the same URL. **2,782 HTTP
requests in total**, all of them what one page load of that site costs (288 per
trial; the estimate of 20-30 before the run counted only the navigations and was
wrong by two orders of magnitude).

| | A (headful) | B (headless) |
|---|---|---|
| reached the real page | 5/5 | 5/5 |
| navigation status | 200 every trial | 200 every trial |
| `cf-mitigated` | absent | absent |
| challenge markers (`_cf_chl_opt`, `#challenge-form`, Turnstile, title) | none | none |
| `cf_clearance` cookie | 4/5 | 5/5 |
| in-page `fetch()` | 200, no challenge | 200, no challenge |
| time to a loaded page | 2.8-5.0 s | 4.0-5.3 s |

Verdict: **PASS** — headless was never challenged where headful passed, and the
in-page fetch (the request the vault actually makes) came back 200 with the real
page every time. The run stops early if a headless trial is challenged while a
headful one passed, so a failure cannot quietly burn requests.

Two honest caveats:

- **Cloudflare never actually challenged us.** Both variants got the real page on
  the first response, so this proves "headless does not *trigger* a challenge", not
  "headless can clear an interactive one". If a challenge ever does appear, there
  is no visible window to solve it in — that is the risk any headless default has
  to design around (fall back to a headful launch, parked and revealed only then).
- Trial 3 of A reported no `cf_clearance` cookie (190 requests instead of 288)
  while still loading the real page; the cookie is read right after the fetch and
  may simply not have been written yet. Harmless here, but a cookie check that
  runs once is not a reliable signal.

## Running it


```
node scripts/probe-headless.mjs                 # A vs B, B mirrors A; exit 1 on any diff
node scripts/probe-headless.mjs --reduced       # B claims only Chrome/<major>.0.0.0
node scripts/probe-headless.mjs --json          # machine-readable report
node scripts/probe-headless.mjs --keep          # leave the two temp profiles
```

Two HTTP requests per run, both to `127.0.0.1`; no other traffic.

The site probe is a separate script and *does* talk to janitorai.com — run it only
with a go-ahead, and expect one full page load per trial (288 requests):

```
node scripts/probe-site.mjs                 # 5 trials per variant, alternating, early stop on failure
node scripts/probe-site.mjs --trials=3      # fewer sessions
node scripts/probe-site.mjs --site=http://127.0.0.1:8000/csrf-token   # offline self-test of the plumbing
```

## Probe 3 (2026-11-25): headless on the real profile, blocked, then cleared

The first two probes compared a headless browser against a headful one. This one
ran the **production backend** headless on the vault's signed-in janitor profile
(`data/_vault-janitor-profile`), one page load plus one same-origin fetch per run,
and it failed before it passed — which is the part worth keeping.

**Run 1 — blocked.** Identity present and correct (`Chrome/158.0.0.0`, three
brands, 1536x864, dpr 1.25, no `Headless` anywhere in the page), and the site
answered with its firewall page: **status 200**, title `Access Restricted`, 710 KB,
signed out, no `cf-mitigated`, no `_cf_chl_opt`. So the DOM fingerprint was not the
tell, and the block was not a challenge either.

**What the request said.** `scripts/probe-request-headers.mjs` points the backend at
a local server that prints the raw headers it receives, so it costs the site
nothing. The document request in headless mode carried
`...HeadlessChrome/158.0.0.0...`; the very next fetch from that same page carried
`...Chrome/158.0.0.0...`. Every other header — `Sec-CH-UA`, `Sec-CH-UA-Platform`,
`Sec-Fetch-*`, `Accept-Language`, encodings — was already identical to headful. The
identity was being applied over CDP *after* the navigation that gets judged.

**Run 2 — cleared.** With `--user-agent=<measured UA>` on the headless command
line (`ChromeBackend.launchArgs()`), the same profile, same identity, same machine:

| | run 1 | run 2 |
| --- | --- | --- |
| start | 7020 ms | 6511 ms |
| in-page fetch | 200 · 710762 B | 200 · 709648 B |
| title | `Access Restricted` | `JanitorAI - Build, share, and explore` |
| signed in | no | yes |
| documented UA | `HeadlessChrome/158.0.0.0` | `Chrome/158.0.0.0` |
| OS windows for the profile | 0 | 0 |

The 710 KB in both rows is the same size for the block page and for the app shell,
which is why the body, not the status or the length, has to be what a caller looks
at: `needsHuman()` matches the block page by title/body, and `waitForPage()`
(`readyExpression()`) refuses to call it the site or to mark the profile as having
solved a challenge.

Reproduce the local half any time; the site half needs a go-ahead and one page load:

```
node scripts/probe-browser-fingerprint.mjs   # page-side diff, headful vs headless
node scripts/probe-request-headers.mjs       # wire-side diff, against a local server
node scripts/smoke-headless-backend.mjs      # production backend, local origin, --headful for the other mode
node scripts/probe-headless-site.mjs         # ONE real page load on the vault profile
```

## Probe 4 (2026-11-25): the escalation round trip, on a local origin

The promise is "a window only when a human is needed", so the hand-off itself has
to work: headless browser closed, plain window opened on the same profile, window
closed by the human, headless session back. `scripts/probe-escalation.mjs` runs that
against the local dev server (no site traffic; the window shows Loreweaver, not
JanitorAI, which is fine for the mechanics):

| | before the hand-off | after it |
| --- | --- | --- |
| chrome processes on the profile | 8 | 9 |
| **windows** | **0** | **0** |
| page | Loreweaver, fetch 200 | Loreweaver, fetch 200 |
| `reveal()` | — | `{revealed: 1, escalated: true, closed: true, running: true}` |

Headless start 5.3 s; the human took 218 s to close the window, and the timeout
path (close it ourselves after the budget) was not needed. The one window in this
trace is the one the user is *supposed* to see; everything else stayed invisible.

## Probe 5 (2026-11-25): the vault's own authenticated read, headless

The home page answering 200 says the fingerprint passes the firewall. It says
nothing about the vault's actual read path, which is a Supabase bearer token in an
`Authorization` header. `scripts/probe-headless-account.mjs` runs the production
path (`getJanitorBrowser()` -> `readJanitorAccount()` -> `GET /hampter/profiles/mine`)
on the real profile, headless, once:

| | result |
| --- | --- |
| identity | reused from the cache (`Chrome 158`) |
| start | 7570 ms |
| account read | **200**, `signedIn: true`, name `Hiro`, no challenge |
| account read time | 1419 ms |
| page | `JanitorAI - Build, share, and explore`, no `Headless` in the UA |
| OS windows | **0** of 9 processes |

So the token read, the bearer header, the JSON parse and the session check all
survive headless — the mode does not just load the front page, it serves the app.
