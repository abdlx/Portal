# Portal

**Your agents live in hob. Portal is the doorway they step through.**

Portal turns a spare Linux laptop into an agent computer: one computer, one isolated stealth-browser profile per bot, each bot with its own token. It speaks the same MCP + REST surface as Agent Computer (`computer_list`, `browser_*`, `fs_*`, `terminal_exec`, `batch`, `profile_*`), so any agent host that already talks to Agent Computer — hob included — connects with a URL + token and drives the laptop's browser. The browser is Camoufox, a patched Firefox built to avoid bot detection, driven through Playwright (Firefox's Juggler protocol — Mozilla removed CDP from Firefox in version 141, so there is no CDP endpoint here). Every bot's cookies, logins, and files stay in its own folder on the laptop, and each bot gets one pinned fingerprint identity, drawn once and replayed on every launch.

## Features at a glance

- **25 MCP tools** for computer lifecycle, browser navigation and tabs, snapshots, file operations, sandboxed shell access, and batched actions.
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
- **25 tools**: `computer_list/status/wake/sleep`, `profile_list`, `profile_current`, `browser_start/navigate/tab_new/tab_list/tab_switch/tab_close/snapshot/click/fill/press/content/close`, `fs_list/read/write/mkdir/delete`, `terminal_exec`, `batch` (1–50 steps, stops on first error unless `stopOnError: false`, no nested batch, no admin tools inside). Desktop/mouse/keyboard/screenshot tools are deliberately not listed — this is a browser computer.
- **Isolation & Sandbox Hardening**: each bot gets an isolated workspace, `~/.portal/profiles/<slug>/workspace/` (created automatically with the bot, `downloads/` inside). File tools cannot escape the workspace (symlinks resolved). The shell (`terminal_exec`) runs inside a hardened bubblewrap container sandbox:
  1. **PID Namespace Isolation (`--unshare-pid`)**: unshares the process table so agents cannot view host processes (`/proc` leak prevented; `ps aux` only reveals the sandbox root).
  2. **Network Isolation & Host Loopback/LAN Leak Prevention**: blocks traffic to host loopback (`127.0.0.0/8`, `::1`) and private RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), allowing outbound public WAN on ports 80 (HTTP), 443 (HTTPS), and 53 (DNS) only. Host internal services (such as unauthenticated code-server on port 8080 or LAN gateways) are completely inaccessible.
  3. **Intelligent OS Headroom & OOM Priority**: dynamically reserves 1.25GB RAM and 1 CPU core for the host OS/desktop (no rigid static quotas; bots dynamically utilize all remaining capacity). Configures `oom_score_adj` (+500) and `nice` (+10) so agent tasks take OOM priority over host services under pressure and yield CPU scheduling to the host desktop.
  4. **Filesystem Confinement**: root is mounted read-only (`ro`), real home is masked behind an empty tmpfs, and `/tmp` is a private tmpfs with the workspace bound at `/tmp/workspace`.
- **Browser & Automated 2-Hour Idle Tab Cleanup**: Camoufox via `Camoufox()` with persistent contexts, pinned fingerprints, and automated tab lifecycle management. Portal continuously tracks `lastActivityTimestamp` and an `isProcessing` state (checking active automation, network transfers, WebSocket streams, and downloads) per tab. Any unattended tab idle >= 2 hours with no active processing is automatically closed to preserve host memory headroom.
- **Tabs**: always enabled, never disabled. Every profile's browser can hold many tabs: `browser_tab_new/list/switch/close`, `browser_navigate` with `newTab: true`, and a `tab` argument on navigate/snapshot/click/fill/press/content. Snapshot refs belong to the tab that was snapshotted.
- **Live view and interactive human control**: a noVNC (RFB) viewer on the same endpoint and bindings Agent Computer uses — `GET /api/computers/portal/vnc`, WebSocket upgrade, `Authorization: Bearer <token>` or `?token=`, `binary` subprotocol, raw RFB bytes to the profile's own TigerVNC X server. A profile-bound token always shows its own browser; the owner token selects via `?profile=`. Connecting starts (or promotes) that bot's browser headed inside its Xvnc display (1280×800); MCP tools keep working on the headed page. Viewer page: `/ui/view?profile=<slug>&token=<token>` (also a "View live" button per bot in the panel). Requires the `tigervnc-standalone-server` system package (`Xvnc`); without it the viewer fails cleanly with a 502 and MCP browsing is unaffected.
- **Control panel** (`/ui/`): owner-only. Status, Camoufox install/repair, bot + token management, recent activity from the audit log.

