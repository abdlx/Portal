// Display manager: one TigerVNC X server (Xvnc) per bot profile.
//
// A headed Camoufox draws into its profile's Xvnc display, and the RFB
// stream Xvnc serves is what viewers connect to through the
// /api/computers/:id/vnc WebSocket endpoint — the same byte-pipe shape
// Agent Computer uses (WebSocket upgrade + token auth, then raw bytes
// forwarded to the VNC server; the RFB stream is never terminated in
// Portal, just like Agent Computer's control plane never terminates it).
//
// Xvnc binds localhost-only and takes no VNC password: Portal's token
// auth on the WebSocket upgrade is the gate, the same trust model as
// Agent Computer (token/session auth in front of its guest VNC bridge).
// The VNC port is never exposed beyond the machine.
//
// Xvnc comes from the tigervnc-standalone-server system package
// (install.sh tries it; the panel cannot install system packages).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 800;

export const XVNC_MISSING_MSG =
  "TigerVNC (Xvnc) is not installed on this machine, so no live view is available. Install it, then try again: sudo apt-get install -y tigervnc-standalone-server";

const FIRST_DISPLAY = 91;
const LAST_DISPLAY = 99;

// slug -> { display, port, proc, ready }
const displays = new Map();
const usedDisplays = new Set();

function lockPid(display) {
  try {
    const pid = Number(fs.readFileSync(`/tmp/.X${display}-lock`, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A display number is taken when something listens on its RFB port or a
// live X server holds its lock file. A lock file pointing at a dead PID
// is stale (Xvnc removes those itself); only a live owner counts.
async function displayTaken(display) {
  const port = 5900 + display;
  const listening = await new Promise((resolve) => {
    const probe = net.connect(port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
  if (listening) return true;
  const pid = lockPid(display);
  return pid !== null && pidAlive(pid);
}

function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const probe = net.connect(port, "127.0.0.1");
      probe.once("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.once("error", () => {
        probe.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Xvnc did not start listening on port ${port} in time`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

async function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Start (or reuse) the Xvnc display for a profile. Returns {display, port}.
//
// Collision-proof: a previous Portal server that died without cleanup
// can leave a live Xvnc behind holding a display number and port. A
// bare "is the port listening" check would mistake that orphan for our
// own server and pipe the viewer at the wrong bot's screen (caught by
// the VNC probe: Kai's viewer read Dex's ServerInit name). So a number
// is only used when nothing live owns it, and after starting we verify
// the lock file names OUR process before trusting the port.
export async function startDisplay(slug) {
  const existing = displays.get(slug);
  if (existing) return { display: existing.display, port: existing.port };
  let lastError = null;
  for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
    if (usedDisplays.has(n)) continue;
    if (await displayTaken(n)) continue;
    usedDisplays.add(n);
    const port = 5900 + n;
    const args = [
      `:${n}`,
      "-geometry",
      `${VIEW_WIDTH}x${VIEW_HEIGHT}`,
      "-depth",
      "24",
      "-rfbport",
      String(port),
      "-localhost",
      "-nolisten",
      "tcp",
      "-SecurityTypes",
      "None",
      "-AlwaysShared",
      "-desktop",
      `Portal-${slug}`,
      "-dpi",
      "96",
    ];
    let stderr = "";
    const proc = spawn("Xvnc", args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const exited = new Promise((resolve) => {
      proc.once("exit", (code) => resolve(code));
      proc.once("error", (e) => resolve(e));
    });
    const ready = (async () => {
      try {
        await waitForPort(port);
      } catch {
        return false;
      }
      // The lock file is the ownership record: it must name our PID.
      // An orphan holding this display makes our Xvnc exit, while the
      // port still answers — trusting the port alone pipes the viewer
      // at the orphan's screen.
      for (let i = 0; i < 50; i++) {
        if (lockPid(n) === proc.pid) return true;
        if (proc.exitCode !== null) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return lockPid(n) === proc.pid;
    })();
    const outcome = await Promise.race([
      exited.then((v) => ({ exited: v })),
      ready.then((ok) => ({ ready: ok })),
    ]);
    if (outcome.ready) {
      const entry = { display: n, port, proc, ready: true };
      displays.set(slug, entry);
      return { display: n, port };
    }
    usedDisplays.delete(n);
    if (outcome.exited && typeof outcome.exited === "object" && outcome.exited.code === "ENOENT") {
      throw new Error(XVNC_MISSING_MSG);
    }
    lastError =
      outcome.exited !== undefined
        ? new Error(
            `Xvnc for display :${n} exited (${typeof outcome.exited === "object" ? outcome.exited.code || outcome.exited.message : outcome.exited})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`,
          )
        : new Error(`Xvnc for display :${n} did not claim its lock file in time`);
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    // Fall through and try the next display number.
  }
  throw lastError || new Error("no free VNC display (all 9 viewer slots are in use)");
}

export function displayFor(slug) {
  const entry = displays.get(slug);
  return entry ? { display: entry.display, port: entry.port } : null;
}

// Stop a display and wait until its Xvnc is actually gone. A fire-and-
// forget SIGTERM leaves orphaned X servers holding their display
// numbers after an unclean shutdown, which then poison later
// allocations (see startDisplay). Callers that shut the server down
// await this before exiting.
export async function stopDisplay(slug) {
  const entry = displays.get(slug);
  if (!entry) return;
  displays.delete(slug);
  usedDisplays.delete(entry.display);
  try {
    entry.proc.kill("SIGTERM");
  } catch {
    /* gone */
  }
  if (!(await waitForExit(entry.proc, 3000))) {
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    await waitForExit(entry.proc, 2000);
  }
}

export async function stopAllDisplays() {
  await Promise.all([...displays.keys()].map((slug) => stopDisplay(slug)));
}
