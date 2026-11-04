# Portal

**Your agents live in hob. Portal is the doorway they step through.**

Portal turns a spare Linux laptop into an agent computer: one computer, one isolated stealth-browser profile per bot, each bot with its own token. It speaks the same MCP + REST surface as Agent Computer (`computer_list`, `browser_*`, `fs_*`, `terminal_exec`, `batch`, `profile_*`), so any agent host that already talks to Agent Computer — hob included — connects with a URL + token and drives the laptop's browser. The browser is Camoufox, a patched Firefox built to avoid bot detection, driven through Playwright (Firefox's Juggler protocol — Mozilla removed CDP from Firefox in version 141, so there is no CDP endpoint here). Every bot's cookies, logins, and files stay in its own folder on the laptop, and each bot gets one pinned fingerprint identity, drawn once and replayed on every launch.

## Install — one line

Run this on the laptop:

```sh
curl -fsSL https://raw.githubusercontent.com/abdlx/Portal/main/install.sh | bash
```

What it does: clones Portal into `~/portal` (or reuses the checkout if you run it from one), installs npm dependencies, downloads the Camoufox browser build (once), writes a systemd user service, and creates a **Portal** desktop app that opens the control panel. It never exposes the server to the public internet: it binds the Tailscale IP when Tailscale is present, otherwise localhost only. Camoufox also needs three system libraries even headless (`libgtk-3`, `libx11-xcb`, `libasound2`) — the installer tries a passwordless sudo install and otherwise prints the apt command.

Requirements: Linux (Debian/Ubuntu, Fedora, or Arch), Node.js 22.15+, git, and Tailscale on the same tailnet as the machine your agents run on (so they can reach the laptop).

Manual install:

```sh
git clone https://github.com/abdlx/Portal.git
cd Portal
bash install.sh
```

If `./install.sh` says "permission denied", run `bash install.sh` — file modes don't survive every download path.

Updating: `cd ~/portal && git pull && bash install.sh --skip-browser` updates the app without re-checking the browser download. Without the flag the installer still skips the download when the pinned Camoufox version is already installed — the flag only skips the check itself.

## After install

1. **Browser engine.** Camoufox is free software (wrapper MIT, browser MPL-2.0) — no key, no activation, no session limit. If the install step above reported a failure, run `npx camoufox fetch` in the app directory, then `systemctl --user restart portal.service`. If the browser fails to start with a missing `.so` error, install the libraries: `sudo apt-get install -y --no-install-recommends libgtk-3-0t64 libx11-xcb1 libasound2t64`. Vendor detection claims are unverified; test on a disposable account first. Note the engine is Firefox: sites that key on Chromium identity will see Firefox, which is the point of a second engine, not a drop-in replacement for every site.
2. **Open the Portal desktop app** and sign in with the owner token in `~/.portal/owner-token.txt` (0600, laptop only — never paste it into an agent or a chat).
3. **Add a bot** (e.g. `Dex`). The panel creates the bot's profile folder, its isolated browser profile directory, its pinned fingerprint identity, and its workspace folder (`~/.portal/profiles/<slug>/workspace/`, with a `downloads/` inside) immediately — no manual step, no waiting for the first launch. It shows its token once — copy it. It can be revealed again any time from the panel, owner only.
4. **Connect the bot.** In that bot's agent-host config, add an MCP server named `agent_computer` with URL `http://<laptop-tailscale-ip>:9879/mcp` and header `Authorization: Bearer <that-bot's-token>`. Then ask the bot to run `computer_list` — it should see one computer, **Portal**. Prove it with one `batch`: navigate + snapshot + content. Repeat after 30 minutes to prove the laptop stays awake.
5. **Keep the laptop awake and plugged in.** There is no wake-on-call. Recommended (printed by the installer, never automatic): mask sleep/suspend, `loginctl enable-linger`, and a firewall rule allowing only `100.64.0.0/10` to port 9879.

Deleting a bot revokes its tokens. Its files on disk are never deleted automatically — remove `~/.portal/profiles/<slug>` by hand if you want them gone.

## What it does

- **MCP server** (`POST /mcp`): `initialize`, `ping`, `tools/list`, `tools/call` — including a bare `tools/call` with no prior `initialize`, which is how hob's bridge calls it. Protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`.
- **REST fallback** (`GET /api/computers`, `GET /api/computers/:id`, `POST /api/computers/:id/wake|sleep`) with the same Bearer auth.
- **21 tools**: `computer_list/status/wake/sleep`, `profile_list`, `profile_current`, `browser_start/navigate/snapshot/click/fill/press/content/close`, `fs_list/read/write/mkdir/delete`, `terminal_exec`, `batch` (1–50 steps, stops on first error unless `stopOnError: false`, no nested batch, no admin tools inside). Desktop/mouse/keyboard/screenshot tools are deliberately not listed — this is a browser computer.
- **Isolation**: each bot gets a workspace, `~/.portal/profiles/<slug>/workspace/` (created automatically with the bot, `downloads/` inside). File tools cannot escape the workspace (symlinks resolved). The shell (`terminal_exec`) runs inside a bubblewrap sandbox: the whole filesystem is read-only except the workspace, which the shell sees at `/tmp/workspace`; the real home directory is hidden; `/tmp` is fresh. The bot keeps network access and full freedom inside its workspace. A profile-bound token naming another profile is rejected before any work happens (fail-closed, including inside `batch`). Rate limit: 600 calls/min per token (429, `-32029`). Requires the `bubblewrap` system package (the installer installs it and smoke-tests the sandbox); without it the shell refuses to run. Owner override for hosts without user namespaces: `PORTAL_ALLOW_UNSANDBOXED_SHELL=1` — the shell then runs unsandboxed as the Portal user; never set it in production.
- **Browser**: Camoufox via the `camoufox` package's `Camoufox()` (persistent context) with `humanize: true`, one pinned fpgen fingerprint per bot (drawn once, stored under `~/.portal/browser-fingerprints/`, replayed every launch), timezone Asia/Karachi, locale en-US. No JavaScript injection, no UA overrides. No license limit on concurrent browsers — RAM is the limit.
- **Tabs**: always enabled, never disabled. Every profile's browser can hold many tabs: `browser_tab_new/list/switch/close`, `browser_navigate` with `newTab: true`, and a `tab` argument on navigate/snapshot/click/fill/press/content. Snapshot refs belong to the tab that was snapshotted.
- **Live view**: a noVNC (RFB) viewer on the same endpoint and bindings Agent Computer uses — `GET /api/computers/portal/vnc`, WebSocket upgrade, `Authorization: Bearer <token>` or `?token=`, `binary` subprotocol, raw RFB bytes to the profile's own TigerVNC X server. A profile-bound token always shows its own browser; the owner token selects via `?profile=`. Connecting starts (or promotes) that bot's browser headed inside its Xvnc display (1280×800); MCP tools keep working on the headed page. Viewer page: `/ui/view?profile=<slug>&token=<token>` (also a "View live" button per bot in the panel). Requires the `tigervnc-standalone-server` system package (`Xvnc`); without it the viewer fails cleanly with a 502 and MCP browsing is unaffected.
- **Control panel** (`/ui/`): owner-only. Status, Camoufox install/repair, bot + token management, recent activity from the audit log.

