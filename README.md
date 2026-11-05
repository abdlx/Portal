# Portal

**Your agents live in hob. Portal is the doorway they step through.**

Portal turns a spare Linux laptop into an agent computer: one computer, one isolated stealth-browser profile per bot, each bot with its own token. It speaks the same MCP + REST surface as Agent Computer (`computer_list`, `browser_*`, `fs_*`, `terminal_exec`, `batch`, `profile_*`), so any agent host that already talks to Agent Computer — hob included — connects with a URL + token and drives the laptop's browser. The browser is Camoufox, a patched Firefox built to avoid bot detection, driven through Playwright (Firefox's Juggler protocol — Mozilla removed CDP from Firefox in version 141, so there is no CDP endpoint here). Every bot's cookies, logins, and files stay in its own folder on the laptop, and each bot gets one pinned fingerprint identity, drawn once and replayed on every launch.

## Features at a glance

- **26 MCP tools** for computer lifecycle, browser navigation and tabs, snapshots, screenshots, file operations, sandboxed shell access, and batched actions.
- **Per-bot persistent Camoufox profiles** with stored logins, pinned browser fingerprints, private workspaces, and per-bot bearer tokens.
- **Live browser view and interactive human control** using one local TigerVNC display per headed bot and a noVNC web viewer. Agent browser tools and human mouse/keyboard input operate on the same browser.
- **Agent Computer-compatible endpoint** for MCP plus REST lifecycle calls, so HOB or any compatible agent host can connect without a separate computer VM.
- **Owner control panel** for bot creation, credential rotation/reveal, browser installation and repair, and audit history.

**Takeover limitation:** VNC permits a human to interact with the browser, but Portal does not currently implement a human-exclusive control lease. Agent actions are not automatically paused while a human is using the viewer. When an already-running headless profile is opened in live view, Portal closes and relaunches it headed; persisted cookies and profile data survive, but in-page transient state may not.

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
- **27 tools**: `computer_list/status/wake/sleep`, `profile_list`, `profile_current`, `browser_start/navigate/tab_new/tab_list/tab_switch/tab_close/snapshot/screenshot/click/fill/press/content/credential_fill/close`, `fs_list/read/write/mkdir/delete`, `terminal_exec`, `batch` (1–50 steps, stops on first error unless `stopOnError: false`, no nested batch, no admin tools inside).
- **Isolation & Sandbox Hardening**: each bot gets an isolated workspace, `~/.portal/profiles/<slug>/workspace/` (created automatically with the bot, `downloads/` inside). File tools cannot escape the workspace (symlinks resolved). The shell (`terminal_exec`) runs inside a hardened bubblewrap container sandbox:
  1. **PID Namespace Isolation (`--unshare-pid`)**: unshares the process table so agents cannot view host processes (`/proc` leak prevented; `ps aux` only reveals the sandbox root).
  2. **Network Isolation & Host Loopback/LAN Leak Prevention**: blocks traffic to host loopback (`127.0.0.0/8`, `::1`) and private RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), allowing outbound public WAN on ports 80 (HTTP), 443 (HTTPS), and 53 (DNS) only. Host internal services (such as unauthenticated code-server on port 8080 or LAN gateways) are completely inaccessible.
  3. **Intelligent OS Headroom & OOM Priority**: dynamically reserves 1.25GB RAM and 1 CPU core for the host OS/desktop (no rigid static quotas; bots dynamically utilize all remaining capacity). Configures `oom_score_adj` (+500) and `nice` (+10) so agent tasks take OOM priority over host services under pressure and yield CPU scheduling to the host desktop.
  4. **Filesystem Confinement**: root is mounted read-only (`ro`), real home is masked behind an empty tmpfs, and `/tmp` is a private tmpfs with the workspace bound at `/tmp/workspace`.
