# Headless by default — design proposal (embedded-engine Step 3)

Status: **implemented 2026-11-25 behind `VAULT_BROWSER_HEADLESS` (default off), and
now verified on the site.** Evidence: `docs/HEADLESS-PROBE.md` (probes 1-2:
fingerprint parity; probe 3: headless on the vault's own profile, blocked at first,
cleared once the user agent was moved onto the command line). Flipping the default
is a one-line change and is waiting on the user, not on evidence.

Where the code is: `src/endpoints/weavers-vault-headless-identity.js` (the identity:
measure, cache, apply, refuse) and `src/endpoints/weavers-vault-chrome-backend.js`
(`launchArgs()`, `ensureIdentity()`, `measureIdentity()`, `applyHeadlessIdentity()`,
`finishHeadlessStart()`, `escalateToSignIn()`). Tests: `tests/vault/vault-headless-identity.test.js`
and the `headless mode` block in `tests/vault/vault-browser-backend.test.js`.

## The point

If the vault's browser runs headless, there is no window to flash, no taskbar
button, no Alt-Tab entry — the window-hygiene work (PITFALLS #35, #37, #40, #41)
becomes unnecessary instead of being tuned. The one thing a human must do — sign
in — needs a real window, so the design keeps a headful escape hatch for exactly
that.

## Shape

**1. `ChromeBackend` gets `headless` as its default mode.** Same flags as today
minus `--window-position/-size/-hide-crash-restore-bubble` plus `--headless=new`;
the debugging port, throttling flags and profile handling stay identical. The
taskbar watcher, `park()`, `hideWindow()` and `placeWindowOnScreen()` are not used
in this mode (there is no window), but stay in the file for the headful mode.

**2. A fingerprint identity, built once per session after attach.**
`Emulation.setDeviceMetricsOverride` (real screen, DPR and inner size of the
primary display), `Emulation.setUserAgentOverride` (UA string copied from what a
headful launch of the same binary reports, brands + GREASE entry, platformVersion,
architecture `x86`, bitness `64`), then `Browser.setWindowBounds` with the real
outer size. Screen size, DPR and the Windows platform version are read from the OS
through one PowerShell call per session (cached), because they must match the
machine the vault runs on — a fixed 1536x864 would be a new tell on any other
monitor.

**3. Everything is re-applied on `adoptExisting()` too**, not just on a fresh
launch: the override lives in the page's renderer, and a page we attach to from a
previous session has none.

**3a. Where the identity comes from — amended after the live test.** Not from the
headless page (it says `HeadlessChrome` and gets a 403 block, and on `about:blank`
it reports no brands at all), and not from one PowerShell call that guesses the
screen either. It comes from **a real headful Chrome on this machine**, launched
once for the purpose on a throwaway profile, parked and taskbar-hidden, on a local
`file://` page: a file document is a secure context, so `getHighEntropyValues()`
answers in full (`brands`, `platformVersion`, architecture, bitness) and the real
screen/DPR come with it — and the launch costs **no network at all**. The result is
cached in `headless-identity.json` beside the profile, keyed by Chrome major version
and valid for 7 days; a Chrome update or a monitor swap re-measures. If no usable
identity can be measured, the vault **refuses to start headless** instead of
guessing (a wrong fingerprint is a different failure, not a safer one).

**3b. The second escalation trigger is a firewall block, not just a challenge.**
Measured 2026-11-25: a self-describing headless browser earns `403 Access Restricted`
from the site, which is a block page — no `cf-mitigated`, no `_cf_chl_opt`, nothing to
click. That answer must escalate to the human window exactly like a challenge does;
retrying it headless can only fail the same way.

**4. The sign-in escape hatch.** `reveal()` in headless mode cannot show a window,
so it escalates:

1. dispose the headless browser (cookies stay in the profile directory),
2. launch the same binary **plain** — no automation flags, no debugging port,
   normal window — on the same profile,
3. wait until that window is closed by the human (or a bounded timeout),
4. relaunch headless, re-apply the identity, confirm with **one** fetch to the
   site,
5. resume the original request.

Escalation is also triggered automatically when a fetch answer looks like a
challenge (`cf-mitigated` header, or `_cf_chl_opt` in the body), so a challenge
that appears later still reaches a human rather than failing silently.

**5. A one-variable escape hatch.** `VAULT_BROWSER_HEADLESS=0` restores today's
headful behaviour without a code change. As built it is **default off**
(`VAULT_BROWSER_HEADLESS=1` turns it on) until one site run says the vault profile
is happy headless; an explicit `0` always wins over an option a config file passes
down, so the switch can always be taken out of a shell profile.

## What the local smoke test measured (2026-11-25)

`node scripts/smoke-headless-backend.mjs` runs the production backend on a
throwaway profile against the local dev server, so it costs the site nothing:

| | result |
| --- | --- |
| first start (measuring launch + headless launch) | 12.3 s |
| UA | `Chrome/158.0.0.0`, no `Headless` anywhere |
| brands | `Chromium/158`, `Not.A/Brand/24`, `Google Chrome/158` |
| screen / DPR / platform | 1536x864, 1.25, `Windows` |
| viewport / outer | 1284x795 / 1285x883 (`outer > inner`, the headless tell fixed) |
| OS windows for the profile | **0** of 8 processes |
| identity cache | written, `major: 158` |
| local fetch | 200 |

The earlier measuring path (a headful launch on `this.origin`) was replaced because
for the janitor session `origin` is janitorai.com: it would have loaded the site
once every 7 days for no reason. The `file://` probe removed that traffic entirely.

## Verified on the site (2026-11-25)

One page load + one same-origin fetch on `data/_vault-janitor-profile`, headless:
title `JanitorAI - Build, share, and explore`, signed in, in-page fetch 200, start
6.5 s, 0 OS windows for the profile's 8 processes. The run before it had been
blocked (status 200, `Access Restricted`): the identity was applied over CDP after
the first navigation, which is the request the firewall judges. `--user-agent=` on
the headless launch fixed it; the whole story is PITFALLS #42 and #43.

## Risks, in order of how likely they are to bite

1. **An interactive challenge in headless has no window.** Probe 2 never met one
   (both variants got 200 straight away), so the escalation path is unproven and
   must be tested live before it is trusted: the plain relaunch, the "wait for the
   human", and the return to headless.
2. **The identity is machine-derived.** If the OS query fails on some setup, the
   override silently falls back to defaults — which are a fingerprint mismatch.
   The fallback must be "keep today's headful mode", not "guess".
3. **`screen.availHeight` cannot be made to match** (headless has no taskbar).
   Measured residual: 816 vs 864. Accepted for now; reason to revisit if the site
   ever challenges.
4. **Nothing is on screen, so failures are invisible.** Errors that today the user
   sees as a window must be logged (and surfaced in the vault UI) — the current
   logs already do, but there is no visual backstop anymore.
5. **A human can no longer take over mid-flow.** Today `reveal()` shows the live
   session; with headless the session is replaced by a new one, so in-flight page
   state is lost. The vault's flows re-navigate anyway, but it is a behaviour
   change worth stating.
6. **Cloudflare can change its mind.** The env flag is the mitigation; the probe
   scripts are the way to re-test.

## Test the live sign-in path (the one thing that needs a human)

1. Start a vault request with headless on a fresh profile (it will be challenged
   or not — either way), then call the escalation and watch it:
   the headless browser must exit, a plain Chrome window must appear on the
   profile, and nothing else must be on screen.
2. Sign in, close the window. The probe must relaunch headless and the confirming
   fetch must return 200.
3. Then one ordinary vault request end to end, and the taskbar/Alt-Tab check: it
   must be impossible to see any Chrome window at all, with no taskbar button.

Cost: 2-3 requests to janitorai.com, plus the human's sign-in.

## What the live test measured (2026-11-25)

Run with `scripts/probe-signin.mjs` on the vault's own profile
(`data/_vault-janitor-profile`), which is signed in. It measured the identity on a
parked headful launch (no site traffic), then:

| | headless, before the window | headless, after the window closed |
|---|---|---|
| document | 200 `JanitorAI - Build, share, and explore` | 200, same |
| home content | signed-in home ("Create a Character", upgrade banner) | same |
| same-origin `fetch()` | 200, 709 KB, no `cf-mitigated`, 515 ms | same |
| `cf_clearance` | present | present |
| brands / dpr / screen | `Chromium/158, Not.A/Brand/24, Google Chrome/158` / 1.25 / 1536x864 | same |

The plain window opened on the profile, was closed normally (`closed (0)`), and
headless came back on the same cookies: **the escalation shape works**.

### Three things the live test taught, which the code must respect

1. **A headless browser must never describe itself.** Launching headless and
   copying *its* `navigator.userAgent` / `Browser.getVersion` gives a UA that says
   `HeadlessChrome`, and the site answers that with **403 "Access Restricted /
   blocked by our firewall"** — a block page, not a challenge, so no amount of
   challenge handling would recover. The identity has to come from the machine
   (binary version + OS), never from the headless page.
2. **`navigator.userAgentData` is empty on `about:blank`.** Reading the reference
   there produced an override with `brands: []`, which no real Chrome reports. The
   reference must be captured on a real document (a local page is enough).
3. **`window.outerWidth/outerHeight` stay 800x600 in headless** even after
   `Browser.setWindowBounds` to 1281x883, so `outer < inner` (1280x795) — an
   impossible reading for a real browser window. Not observed to matter yet (the
   site answered 200 with it), but it is the next fingerprint item to fix;
   `Emulation.setDeviceMetricsOverride` takes a `dontSetVisibleSize` flag that may
   let the real window size stand while only screen size and DPR are overridden.

### Rule for probes from now on

Never write cookie values to a log or a report. A signed-in profile's cookie
header is a live account session (access token + refresh token), and these probe
logs are plain text in `%TEMP%`. Log cookie **names** and counts only.
