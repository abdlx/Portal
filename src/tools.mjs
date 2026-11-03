// MCP tool definitions for portal. Shapes mirror Agent Computer's
// control-plane tools (same names, same argument names, same result
// envelope) so hob's panel bridge works unchanged. Tool errors are
// isError text results, never thrown HTTP errors.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { obj, validateArgs } from "./validate.mjs";

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

// ---- filesystem confinement -----------------------------------------------
// Every fs path must stay inside the profile's home. Symlinks are
// resolved (nearest existing ancestor for not-yet-created paths) so a
// symlink inside the home cannot smuggle a read outside it.
function resolveInHome(store, profile, p) {
  const home = fs.realpathSync(store.profileHome(profile.slug));
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
    throw new Error("path escapes the profile home");
  }
  return real;
}

function runShell(command, cwd, timeoutS, envExtra) {
  const timeoutMs = Math.min(120, Math.max(1, Number(timeoutS) || 30)) * 1000;
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024,
        env: { ...process.env, ...envExtra },
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
      return text({
        agentName: ctx.token.name,
        computerId: ctx.token.computerId,
        profileId: ctx.token.profileId,
        profileSlug: ctx.token.profileSlug ?? "default",
        scopes: ctx.token.scopes,
      });
    },
  },
  {
    name: "browser_start",
    scope: "browser",
    description: "Start the persistent browser (CloakBrowser) for this profile. The profile (cookies, logins) persists across restarts.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      await ctx.browser.ensure(profile);
      const st = await ctx.browser.status(profile);
      return text({ started: true, profile: profile.slug, url: st.url });
    },
  },
  {
    name: "browser_navigate",
    scope: "browser",
    description: "Navigate the browser to a URL.",
    inputSchema: obj({ ...COMPUTER_ARG, url: { type: "string" } }, ["url"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.navigate(profile, args.url));
    },
  },
  {
    name: "browser_snapshot",
    scope: "browser",
    description: "Accessibility snapshot of the page: interactive elements with refs (e1, e2, …) to use with browser_click / browser_fill.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const snap = await ctx.browser.snapshot(profile);
      return text(
        `URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.elements || "(no interactive elements found)"}`,
      );
    },
  },
  {
    name: "browser_click",
    scope: "browser",
    description: "Click an element by its snapshot ref.",
    inputSchema: obj({ ...COMPUTER_ARG, ref: { type: "string" } }, ["ref"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.click(profile, args.ref));
    },
  },
  {
    name: "browser_fill",
    scope: "browser",
    description: "Fill a text field (by snapshot ref) with text.",
    inputSchema: obj(
      { ...COMPUTER_ARG, ref: { type: "string" }, text: { type: "string" } },
      ["ref", "text"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.fill(profile, args.ref, args.text));
    },
  },
  {
    name: "browser_press",
    scope: "browser",
    description: "Press a key in the page, e.g. 'Enter', 'Tab', 'Escape'.",
    inputSchema: obj({ ...COMPUTER_ARG, key: { type: "string" } }, ["key"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      return text(await ctx.browser.press(profile, args.key));
    },
  },
  {
    name: "browser_content",
    scope: "browser",
    description: "The page's visible text content and title.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const c = await ctx.browser.content(profile);
      return text(`URL: ${c.url}\nTitle: ${c.title}\n\n${c.text}`);
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
    description: "List a directory inside the profile's home directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const dir = resolveInHome(ctx.store, profile, args.path);
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
    description: "Read a file from the home directory (utf-8, or base64 when binary; 256 KB cap).",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const file = resolveInHome(ctx.store, profile, args.path);
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
    description: "Write a file in the home directory (creates parent directories).",
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
      const file = resolveInHome(ctx.store, profile, args.path);
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
    description: "Create a directory (and parents) in the home directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const dir = resolveInHome(ctx.store, profile, args.path);
      fs.mkdirSync(dir, { recursive: true });
      return text({ created: args.path });
    },
  },
  {
    name: "fs_delete",
    scope: "files",
    description: "Delete a file or directory tree from the home directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const target = resolveInHome(ctx.store, profile, args.path);
      const home = fs.realpathSync(ctx.store.profileHome(profile.slug));
      if (target === home) throw new Error("refusing to delete the profile home itself");
      await fs.promises.rm(target, { recursive: true, force: true });
      return text({ deleted: args.path });
    },
  },
  {
    name: "terminal_exec",
    scope: "write",
    description:
      "Run a shell command on the computer (as its user, in a login shell) and return stdout/stderr/exit code. Long-running processes should use nohup/setsid and return.",
    inputSchema: obj(
      { ...COMPUTER_ARG, command: { type: "string" }, timeout_s: { type: "number" } },
      ["command"],
    ),
    run: async (ctx, args) => {
      resolveComputer(ctx, args.computer);
      const profile = effectiveProfile(ctx, args);
      const home = ctx.store.profileHome(profile.slug);
      return text(
        await runShell(args.command, home, args.timeout_s ?? 30, {
          HOME: home,
          AGENT_PROFILE: profile.slug,
          AGENT_WORKSPACE: home,
        }),
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
