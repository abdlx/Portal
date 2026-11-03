#!/usr/bin/env bash
# Portal installer — run ON THE LAPTOP:  ./install.sh
# Installs npm dependencies (including Camoufox), writes a systemd
# user service, and creates a desktop app entry that opens the control
# panel. Nothing is exposed to the public internet: the server binds the
# Tailscale IP if Tailscale is present, otherwise localhost only.
set -euo pipefail

# Self-bootstrap for the one-line install:
#   curl -fsSL https://raw.githubusercontent.com/abdlx/Portal/main/install.sh | bash
# From a pipe there is no checkout in $PWD (and $0 is just "bash"), so clone
# the repo into ~/portal, or reuse an existing checkout there. Run from a
# real checkout, the current directory wins.
if [ -f "$PWD/package.json" ] && [ -f "$PWD/src/server.mjs" ]; then
  APP_DIR="$PWD"
elif [ -f "$HOME/portal/package.json" ] && [ -f "$HOME/portal/src/server.mjs" ]; then
  APP_DIR="$HOME/portal"
  echo "Reusing existing checkout: $APP_DIR"
else
  command -v git >/dev/null 2>&1 || { echo "ERROR: git is not installed. Install git, then re-run."; exit 1; }
  if [ -e "$HOME/portal" ]; then
    echo "ERROR: $HOME/portal exists but is not a Portal checkout. Move it aside, then re-run."
    exit 1
  fi
  echo "Cloning Portal into $HOME/portal…"
  git clone https://github.com/abdlx/Portal.git "$HOME/portal"
  APP_DIR="$HOME/portal"
fi
PORT="${PORTAL_PORT:-9879}"
DATA_HOME="${PORTAL_HOME:-$HOME/.portal}"

echo "== Portal installer =="
echo "App dir: $APP_DIR"

# --- Node.js 22.15+ required (never auto-installs system packages) --------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Install Node 22+ first, then re-run:"
  echo "  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  Fedora:        sudo dnf install -y nodejs"
  echo "  Arch:          sudo pacman -S nodejs npm"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
NODE_MINOR="$(node -p "process.versions.node.split('.')[1]")"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 15 ]; }; then
  echo "ERROR: Node.js $NODE_MAJOR.$NODE_MINOR found; Node 22.15+ is required (Camoufox needs it). Upgrade Node, then re-run."
  exit 1
fi
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm is not installed (it ships with Node). Reinstall Node, then re-run."; exit 1; }
echo "Node $(node -v), npm $(npm -v)"

# --- Dependencies ------------------------------------------------------------
echo "Installing dependencies…"
cd "$APP_DIR"
if ! npm install --no-audit --no-fund; then
  echo "WARNING: npm install failed. The server will still start, and the"
  echo "desktop panel's Install button can retry the Camoufox install."
fi

# --- Camoufox browser + system libraries ------------------------------------
# Camoufox (patched Firefox, MPL-2.0) is free: no key, no activation.
# `npx camoufox fetch` downloads the paired browser build once. Firefox
# also needs three system libraries even headless; try a passwordless
# sudo install, otherwise print the command for the owner.
echo "Downloading the Camoufox browser build (once)…"
if [ -t 0 ]; then
  FETCH_OK=1; npx camoufox fetch || FETCH_OK=0
else
  FETCH_OK=1; npx camoufox fetch </dev/null || FETCH_OK=0
fi
if [ "$FETCH_OK" = "0" ]; then
  echo "WARNING: 'npx camoufox fetch' did not complete. Finish it by hand:"
  echo "  npx camoufox fetch"
  echo "Then restart the service: systemctl --user restart portal.service"
fi
echo "Checking Camoufox's system libraries…"
if command -v apt-get >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    sudo apt-get install -y --no-install-recommends libgtk-3-0t64 libx11-xcb1 libasound2t64 || echo "WARNING: library install failed — run the apt command below by hand."
  else
    echo "NOTE: passwordless sudo is not available, so the libraries were not installed."
    echo "If the browser fails to start with a missing .so error, run:"
    echo "  sudo apt-get install -y --no-install-recommends libgtk-3-0t64 libx11-xcb1 libasound2t64"
  fi