- **Browser & Automated 2-Hour Idle Tab Cleanup**: Camoufox via `Camoufox()` with persistent contexts, pinned fingerprints, and automated tab lifecycle management. Portal continuously tracks `lastActivityTimestamp` and an `isProcessing` state (checking active automation, network transfers, WebSocket streams, and downloads) per tab. Any unattended tab idle >= 2 hours with no active processing is automatically closed to preserve host memory headroom.
- **Tabs**: always enabled, never disabled. Every profile's browser can hold many tabs: `browser_tab_new/list/switch/close`, `browser_navigate` with `newTab: true`, and a `tab` argument on navigate/snapshot/screenshot/click/fill/press/content/credential_fill. Snapshot refs belong to the tab that was snapshotted.
- **Live view and interactive human control**: a noVNC (RFB) viewer on the same endpoint and bindings Agent Computer uses — `GET /api/computers/portal/vnc`, WebSocket upgrade, `Authorization: Bearer <token>` or `?token=`, `binary` subprotocol, raw RFB bytes to the profile's own TigerVNC X server. A profile-bound token always shows its own browser; the owner token selects via `?profile=`. Connecting starts (or promotes) that bot's browser headed inside its Xvnc display (1280×800); MCP tools keep working on the headed page. Viewer page: `/ui/view?profile=<slug>&token=<token>` (also a "View live" button per bot in the panel). Requires the `tigervnc-standalone-server` system package (`Xvnc`); without it the viewer fails cleanly with a 502 and MCP browsing is unaffected.
- **Control panel** (`/ui/`): owner-only. Status, Camoufox install/repair, bot + token management, recent activity from the audit log.

## What it does NOT do

- No wake-on-call or exclusive human-takeover leases/arbitration. The viewer is view-only by default. Owner takeover blocks new agent browser tools and forwards owner input until handover. Already-running actions are not preempted.
- No CAPTCHA solving. Camoufox aims to prevent challenges, not solve them.
- No proxy rotation — the home IP is the point.
- No token expiry (same as Agent Computer): revocation + rate limit are the controls. Rotate tokens from the panel when one leaks.

## Native per-bot credential vault

Portal includes a built-in encrypted credential vault. **There is no Vaultwarden server, Docker container, Bitwarden CLI, or external account to install.**

1. Open Portal's owner dashboard at `/ui/`; select **Credentials** in the navigation.
2. Choose a bot, enter a label, **HTTPS website URL**, username/email, and password, then click **Add credential**. Each bot has its own credential list and cannot request other bots' credential IDs.
3. The owner panel displays the name, exact allowed origin, username, and ID, but **never the stored password**.
4. The agent calls `browser_credential_fill` with `item_id` (the UUID from the panel). Portal confirms the browser is on the exact HTTPS origin, retrieves the secret inside its trusted server, and fills the page's login fields. No secret is returned by the MCP call.
5. Delete credentials from the same panel when they're no longer needed.

**Encryption:** Each profile gets a key derived using HKDF-SHA256 from a 32-byte Portal master key. Entries are encrypted with AES-256-GCM and authenticated with the stable profile ID. Files live under `~/.portal/credential-vault/` (one `prof_*.enc` file per bot); the **master key** is `~/.portal/credential-master.key` (0600). Back up the key **and** encrypted files together; losing the key permanently loses access to all saved passwords. Never place the key in HOB prompts, repositories, backups readable by agents, or agent workspaces.

**Network safety:** Adding a credential is restricted to local connections or TLS-secured connections. If Portal sits behind a reverse proxy, use a trusted HTTPS endpoint; the app normally sees its connection from the local proxy. Do not expose the owner API directly to the public internet. In particular, a bare `http://192.168.0.4:9879` browser connection is not suitable for submitting passwords.

**Important limitation:** Passwords are **not exposed in Portal MCP responses**, but filling a password into a browser is **not absolute secrecy**. Page JavaScript or an agent with sufficiently powerful browser/shell access can extract or exfiltrate the filled value. Do not use this alone for high-value production accounts; prefer OAuth or scoped tokens and independently review the isolation model before adding real credentials.

## Live VNC takeover

The live viewer defaults to **agent-only control**: mouse and keyboard events from the viewer are ignored. An **owner-authenticated** view shows the **Take over** button, which grants the owner exclusive interactive input and blocks new bot browser-tool calls for that profile. **Hand over to agent** releases the lease. A viewer opened with a bot token stays view-only until the human enters the Portal owner token into the Take over prompt. The bot token alone never grants control. Portal filters keyboard, mouse and clipboard RFB messages server-side; hiding the button alone is not the security boundary.

The takeover is enforced for new MCP browser calls, not already-running operations or arbitrary external automation processes. Refreshing the browser session or restarting Portal resets the in-memory lease. When using the viewer embedded in HOB, the human must authenticate with Portal's owner token to take over; the bot token alone cannot invoke takeover.

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

## Repository topics

Suggested GitHub topics: `ai-agents`, `agent-computer`, `mcp`, `browser-automation`, `camoufox`, `novnc`, `vnc`, `self-hosted`, `multi-agent`, `hermes-agent`.

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
