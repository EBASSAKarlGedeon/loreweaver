# Sync Device Onboarding Guide

How to connect a new device to the Loreweaver sync hub.

The hub is a Loreweaver instance with `sync.role: hub` (currently on
`thinkpad-srv`, Debian 13, over Tailscale). Every other device — Windows PC,
Linux desktop, Android phone — is a **client** that pushes/pulls to the hub.
This covers the Android phone via Termux; Windows/Linux only differ in
install (step 2) and paths.

## Prerequisites

- All devices in the same **Tailscale** tailnet (install Tailscale and sign in).
- The hub is running and reachable from the new device (test below).
- You know the hub's data root (where its `data/` folder lives) — see
  step 1. The CLI must be pointed at it explicitly unless it matches the
  default (`./data` next to `config.yaml` in the directory the server runs from).

## 1. Create the device token (on the hub)

```bash
cd /path/to/loreweaver
node sync-token.js create <deviceName> --dataRoot /path/to/hub/data
```

- `<deviceName>`: human label, e.g. `s21-ultra`, `thinkpad`, `workstation`.
- `--dataRoot` is only needed when the CLI's default resolution does not
  match the running server's data root. If in doubt, check how the server
  is launched (`ps aux | grep node`, `systemctl cat <service>`) or
  `find / -name hub.json 2>/dev/null`.
- The token is printed **once**; only its SHA-256 hash is stored. Copy it now.
- No server restart needed: the hub re-reads `hub.json` when it changes
  (the CLI writes it directly).
- Verify afterwards with:

```bash
node sync-token.js list --dataRoot /path/to/hub/data
```

`last seen` stays `never` until the device's first successful sync.

## 2. Install on the device

### Android (Termux)

1. Install **Termux** from F-Droid (NOT the Play Store version — it is
   abandoned and breaks modern Node): https://f-droid.org/en/packages/com.termux/
2. Install **Tailscale** from the Play Store and sign in to the tailnet.
3. In Termux:

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git
git clone https://github.com/EBASSAKarlGedeon/loreweaver.git ~/loreweaver
cd ~/loreweaver
npm install
```

(If the repo is private, git will prompt for credentials — a fine-grained
personal access token works.)

### Windows / Linux

Install Node >= 20, Tailscale, clone the repo, `npm install`. Nothing else.

## 3. Configure `config.yaml` on the device

Copy `default/config.yaml` to the repo root (`cp default/config.yaml config.yaml`)
and set the sync block:

```yaml
sync:
  enabled: true
  role: client
  hubUrl: 'http://thinkpad-srv:8000'   # hub's Tailscale address
  token: '<the token from step 1>'
  deviceName: '<same deviceName as in step 1>'
  intervalSeconds: 60                  # default; 10 minimum
  retentionDays: 30                    # prune sync-trash/ and sync-conflicts/
  handles: ['default-user']
```

Everything else in the file can stay at defaults. API keys (`secrets.json`)
are never synced — set them per device.

## 4. Start and verify

```bash
node server.js
```

Open `http://localhost:8000` in a browser, log in, and check the sync status
block in the settings: it should show a recent run with no errors. The first
sync pulls everything (chats, characters, lorebooks, settings) from the hub.

Sanity checks:

```bash
# Network path works (any HTTP reply is fine; "missing token" is expected):
curl -i http://thinkpad-srv:8000/api/sync/hello

# Device registered on the hub:
node sync-token.js list --dataRoot /path/to/hub/data
```

Status JSON for debugging, while logged in on the device:
`http://localhost:8000/api/sync-status` — `lastRun.errors` holds the real
message when the status block only shows a count.

### Android notes

- Termux kills background sessions: tap **Acquire wakelock** in the Termux
  notification, or sync only while the session is open. The engine also
  syncs on app foreground.
- Termux services (`pkg install termux-services`) can run the server as a
  supervised background service if wanted.

## 5. First acceptance checks (SYNC-SPEC section 12)

1. Edit a character on the new device -> it reaches the hub and other
   devices after their next sync.
2. Continue the same chat on two devices (one after the other) -> no
   conflict, full history everywhere.
3. Delete a lorebook on one device -> gone on the others, and the file is
   in `sync-trash/` on both (pruned after `retentionDays`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `hello failed: invalid token` | Token pasted incompletely, wrong data root (CLI and server read different `hub.json` files), or hub not restarted/pulled on the hot-reload fix (>= `634e80200`). Recreate the token with the correct `--dataRoot`. |
| `No devices registered.` from `sync-token.js list` | Normal before the first successful sync, **or** you are looking at the wrong data root — pass `--dataRoot`. |
| `offline: true` in status | Hub unreachable: Tailscale down, wrong `hubUrl`, hub not running. |
| `changes failed: ...` / file errors | Hub reachable but transfer failed; paste `lastRun.errors` from `/api/sync-status`. |
| Errors only appear as a count | The message is in `http://localhost:8000/api/sync-status` under `lastRun.errors`. |

## Revision history

- 2026-11-09: Written after successful S21 Ultra (Termux) onboarding.
  Hub-side token hot-reload fix referenced: `634e80200`.