## What it does NOT do

- No VNC / live desktop view.
- No wake-on-call, no leases, no human-takeover arbitration.
- No CAPTCHA solving. Camoufox aims to prevent challenges, not solve them.
- No proxy rotation — the home IP is the point.
- No token expiry (same as Agent Computer): revocation + rate limit are the controls. Rotate tokens from the panel when one leaks.

## Security notes

- Bot tokens are `portal_…`, stored hashed for auth. Plaintext copies live only in `~/.portal/vault.json` (0600) so the owner panel can reveal them. Anyone with the vault file owns the bots — back it up like a password file, never share it.
- Shell sandbox: `terminal_exec` is confined with bubblewrap (see Isolation). It is fail-closed: no `bwrap` on PATH means the shell errors instead of running free. The startup log prints a `shell sandbox:` line — check it after install.
- Binding happens in server code (`PORTAL_HOST` / `PORTAL_PORT` / `PORTAL_HOME`). The firewall rule is what makes "Tailscale-only" true.
- Every MCP tool call is appended to `~/.portal/audit.log` (local only, viewable in the panel).

## Troubleshooting

- `terminal_exec` returns the bubblewrap error: install it (`sudo apt-get install -y bubblewrap`), restart, and check the startup log's `shell sandbox:` line. If bwrap is installed but the sandbox still fails on Ubuntu 24.04, AppArmor may restrict unprivileged user namespaces — the installer smoke test prints the sysctl fix.
- `401 unauthorized`: wrong/missing Bearer token, or the token was revoked. Reveal a fresh token in the panel (or rotate).
- Browser tools return "Camoufox is not installed": press Install in the panel, or run `npx camoufox fetch` in the app dir, then restart the service (`systemctl --user restart portal.service`). If the error names a missing `.so` file, install the system libraries (see step 1 above).
- A site blocks the laptop browser: route that work to Agent Computer's Camoufox, or accept the block — the laptop is the fast path, not a stealth guarantee.
- `computer_list` shows the wrong computer: check which config file the agent host actually read — a global MCP entry can shadow a per-bot one.
- Logs: `journalctl --user -u portal.service -f`
- Port already in use: set `PORTAL_PORT` and re-run install.
- Manual start (no systemd): `node src/server.mjs` with `PORTAL_HOST` / `PORTAL_PORT` / `PORTAL_HOME` set.

## Tests

`npm test` runs `test/smoke.mjs`: boots the server on a scratch home and checks health, 401s, owner/bot creation, MCP initialize/list/call (including bare `tools/call` without initialize), profile-binding rejection, batch, fs confinement to the workspace, `terminal_exec` in the workspace, REST fallback, and the rate limiter. Browser tools return the clear not-installed error when Camoufox is absent. The smoke run sets `PORTAL_ALLOW_UNSANDBOXED_SHELL=1` (test hosts have no bubblewrap); the sandbox itself is verified by `npm run test:sandbox` (`test/sandbox.mjs`): a stub-`bwrap` argv probe, a real-`bwrap` probe when installed, and a mount-namespace probe of the confinement layout.

## Uninstall

```sh
systemctl --user disable --now portal.service
rm ~/.local/share/applications/portal.desktop ~/Desktop/portal.desktop
rm -rf ~/.portal   # deletes ALL bot profiles, tokens, sessions
```

## License

MIT — see [LICENSE](LICENSE).