## What it does NOT do

- No wake-on-call or exclusive human-takeover leases/arbitration. The viewer is view-only by default. Owner takeover blocks new agent browser tools and forwards owner input until handover. Already-running actions are not preempted.
- No CAPTCHA solving. Camoufox aims to prevent challenges, not solve them.
- No proxy rotation — the home IP is the point.
- No token expiry (same as Agent Computer): revocation + rate limit are the controls. Rotate tokens from the panel when one leaks.

## Vaultwarden per-bot credentials (optional)

Portal can run a **single lightweight Vaultwarden server** with **one independent Vaultwarden account per bot** (separate encryption/master passwords; not one shared vault). The bot never receives Vaultwarden master passwords, session keys, or raw credentials through the MCP tool response. This is not a guarantee against credential extraction from a compromised or malicious browser page.

1. Install Docker Compose and the official Bitwarden CLI (`bw`), then launch the optional localhost-bound Vaultwarden instance:

   ```sh
   VW_SIGNUPS_ALLOWED=true sudo docker compose -f vaultwarden.compose.yml up -d
   ```

2. On the Portal laptop, open `http://localhost:8222` and create separate accounts for each bot (for example Ezra and Leo). **Immediately close registrations** after provisioning by running `sudo docker compose -f vaultwarden.compose.yml up -d --force-recreate` (without the environment override). Never expose the plain HTTP localhost endpoint on the public internet. Use HTTPS with a trusted reverse proxy for remote vault access.

3. Configure and log in to each bot's vault independently. Replace `ezra` with that Portal profile's slug, and use the same `PORTAL_HOME` as the running service (default `~/.portal`):

   ```sh
   npm install -g @bitwarden/cli
   mkdir -p ~/.portal/vaultwarden/ezra
   chmod 700 ~/.portal/vaultwarden/ezra
   export BITWARDENCLI_APPDATA_DIR="$HOME/.portal/vaultwarden/ezra"
   bw config server http://localhost:8222
   bw login
   bw unlock --raw
   ```

4. Paste the resulting `BW_SESSION` **into Portal's owner-only Vaultwarden panel**, select that bot, and click Unlock. The session stays in Portal process memory only, and disappears on restart. Do not paste this key into HOB, agent prompts, or a terminal recording.
5. Add login items in Vaultwarden with an exact **HTTPS origin** under the item's URI list; use **Sync** in the owner panel after changing items. The owner panel shows item IDs, labels, and associated origins, never saved passwords. An agent calls `browser_credential_fill` with `item_id` (exact UUID) to fill a login belonging to its own Vaultwarden account. Item data is never returned to the agent tool.
6. Click Lock or restart Portal to clear the per-bot session key.

**Security limits:** The autofill broker refuses HTTP and mismatched origins, including subdomains. It only fills password fields in the main page (no arbitrary iframe injection). However, once a secret is in a web page's password input, a page script or a sufficiently powerful browser agent can potentially read or exfiltrate it. Portal still exposes browser and shell tools. **This integration is not suitable for high-value production credentials until browser/secret isolation is independently security-reviewed.** Prefer OAuth and short-lived scoped credentials where possible. Credential access audit records include tool name and bot but never secret values.

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
