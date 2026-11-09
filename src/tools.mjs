// MCP tool definitions for portal. Shapes mirror Agent Computer's
// control-plane tools (same names, same argument names, same result
// envelope) so hob's panel bridge works unchanged. Tool errors are
// isError text results, never thrown HTTP errors.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { obj, validateArgs } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const BUILD_DIR = path.join(APP_DIR, "build");
const NETGUARD_SO = path.join(BUILD_DIR, "libportal_netguard.so");
const NETGUARD_C = path.join(APP_DIR, "src", "netguard.c");

let netguardChecked = null;
export function ensureNetguardLibrary() {
  if (netguardChecked !== null) return netguardChecked;
  if (fs.existsSync(NETGUARD_SO)) {
    netguardChecked = NETGUARD_SO;
    return netguardChecked;
  }
  if (!fs.existsSync(NETGUARD_C)) {
    netguardChecked = null;
    return null;
  }
  const compilers = ["gcc", "cc", "clang"];
  for (const cc of compilers) {
    try {
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      execFileSync(cc, ["-shared", "-fPIC", "-O2", NETGUARD_C, "-o", NETGUARD_SO, "-ldl"], {
        stdio: "ignore",
        timeout: 10000,
      });
      if (fs.existsSync(NETGUARD_SO)) {
        netguardChecked = NETGUARD_SO;
        return netguardChecked;
      }
    } catch {
      /* try next compiler */
    }
  }
  netguardChecked = null;
  return null;
}

// Dynamic OS Headroom Reservation (RAM and CPU)
// Reserve 1.25 GB RAM and 1 CPU core for host desktop/systemd, letting bots dynamically utilize the rest.
const RESERVED_HEADROOM_RAM_BYTES = 1250 * 1024 * 1024; // 1.25 GB

export function getSystemHeadroom() {
  let memAvailable = 0;
  let memTotal = 0;
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
    if (availMatch) memAvailable = parseInt(availMatch[1], 10) * 1024;
    if (totalMatch) memTotal = parseInt(totalMatch[1], 10) * 1024;
  } catch {
    memAvailable = os.freemem();
    memTotal = os.totalmem();
  }
  const totalCores = os.cpus().length;
  const botCores = Math.max(1, totalCores - 1);
  const headroomBytes = RESERVED_HEADROOM_RAM_BYTES;
  const allowableBytes = Math.max(0, memAvailable - headroomBytes);

  return {
    memTotalBytes: memTotal,
    memAvailableBytes: memAvailable,
    headroomReservedBytes: headroomBytes,
    allowableBytesForBots: allowableBytes,
    headroomOk: memAvailable > headroomBytes,
    totalCores,
    botCores,
    reservedCores: totalCores > 1 ? 1 : 0,
  };
}

export const text = (v) => ({
  content: [
    {
      type: "text",
      text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
    },
  ],
});
export const errText = (msg) => ({
  content: [{ type: "text", text: `Error: ${msg}` }],
  isError: true,
});

export function hasScope(token, scope) {
  return token.scopes.includes("admin") || token.scopes.includes(scope);
}

const COMPUTER_ARG = {
  computer: {
    type: "string",
    description:
      "Computer id or name. Optional when the token is bound to one computer or only one exists.",
  },
  profile: {
    type: "string",
    description:
      "Agent profile name (e.g. 'dex', 'kai'). Optional, defaults to the profile bound to your token or 'default'. When your token is bound to a profile, this must match it or the call is rejected.",
  },
};

const TAB_ARG = {
  tab: {
    type: "string",
    description:
      "Tab id (e.g. 'tab1') from browser_tab_list. Optional; defaults to the active tab. Tabs are always enabled — nothing disables them.",
  },
};

function resolveComputer(ctx, arg) {
  const row = ctx.store.data.computer;
  if (ctx.token.computerId) {
    if (arg && String(arg) !== row.id && String(arg) !== row.name) {
      throw new Error(
        `token is bound to computer ${row.id}; it cannot access ${String(arg)}`,
      );
    }
    return row;
  }
  if (arg) {
    if (String(arg) !== row.id && String(arg) !== row.name) {
      throw new Error(`computer not found: ${String(arg)}`);
    }
    return row;
  }
  return row;
}

