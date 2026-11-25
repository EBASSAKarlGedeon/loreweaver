# Headless by default — design proposal (embedded-engine Step 3)

Status: **proposal, nothing implemented.** Needs approval before code. Evidence:
`docs/HEADLESS-PROBE.md` (probe 1: fingerprint parity; probe 2: 5/5 clear on the
site, headless and headful alike).

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
headful behaviour without a code change. Default on, but the flag is the first
thing to flip if the site starts challenging headless.

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