fi

# --- Bind address: Tailscale IP when present, localhost otherwise ----------
TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
HOST="${PORTAL_HOST:-${TAILSCALE_IP:-127.0.0.1}}"
echo "Binding to: $HOST:$PORT  (Tailscale IP detected: ${TAILSCALE_IP:-none})"
if [ -z "$TAILSCALE_IP" ]; then
  echo "NOTE: Tailscale was not detected. hob (on the VPS) will NOT be able to"
  echo "reach this laptop until Tailscale is installed and on the same tailnet."
  echo "Install from https://tailscale.com/download, run 'tailscale up', then re-run ./install.sh"
fi

mkdir -p "$DATA_HOME/profiles"

# --- systemd user service ---------------------------------------------------
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/portal.service" <<EOF
[Unit]
Description=Portal — one isolated browser per agent (MCP + panel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node $APP_DIR/src/server.mjs
Environment=PORTAL_HOST=$HOST
Environment=PORTAL_PORT=$PORT
Environment=PORTAL_HOME=$DATA_HOME
Environment=PORTAL_TAILSCALE_IP=$TAILSCALE_IP
EnvironmentFile=-$DATA_HOME/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now portal.service || {
    echo "WARNING: could not start the service. Start it manually with:"
    echo "  systemctl --user start portal.service"
  }
else
  echo "NOTE: systemctl not found. Start the server manually with:"
  echo "  PORTAL_HOST=$HOST PORTAL_PORT=$PORT node $APP_DIR/src/server.mjs"
fi

# --- Desktop app entry (opens the local control panel) ----------------------
ICON_SRC="$APP_DIR/assets/icon.svg"
mkdir -p "$HOME/.local/share/icons" "$HOME/.local/share/applications"
if [ -f "$ICON_SRC" ]; then cp "$ICON_SRC" "$HOME/.local/share/icons/portal.svg"; fi
DESKTOP_FILE="$HOME/.local/share/applications/portal.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Portal
Comment=Add bots, issue per-bot tokens, manage isolated Camoufox profiles
Exec=xdg-open http://127.0.0.1:$PORT/ui/
Icon=$HOME/.local/share/icons/portal.svg
Terminal=false
Type=Application
Categories=Utility;
StartupNotify=true
EOF
chmod +x "$DESKTOP_FILE"
if [ -d "$HOME/Desktop" ]; then cp "$DESKTOP_FILE" "$HOME/Desktop/portal.desktop"; chmod +x "$HOME/Desktop/portal.desktop"; fi
echo "Desktop app created: search for 'Portal' in your applications menu."

# --- Wait for health ---------------------------------------------------------
echo "Waiting for the server…"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo ""
echo "== Done =="
echo "Control panel (on this laptop): http://127.0.0.1:$PORT/ui/"
if [ -n "$TAILSCALE_IP" ]; then
  echo "Agent endpoint (from hob/VPS):  http://$TAILSCALE_IP:$PORT/mcp"
fi
echo "Owner token (panel sign-in):      $DATA_HOME/owner-token.txt  (keep it on this laptop)"
echo ""
echo "Next: open the Portal desktop app, add a bot, copy its token,"
echo "then paste that token into that bot's hob config (see README.md)."
echo ""
echo "Recommended, not done automatically:"
echo "  1. Keep the laptop awake + plugged in (no wake-on-call exists):"
echo "       sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
echo "  2. Keep the service running after logout:  loginctl enable-linger ${USER:-$(id -un)}"
echo "  3. Firewall — allow only the Tailscale range to port $PORT (check 'ufw status numbered' first):"
echo "       sudo ufw allow from 100.64.0.0/10 to any port $PORT"
echo "       sudo ufw deny $PORT"
echo "Logs:  journalctl --user -u portal.service -f"