function resolveProfile(ctx, argProfile) {
  const arg =
    argProfile && typeof argProfile === "string" && argProfile.trim()
      ? argProfile.trim()
      : null;
  // Fail-closed binding, including the fix for the Agent Computer hole:
  // a profile-bound token acting as another profile is rejected BEFORE
  // any browser/fs/exec work happens.
  if (ctx.token.profileSlug) {
    if (arg && arg !== ctx.token.profileSlug) {
      throw new Error(
        `token is bound to profile ${ctx.token.profileSlug}; it cannot act as ${arg}`,
      );
    }
    const p = ctx.store.profileBySlug(ctx.token.profileSlug);
    if (!p) throw new Error("the profile this token is bound to no longer exists");
    return p;
  }
  const slug = arg ?? "default";
  const p = ctx.store.profileBySlug(slug);
  if (!p) throw new Error(`profile not found: ${slug}`);
  return p;
}

function effectiveProfile(ctx, args) {
  return resolveProfile(ctx, args.profile);
}

// ---- workspace confinement ------------------------------------------------
// Every fs path must stay inside the profile's workspace. Symlinks are
// resolved (nearest existing ancestor for not-yet-created paths) so a
// symlink inside the workspace cannot smuggle a read outside it.
function resolveInWorkspace(store, profile, p) {
  const home = fs.realpathSync(store.ensureWorkspace(profile.slug));
  const target = path.resolve(home, p || ".");
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    let cur = target;
    while (!fs.existsSync(cur)) cur = path.dirname(cur);
    const realBase = fs.realpathSync(cur);
    real = path.join(realBase, path.relative(cur, target));
  }
  const rel = path.relative(home, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the profile workspace");
  }
  return real;
}

// ---- shell sandbox (bubblewrap) -------------------------------------------
// terminal_exec runs inside a bubblewrap sandbox: the whole filesystem
// is mounted read-only except the bot's workspace (bound writable at
// /tmp/workspace), the real home directory is hidden behind an empty
// tmpfs, /tmp is fresh, and the shell starts in /tmp/workspace. The bot
// keeps network access. The bind target is under /tmp (not /workspace)
// because bwrap cannot create a mountpoint on the read-only root, and
// an unprivileged user cannot create one on the live root either —
// /tmp is always present and writable, and the fresh tmpfs makes the
// mkdir succeed. Fail-closed: without bwrap on PATH the shell refuses
// to run, unless the owner explicitly opts out with
// PORTAL_ALLOW_UNSANDBOXED_SHELL=1 (test/CI hosts, or hosts without
// user namespaces) — in which case it runs unsandboxed as the Portal
// user, exactly as before.
// The in-sandbox path of the workspace. Under /tmp (not /workspace):
// bwrap creates the bind mountpoint with mkdir, which fails on the
// read-only root and is forbidden to an unprivileged user on the live
// root — /tmp is always present and writable, and the fresh tmpfs
// makes the mkdir succeed there.
const SANDBOX_WORKSPACE = "/tmp/workspace";

const BWRAP_MISSING_MSG =
  "terminal_exec is sandboxed with bubblewrap (bwrap), which was not found on PATH. " +
  "Install it (Debian/Ubuntu: sudo apt-get install -y bubblewrap) and restart Portal. " +
  "On Ubuntu 24.04, if bwrap exists but sandboxing fails, unprivileged user namespaces may be " +
  "restricted by AppArmor — the installer smoke test reports the fix. " +
  "Owner override for hosts without user namespaces: PORTAL_ALLOW_UNSANDBOXED_SHELL=1 " +
  "(the shell then runs unsandboxed as the Portal user).";

