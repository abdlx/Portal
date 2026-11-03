# Portal

**Your agents live in hob. Portal is the doorway they step through.**

Portal turns a spare Linux laptop into an agent computer: one computer, one isolated stealth-browser profile per bot, each bot with its own token. It speaks the same MCP + REST surface as Agent Computer (`computer_list`, `browser_*`, `fs_*`, `terminal_exec`, `batch`, `profile_*`), so any agent host that already talks to Agent Computer — hob included — connects with a URL + token and drives the laptop's browser. The browser is CloakBrowser, a patched Chromium built to avoid bot detection, and every bot's cookies, logins, and files stay in its own folder on the laptop.

## Install — one line

Run this on the laptop:

```sh
curl -fsSL https://raw.githubusercontent.com/abdlx/Portal/main/install.sh | bash
```

What it does: clones Portal into `~/portal` (or reuses the checkout if you run it from one), installs npm dependencies, downloads the CloakBrowser binary (~200 MB, once), writes a systemd user service, and creates a **Portal** desktop app that opens the control panel. It never installs system packages and never exposes the server to the public internet: it binds the Tailscale IP when Tailscale is present, otherwise localhost only.

Requirements: Linux (Debian/Ubuntu, Fedora, or Arch), Node.js 20+, git, and Tailscale on the same tailnet as the machine your agents run on (so they can reach the laptop).

Manual install:

```sh
git clone https://github.com/abdlx/Portal.git
cd Portal
bash install.sh
```

If `./install.sh` says "permission denied", run `bash install.sh` — file modes don't survive every download path.

## After install

1. **License key.** CloakBrowser's wrapper is MIT, but the stealth binary needs a key from cloakbrowser.dev. In a terminal on the laptop:

   ```sh
   npx cloakbrowser login   # free key by email, or paste a Pro key
   npx cloakbrowser install
   systemctl --user restart portal.service
   ```

   The free key runs the latest binary with **one browser session at a time** — starting one bot's browser closes any other bot's running browser first (profiles persist on disk, so only the live page is lost). A Pro key lifts that limit. Vendor detection claims are unverified; test on a disposable account first.
2. **Open the Portal desktop app** and sign in with the owner token in `~/.portal/owner-token.txt` (0600, laptop only — never paste it into an agent or a chat).
3. **Add a bot** (e.g. `Dex`). The panel creates the bot's profile folder + browser profile and shows its token once — copy it. It can be revealed again any time from the panel, owner only.
4. **Connect the bot.** In that bot's agent-host config, add an MCP server named `agent_computer` with URL `http://<laptop-tailscale-ip>:9879/mcp` and header `Authorization: Bearer <that-bot's-token>`. Then ask the bot to run `computer_list` — it should see one computer, **Portal**. Prove it with one `batch`: navigate + snapshot + content. Repeat after 30 minutes to prove the laptop stays awake.
5. **Keep the laptop awake and plugged in.** There is no wake-on-call. Recommended (printed by the installer, never automatic): mask sleep/suspend, `loginctl enable-linger`, and a firewall rule allowing only `100.64.0.0/10` to port 9879.

Deleting a bot revokes its tokens. Its files on disk are never deleted automatically — remove `~/.portal/profiles/<slug>` by hand if you want them gone.

## What it does

- **MCP server** (`POST /mcp`): `initialize`, `ping`, `tools/list`, `tools/call` — including a bare `tools/call` with no prior `initialize`, which is how hob's bridge calls it. Protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`.
- **REST fallback** (`GET /api/computers`, `GET /api/computers/:id`, `POST /api/computers/:id/wake|sleep`) with the same Bearer auth.
- **21 tools**: `computer_list/status/wake/sleep`, `profile_list`, `profile_current`, `browser_start/navigate/snapshot/click/fill/press/content/close`, `fs_list/read/write/mkdir/delete`, `terminal_exec`, `batch` (1–50 steps, stops on first error unless `stopOnError: false`, no nested batch, no admin tools inside). Desktop/mouse/keyboard/screenshot tools are deliberately not listed — this is a browser computer.
- **Isolation**: each bot's browser profile, files, and shell live under `~/.portal/profiles/<slug>/`. A profile-bound token naming another profile is rejected before any work happens (fail-closed, including inside `batch`). Filesystem paths cannot escape the profile home (symlinks resolved). Rate limit: 600 calls/min per token (429, `-32029`).
- **Browser**: CloakBrowser via the wrapper's `launchPersistentContext` with `humanize: true`, one fixed `--fingerprint` seed per bot, timezone Asia/Karachi, locale en-US. No JavaScript injection, no UA overrides.
- **Control panel** (`/ui/`): owner-only. Status, CloakBrowser install/repair, bot + token management, recent activity from the audit log.

## What it does NOT do

- No VNC / live desktop view.
- No wake-on-call, no leases, no human-takeover arbitration.
- No CAPTCHA solving. CloakBrowser aims to prevent challenges, not solve them.
- No proxy rotation — the home IP is the point.
- No token expiry (same as Agent Computer): revocation + rate limit are the controls. Rotate tokens from the panel when one leaks.

## Security notes

- Bot tokens are `portal_…`, stored hashed for auth. Plaintext copies live only in `~/.portal/vault.json` (0600) so the owner panel can reveal them. Anyone with the vault file owns the bots — back it up like a password file, never share it.
- Binding happens in server code (`PORTAL_HOST` / `PORTAL_PORT` / `PORTAL_HOME`). The firewall rule is what makes "Tailscale-only" true.
- Every MCP tool call is appended to `~/.portal/audit.log` (local only, viewable in the panel).

## Troubleshooting

- `401 unauthorized`: wrong/missing Bearer token, or the token was revoked. Reveal a fresh token in the panel (or rotate).
- Browser tools return "CloakBrowser is not installed": press Install in the panel, or run `npx cloakbrowser install` in the app dir, then restart the service (`systemctl --user restart portal.service`).
- License error: run `npx cloakbrowser login` in a terminal on the laptop, then restart the service.
- A site blocks the laptop browser: route that work to Camoufox via Agent Computer. The laptop is the fast path, not a stealth guarantee.
- `computer_list` shows the wrong computer: check which config file the agent host actually read — a global MCP entry can shadow a per-bot one.
- Logs: `journalctl --user -u portal.service -f`
- Port already in use: set `PORTAL_PORT` and re-run install.
- Manual start (no systemd): `node src/server.mjs` with `PORTAL_HOST` / `PORTAL_PORT` / `PORTAL_HOME` set.

## Tests

`npm test` runs `test/smoke.mjs`: boots the server on a scratch home and checks health, 401s, owner/bot creation, MCP initialize/list/call (including bare `tools/call` without initialize), profile-binding rejection, batch, fs confinement, `terminal_exec`, REST fallback, and the rate limiter. Browser tools are expected to return the clear not-installed error when CloakBrowser is absent.

## Uninstall

```sh
systemctl --user disable --now portal.service
rm ~/.local/share/applications/portal.desktop ~/Desktop/portal.desktop
rm -rf ~/.portal   # deletes ALL bot profiles, tokens, sessions
```

## License

MIT — see [LICENSE](LICENSE).