let bwrapChecked = null;
function bwrapAvailable() {
  if (bwrapChecked !== null) return bwrapChecked;
  bwrapChecked = (process.env.PATH || "").split(path.delimiter).some((d) => {
    try {
      fs.accessSync(path.join(d, "bwrap"), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return bwrapChecked;
}

export function shellSandboxStatus() {
  if (process.env.PORTAL_ALLOW_UNSANDBOXED_SHELL === "1") {
    return "opt-out: terminal_exec UNSANDBOXED";
  }
  return bwrapAvailable()
    ? "bubblewrap"
    : "UNAVAILABLE: terminal_exec will refuse to run";
}

let warnedUnsandboxed = false;

function runShell(command, workspace, profileSlug, timeoutS) {
  const timeoutMs = Math.min(120, Math.max(1, Number(timeoutS) || 30)) * 1000;
  const allowUnsandboxed =
    process.env.PORTAL_ALLOW_UNSANDBOXED_SHELL === "1";
  let file = "bash";
  let argv = ["-lc", command];
  let cwd = workspace;
  let home = workspace;
  if (!allowUnsandboxed) {
    if (!bwrapAvailable()) {
      return Promise.resolve({
        stdout: "",
        stderr: BWRAP_MISSING_MSG,
        code: 1,
        timedOut: false,
      });
    }
    const realHome = process.env.HOME || "/";
    const flags = [
      "--ro-bind",
      "/",
      "/",
      "--tmpfs",
      "/tmp",
      "--bind",
      workspace,
      SANDBOX_WORKSPACE,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--unshare-pid",
    ];
    // Hide the real home directory (owner files, ssh keys, and every
    // other bot's folder live under it). The workspace bind above is
    // already established, so hiding its original path is safe. Skip
    // when home IS the root, where hiding it would hide the bind too.
    if (realHome !== "/") flags.push("--tmpfs", realHome);

    const netguardSo = ensureNetguardLibrary();
    const sandboxEnv = {
      ...process.env,
      HOME: home,
      AGENT_PROFILE: profileSlug,
      AGENT_WORKSPACE: home,
    };

    if (netguardSo) {
      flags.push("--ro-bind", netguardSo, "/tmp/libportal_netguard.so");
      flags.push("--setenv", "LD_PRELOAD", "/tmp/libportal_netguard.so");
      sandboxEnv.LD_PRELOAD = "/tmp/libportal_netguard.so";
    }

    flags.push("--chdir", SANDBOX_WORKSPACE);
    // execFile requires the cwd to exist on the host before the spawn:
    // make sure the sandbox mountpoint is there (/tmp is writable).
    try {
      fs.mkdirSync(SANDBOX_WORKSPACE, { recursive: true });
    } catch {
      /* bwrap reports the failure */
    }

    // Configure OOM score adjustment so agent processes take OOM priority
    // over host OS services under pressure (+500).
    // Reserve 1 CPU core for the host OS desktop/systemd, allowing bots
    // to dynamically utilize remaining cores (cores 1..N-1) under nice +10.
    const headroom = getSystemHeadroom();
    let setup = "export LD_PRELOAD=/tmp/libportal_netguard.so; echo 500 > /proc/self/oom_score_adj 2>/dev/null || true; renice -n 10 $$ >/dev/null 2>&1 || true; ";
    if (headroom.totalCores > 1) {
      setup += `taskset -cp 1-${headroom.totalCores - 1} $$ >/dev/null 2>&1 || true; `;
    }
    const wrappedCmd = setup + command;

    file = "bwrap";
    argv = [...flags, "bash", "-lc", wrappedCmd];
    cwd = SANDBOX_WORKSPACE;
    home = SANDBOX_WORKSPACE;
  } else if (!warnedUnsandboxed) {
    warnedUnsandboxed = true;
    console.warn(
      "[portal] PORTAL_ALLOW_UNSANDBOXED_SHELL=1: terminal_exec runs UNSANDBOXED as the Portal user",
    );
  }
  const spawnEnv = !allowUnsandboxed && typeof sandboxEnv !== "undefined"
    ? sandboxEnv
    : {
        ...process.env,
        HOME: home,
        AGENT_PROFILE: profileSlug,
        AGENT_WORKSPACE: home,
      };
  return new Promise((resolve) => {
    execFile(
      file,
      argv,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024,
        env: spawnEnv,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const cap = (s) => String(s || "").slice(0, 20 * 1024);
        if (err && err.killed) {
          resolve({ stdout: cap(stdout), stderr: cap(stderr), code: -1, timedOut: true });
        } else {
          resolve({
            stdout: cap(stdout),
            stderr: cap(stderr),
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          });
        }
      },
    );
  });
}

export const TOOLS = [
  {
    name: "computer_list",
    scope: "read",
    description: "List the computers this token can access, with their lifecycle state.",
    inputSchema: obj({}),
    run: async (ctx) => {
      const row = ctx.store.data.computer;
      return text([
        {
          id: row.id,
          name: row.name,
          state: "ready",
          isShared: true,
          profileCount: ctx.store.profiles().length,
        },
      ]);
    },
  },
  {
    name: "computer_status",
    scope: "read",
    description: "Detailed status of one computer: lifecycle state and profiles.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      return text({
        id: row.id,
        name: row.name,
        state: "ready",
        health: {
          ready: true,
          profiles: ctx.store.profiles().length,
          home: ctx.store.home,
        },
      });
    },
  },
  {
    name: "computer_wake",
    scope: "write",
    description: "Wake a sleeping computer and wait until it is ready.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      return text({ id: row.id, state: "ready" });
    },
  },
  {
    name: "computer_sleep",
    scope: "write",
    description: "Gracefully sleep a computer (browser state flushes; files and profile persist).",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      // The laptop is always on; sleep is a no-op acknowledgement, never
      // an actual suspend. The panel's sleep button therefore never
      // kills the machine it is talking to.
      return text({ id: row.id, state: "ready", note: "sleep is a no-op on the laptop; it stays awake" });
    },
  },
  {
    name: "profile_list",
    scope: "read",
    description: "List available agent profiles under this computer.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      const profiles = ctx.store.profiles().map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        isDefault: p.isDefault,
      }));
      return text({
        computerId: row.id,
        computerName: row.name,
        isShared: true,
        currentProfile: ctx.token.profileSlug ?? "default",
        profiles,
      });
    },
  },
  {
    name: "profile_current",
    scope: "read",
    description: "Get the profile and workspace context this agent session is operating under.",
    inputSchema: obj({}),
    run: async (ctx) => {
      const slug = ctx.token.profileSlug ?? "default";
      return text({
        agentName: ctx.token.name,
        computerId: ctx.token.computerId,
        profileId: ctx.token.profileId,
        profileSlug: slug,
        scopes: ctx.token.scopes,
        workspace: ctx.store.ensureWorkspace(slug),
      });
    },
  },
  {
    name: "browser_start",
    scope: "browser",
    description: "Start the persistent browser (Camoufox) for this profile. The profile (cookies, logins) persists across restarts.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      await ctx.browser.ensure(profile);
      const st = await ctx.browser.status(profile);
      return text({ started: true, profile: profile.slug, url: st.url, activeTab: st.activeTab, tabs: st.tabs, headed: st.headed });
    },
  },
  {
    name: "browser_navigate",
    scope: "browser",
    description: "Navigate the browser to a URL. Pass newTab: true to open it in a new tab (tabs are always enabled).",
    inputSchema: obj({ ...COMPUTER_ARG, ...TAB_ARG, url: { type: "string" }, newTab: { type: "boolean" } }, ["url"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.navigate(profile, args.url, { tab: args.tab, newTab: args.newTab }));
    },
  },
  {
    name: "browser_tab_new",
    scope: "browser",
    description: "Open a new tab in this profile's browser and switch to it. Optionally navigate it to a URL. Returns the new tab id.",
    inputSchema: obj({ ...COMPUTER_ARG, url: { type: "string" } }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.newTab(profile, args.url));
    },
  },
  {
    name: "browser_tab_list",
    scope: "browser",
    description: "List the open tabs in this profile's browser (id, URL, title) and which tab is active. Returns no tabs without starting the browser.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.listTabs(profile));
    },
  },
  {
    name: "browser_tab_switch",
    scope: "browser",
    description: "Switch to a tab by its id from browser_tab_list. Snapshot refs belong to the tab that was snapshotted.",
    inputSchema: obj({ ...COMPUTER_ARG, tab: { type: "string" } }, ["tab"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.switchTab(profile, args.tab));
    },
  },
  {
    name: "browser_tab_close",
    scope: "browser",
    description: "Close a tab by its id. Closing the active tab activates the most recent remaining tab. The browser keeps running with zero tabs until the next navigation.",
    inputSchema: obj({ ...COMPUTER_ARG, tab: { type: "string" } }, ["tab"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.closeTab(profile, args.tab));
    },
  },
  {
    name: "browser_snapshot",
    scope: "browser",
    description: "Accessibility snapshot of the page: interactive elements with refs (e1, e2, …) to use with browser_click / browser_fill.",
    inputSchema: obj({ ...COMPUTER_ARG, ...TAB_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const snap = await ctx.browser.snapshot(profile, args.tab);
      return text(
        `URL: ${snap.url}\nTitle: ${snap.title}\nTab: ${snap.tab}\n\n${snap.elements || "(no interactive elements found)"}`,
      );
    },
  },
  {
    name: "browser_click",
    scope: "browser",
    description:
      "Click an element by its snapshot ref. Set stealth: true for login/submit/captcha to use humanized Bezier mouse curves.",
    inputSchema: obj(
      { ...COMPUTER_ARG, ...TAB_ARG, ref: { type: "string" }, stealth: { type: "boolean" } },
      ["ref"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.click(profile, args.ref, args.tab, { stealth: args.stealth }));
    },
  },
  {
    name: "browser_fill",
    scope: "browser",
    description:
      "Fill a text field (by snapshot ref) with text. Set stealth: true for passwords or sensitive inputs to simulate natural keystroke flight variance.",
    inputSchema: obj(
      {
        ...COMPUTER_ARG,
        ...TAB_ARG,
        ref: { type: "string" },
        text: { type: "string" },
        stealth: { type: "boolean" },
      },
      ["ref", "text"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.fill(profile, args.ref, args.text, args.tab, { stealth: args.stealth }));
    },
  },
  {
    name: "browser_press",
    scope: "browser",
    description: "Press a key in the page, e.g. 'Enter', 'Tab', 'Escape'.",
    inputSchema: obj({ ...COMPUTER_ARG, ...TAB_ARG, key: { type: "string" } }, ["key"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.press(profile, args.key, args.tab));
    },
  },
  {
    name: "browser_content",
    scope: "browser",
    description: "The page's visible text content and title.",
    inputSchema: obj({ ...COMPUTER_ARG, ...TAB_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const c = await ctx.browser.content(profile, args.tab);
      return text(`URL: ${c.url}\nTitle: ${c.title}\nTab: ${c.tab}\n\n${c.text}`);
    },
  },
  {
    name: "browser_evaluate",
    scope: "browser",
    description: "Evaluate a JavaScript expression in the page context and return the result.",
    inputSchema: obj(
      {
        ...COMPUTER_ARG,
        ...TAB_ARG,
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate in the page context",
        },
      },
      ["expression"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const result = await ctx.browser.evaluate(profile, args.expression, args.tab);
      return text(result !== undefined ? JSON.stringify(result, null, 2) : "undefined");
    },
  },
  {
    name: "browser_credential_list",
    scope: "browser",
    description:
      "List saved credentials in the Portal Vault for the current bot profile. Returns id, name, origin, username, and updatedAt. Passwords are never returned.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(ctx.credentialVault.list(profile));
    },
  },
  {
    name: "browser_credential_fill",
    scope: "browser",
    description:
      "Fill a saved Portal Vault login in the current bot's browser. If item_id is omitted, auto-matches credentials by current page origin. The password is never returned.",
    inputSchema: obj({
      ...COMPUTER_ARG,
      ...TAB_ARG,
      item_id: {
        type: "string",
        description:
          "Saved credential ID. Optional; if omitted, credentials matching the current page origin are used automatically.",
      },
    }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(
        await ctx.browser.fillVaultLogin(
          profile,
          ctx.credentialVault,
          args.item_id,
          args.tab,
        ),
      );
    },
  },
  {
    name: "browser_screenshot",
    scope: "browser",
    description:
      "Take a screenshot of the rendered browser page (viewport or full scrollable page). Returns base64 image data for visual inspection and/or saves the PNG file to the profile workspace for delivery.",
    inputSchema: obj({
      ...COMPUTER_ARG,
      ...TAB_ARG,
      fullPage: {
        type: "boolean",
        description:
          "Whether to capture the full scrollable page instead of just the currently visible viewport. Defaults to false.",
      },
      path: {
        type: "string",
        description:
          "Relative file path within the profile workspace to save the screenshot PNG (e.g. 'screenshot.png' or 'artifacts/page.png'). Auto-creates parent directories. If omitted and save is not false, defaults to 'screenshot.png'.",
      },
      save: {
        type: "boolean",
        description:
          "Whether to save the screenshot to the profile workspace. Defaults to true.",
      },
      base64: {
        type: "boolean",
        description:
          "Whether to include the base64-encoded PNG image in the MCP response content for visual inspection. Defaults to true.",
      },
      timeout_s: {
        type: "number",
        description:
          "Timeout in seconds for taking the screenshot. Defaults to 30.",
      },
    }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const timeout = args.timeout_s ? Math.round(args.timeout_s * 1000) : 30000;
      const shot = await ctx.browser.screenshot(profile, args.tab, {
        fullPage: args.fullPage,
        timeout,
      });

      let savedRelPath = null;
      let savedAbsPath = null;
      const shouldSave = args.save !== false;
      if (shouldSave) {
        savedRelPath =
          args.path && typeof args.path === "string" && args.path.trim()
            ? args.path.trim()
            : "screenshot.png";
        savedAbsPath = resolveInWorkspace(ctx.store, profile, savedRelPath);
        fs.mkdirSync(path.dirname(savedAbsPath), { recursive: true });
        await fs.promises.writeFile(savedAbsPath, shot.buffer);
      }

      const info = {
        ok: true,
        url: shot.url,
        title: shot.title,
        tab: shot.tab,
        fullPage: !!args.fullPage,
        bytes: shot.buffer.length,
      };
      if (savedRelPath) {
        info.path = savedRelPath;
        info.workspacePath = savedAbsPath;
      }

      const content = [
        {
          type: "text",
          text: JSON.stringify(info, null, 2),
        },
      ];

      if (args.base64 !== false) {
        content.push({
          type: "image",
          data: shot.buffer.toString("base64"),
          mimeType: "image/png",
        });
      }

      return { content };
    },
  },
  {
    name: "browser_close",
    scope: "browser",
    description: "Close the browser (profile state flushes to disk).",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.close(profile));
    },
  },
  {
    name: "fs_list",
    scope: "files",
    description: "List a directory inside the profile's workspace directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const dir = resolveInWorkspace(ctx.store, profile, args.path);
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        let size = null;
        try {
          size = (await fs.promises.stat(path.join(dir, e.name))).size;
        } catch {
          /* ignore */
        }
        out.push({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          size,
        });
      }
      return text({ path: args.path || ".", entries: out });
    },
  },
  {
    name: "fs_read",
    scope: "files",
    description: "Read a file from the workspace directory (utf-8, or base64 when binary; 256 KB cap).",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const file = resolveInWorkspace(ctx.store, profile, args.path);
      const buf = await fs.promises.readFile(file);
      if (buf.length > 256 * 1024) throw new Error("file exceeds the 256 KB read cap");
      const isBinary = buf.includes(0);
      return text({
        path: args.path,
        encoding: isBinary ? "base64" : "utf-8",
        content: isBinary ? buf.toString("base64") : buf.toString("utf8"),
      });
    },
  },
  {
    name: "fs_write",
    scope: "files",
    description: "Write a file in the workspace directory (creates parent directories).",
    inputSchema: obj(
      {
        ...COMPUTER_ARG,
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
      },
      ["path", "content"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const file = resolveInWorkspace(ctx.store, profile, args.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const buf =
        args.encoding === "base64"
          ? Buffer.from(args.content, "base64")
          : Buffer.from(args.content, "utf8");
      await fs.promises.writeFile(file, buf);
      return text({ written: args.path, bytes: buf.length });
    },
  },
  {
    name: "fs_mkdir",
    scope: "files",
    description: "Create a directory (and parents) in the workspace directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const dir = resolveInWorkspace(ctx.store, profile, args.path);
      fs.mkdirSync(dir, { recursive: true });
      return text({ created: args.path });
    },
  },
  {
    name: "fs_delete",
    scope: "files",
    description: "Delete a file or directory tree from the workspace directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const target = resolveInWorkspace(ctx.store, profile, args.path);
      const workspace = fs.realpathSync(ctx.store.ensureWorkspace(profile.slug));
      if (target === workspace) throw new Error("refusing to delete the profile workspace itself");
      await fs.promises.rm(target, { recursive: true, force: true });
      return text({ deleted: args.path });
    },
  },
  {
    name: "terminal_exec",
    scope: "write",
    description:
      "Run a shell command in the profile's workspace, sandboxed with bubblewrap (the whole filesystem is read-only except the workspace, which the shell sees at /tmp/workspace; HOME and AGENT_WORKSPACE are /tmp/workspace). Returns stdout/stderr/exit code. Long-running processes should use nohup/setsid and return.",
    inputSchema: obj(
      { ...COMPUTER_ARG, command: { type: "string" }, timeout_s: { type: "number" } },
      ["command"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const workspace = fs.realpathSync(ctx.store.ensureWorkspace(profile.slug));
      return text(
        await runShell(args.command, workspace, profile.slug, args.timeout_s ?? 30),
      );
    },
  },
  {
    name: "batch",
    scope: "write",
    description:
      "Run a sequence of tool steps in order (each step: {tool, args}). Stops at the first failing step unless stopOnError is false. Cannot call batch, computer_create, or computer_delete.",
    inputSchema: obj(
      {
        ...COMPUTER_ARG,
        steps: { type: "array", items: { type: "object" } },
        stopOnError: { type: "boolean" },
      },
      ["steps"],
    ),
    run: async (ctx, args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (steps.length === 0 || steps.length > 50) {
        return errText("steps must contain 1..50 items");
      }
      const results = [];
      for (const rawStep of steps) {
        const step = rawStep;
        const def = TOOLS.find((t) => t.name === step.tool);
        if (!def || def.name === "batch" || def.scope === "admin") {
          results.push({ tool: step.tool, error: "tool not allowed in batch" });
          if (args.stopOnError !== false) break;
          continue;
        }
        if (!hasScope(ctx.token, def.scope)) {
          results.push({ tool: def.name, error: `missing scope: ${def.scope}` });
          if (args.stopOnError !== false) break;
          continue;
        }
        const stepArgs = { ...(step.args ?? {}) };
        if (args.computer && !stepArgs.computer) stepArgs.computer = args.computer;
        try {
          validateArgs(def.inputSchema, stepArgs);
          if (!ctx.isTokenActive()) throw new Error("token was revoked");
          const r = await def.run(ctx, stepArgs);
          results.push({ tool: def.name, result: r.content, isError: r.isError ?? false });
          if (r.isError && args.stopOnError !== false) break;
        } catch (e) {
          results.push({ tool: def.name, error: e.message });
          if (args.stopOnError !== false) break;
        }
      }
      return text({ steps: results });
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
