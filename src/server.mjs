// portal server: MCP + REST + desktop control panel.
// Speaks the exact surface hob's Agent Computer bridge consumes:
//   POST /mcp            JSON-RPC (initialize / tools/list / tools/call,
//                        bare tools/call with NO prior initialize, as the
//                        panel sends it)
//   GET  /api/computers, GET /api/computers/:id,
//   POST /api/computers/:id/wake|sleep   (REST fallback, same Bearer auth)
//   GET  /api/computers/:id/vnc   WebSocket upgrade, RFB byte pipe to the
//                        profile's Xvnc display (same endpoint and bindings
//                        as Agent Computer: Bearer header or ?token=, the
//                        noVNC client speaks RFB over it with the 'binary'
//                        subprotocol)
//   GET  /ui/            desktop control panel (owner token)
//   GET  /ui/view        live viewer page (noVNC client, token in query)
//   /api/ui/*            panel API (owner token only)
// Security model: Tailscale-only binding + Bearer tokens. There are no
// scoped public endpoints. The server binds PORTAL_HOST
// (default 127.0.0.1; the installer sets the Tailscale IP) — binding is
// done here in code, never by a proxy flag.
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RfbClientFilter } from "./rfb-control.mjs";
import { CredentialVault } from "./credential-vault.mjs";
import { Store, hashToken } from "./store.mjs";
import { BrowserManager, browserInfo, resetBrowserCache } from "./browser.mjs";
import { TOOLS, toolByName, hasScope, text, errText, shellSandboxStatus, getSystemHeadroom } from "./tools.mjs";
import { validateArgs } from "./validate.mjs";

const VERSION = "0.1.0";
const HOST = process.env.PORTAL_HOST || "127.0.0.1";
const PORT = Number(process.env.PORTAL_PORT || 9879);
const RATE_PER_MIN = Number(process.env.LAPTOP_MCP_RATE_PER_MIN || 600);
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const MAX_BODY = 2 * 1024 * 1024;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const UI_FILE = path.join(APP_DIR, "ui", "index.html");
const VIEW_FILE = path.join(APP_DIR, "ui", "view.html");
const NOVNC_DIR = path.join(APP_DIR, "node_modules", "@novnc", "novnc");

const store = new Store();
const browser = new BrowserManager(store);
const credentialVault = new CredentialVault(store);
// Human takeover blocks both agent browser tools and unauthorized VNC input.
const humanLeases = new Map(); // profile slug -> owner token ID
function isHumanControlled(slug) { return humanLeases.has(slug); }

// ---- rate limiting (per-token sliding window, like Agent Computer) -------
const windows = new Map();
function rateLimited(token) {
  const now = Date.now();
  const arr = (windows.get(token.id) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_PER_MIN) {
    windows.set(token.id, arr);
    return true;
  }
  arr.push(now);
  windows.set(token.id, arr);
  return false;
}

// ---- auth ------------------------------------------------------------------
function authenticate(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const t = store.tokenByHash(hashToken(m[1].trim()));
  if (!t || t.revoked) return null;
  t.lastUsedAt = Date.now();
  return t;
}

function isTokenActive(token) {
  const t = store.data.tokens.find((x) => x.id === token.id);
  return !!t && !t.revoked;
}

// The VNC endpoint accepts the token the way Agent Computer's does:
// Authorization: Bearer <token> OR ?token=<token> in the query string.
// hob's viewer sends it in the query (direct URL) and hob's proxy
// forwards it the same way, so both must work.
function authenticateUpgrade(req, u) {
  const t = authenticate(req);
  if (t) return t;
  const q = u.searchParams.get("token");
  if (!q) return null;
  const row = store.tokenByHash(hashToken(q.trim()));
  if (!row || row.revoked) return null;
  row.lastUsedAt = Date.now();
  return row;
}

// Persist lastUsedAt at most every 30s; audit writes are append-only.
setInterval(() => store.save(), 30000).unref();

// ---- helpers ---------------------------------------------------------------
function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) {
        const e = new Error("request body too large");
        e.code = 413;
        reject(e);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

const rpcResult = (result, id, extraHeaders) => ({
  jsonrpc: "2.0",
  result,
  id: id ?? null,
});
const rpcError = (code, message, id) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: id ?? null,
});

async function handleMcp(req, res, token, msg) {
  const id = msg?.id;
  const method = msg?.method;
  // Notifications: no reply (202, empty), per JSON-RPC.
  if (id === undefined || id === null || String(method || "").startsWith("notifications/")) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (rateLimited(token)) {
    sendJson(res, 429, rpcError(-32029, "rate limit exceeded for this token", id));
    return;
  }
  try {
    switch (method) {
      case "initialize": {
        const params = msg.params ?? {};
        const version =
          params.protocolVersion && PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : "2025-03-26";
        sendJson(
          res,
          200,
          rpcResult(
            {
              protocolVersion: version,
              capabilities: { tools: {} },
              serverInfo: { name: "portal", version: VERSION },
            },
            id,
          ),
          { "mcp-session-id": crypto.randomBytes(16).toString("hex") },
        );
        return;
      }
      case "ping":
        sendJson(res, 200, rpcResult({}, id));
        return;
      case "tools/list":
        sendJson(
          res,
          200,
          rpcResult(
            {
              tools: TOOLS.filter((t) => hasScope(token, t.scope)).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
            id,
          ),
        );
        return;
      case "tools/call": {
        const params = msg.params ?? {};
        const def = params.name ? toolByName.get(params.name) : undefined;
        if (!def) {
          sendJson(res, 200, rpcError(-32602, `unknown tool: ${params.name}`, id));
          return;
        }
        if (!hasScope(token, def.scope)) {
          sendJson(
            res,
            200,
            rpcResult(errText(`this token lacks the '${def.scope}' scope required by ${def.name}`), id),
          );
          return;
        }
        store.audit({
          kind: "mcp.call",
          tool: def.name,
          token: token.name,
          computer: params.arguments?.computer ?? token.computerId ?? null,
        });
        const ctx = {
          store,
          browser,
          credentialVault,
          token,
          isTokenActive: () => isTokenActive(token),
        };
        try {
          validateArgs(def.inputSchema, params.arguments ?? {});
          if (!isTokenActive(token)) throw new Error("token was revoked");
          if (def.name.startsWith("browser_") && !token.scopes.includes("admin")) {
            const slug = token.profileSlug || params.arguments?.profile || "default";
            if (isHumanControlled(slug)) throw new Error("Human takeover active; wait until control is handed back.");
          }
          const result = await def.run(ctx, params.arguments ?? {});
          sendJson(res, 200, rpcResult(result, id));
        } catch (e) {
          sendJson(res, 200, rpcResult(errText(e.message), id));
        }
        return;
      }
      default:
        sendJson(res, 200, rpcError(-32601, `method not found: ${method}`, id));
        return;
    }
  } catch (e) {
    sendJson(res, 200, rpcError(-32603, e.message, id));
  }
}

// ---- REST fallback (hob's bridge uses these when MCP errors) ---------------
async function handleRest(req, res, token, parts) {
  if (rateLimited(token)) {
    sendJson(res, 429, { error: "rate limit exceeded for this token" });
    return;
  }
  const row = store.data.computer;
  const computerObj = {
    id: row.id,
    name: row.name,
    state: "ready",
    isShared: true,
    profileCount: store.profiles().length,
  };
  if (req.method === "GET" && parts.length === 2) {
    sendJson(res, 200, [computerObj]);
    return;
  }
  if (req.method === "GET" && parts.length === 3) {
    const id = decodeURIComponent(parts[2]);
    if (id !== row.id && id !== row.name) {
      sendJson(res, 404, { error: `computer not found: ${id}` });
      return;
    }
    sendJson(res, 200, {
      ...computerObj,
      health: { ready: true, profiles: store.profiles().length },
    });
    return;
  }
  if (req.method === "POST" && parts.length === 4 && (parts[3] === "wake" || parts[3] === "sleep")) {
    const id = decodeURIComponent(parts[2]);
    if (id !== row.id && id !== row.name) {
      sendJson(res, 404, { error: `computer not found: ${id}` });
      return;
    }
    try {
      await readJsonBody(req);
    } catch {
      /* body optional */
    }
    sendJson(res, 200, { id: row.id, state: "ready" });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

// ---- desktop panel API (owner token only) ----------------------------------
const installJobs = new Map();

function requireOwner(res, token) {
  if (!token || !token.scopes.includes("admin")) {
    sendJson(res, 401, { error: "owner token required" });
    return false;
  }
  return true;
}

async function handleUiApi(req, res, token, parts) {
  if (!requireOwner(res, token)) return;
  const seg = parts.slice(2); // after /api/ui
  try {
    if (seg.length >= 2 && seg[0] === "vault" && seg.length <= 3) {
      const profile = store.profileBySlug(seg[1]);
      if (!profile) return sendJson(res, 404, { error: "profile not found" });
      if (seg.length === 2 && req.method === "GET")
        return sendJson(res, 200, { profile: profile.slug, items: credentialVault.list(profile) });
      if (seg.length === 2 && req.method === "POST") {
        // Never accept plaintext passwords over an insecure remote connection.
        const host = (req.socket.localAddress || "").replace(/^::ffff:/, "");
        const local = req.socket.remoteAddress === req.socket.localAddress ||
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
        const secure = !!req.socket.encrypted;
        if (!local && !secure) return sendJson(res, 403, { error: "Saving passwords requires localhost or HTTPS; never submit secrets over plain LAN HTTP" });
        const item = credentialVault.add(profile, await readJsonBody(req));
        store.audit({ kind: "credential.add", profile: profile.slug, itemId: item.id, origin: item.origin });
        return sendJson(res, 201, { item });
      }
      if (seg.length === 3 && req.method === "DELETE") {
        const result = credentialVault.remove(profile, seg[2]);
        store.audit({ kind: "credential.delete", profile: profile.slug, itemId: seg[2] });
        return sendJson(res, 200, result);
      }
    }
    if (seg.length === 2 && seg[0] === "viewer-control") {
      const slug = seg[1];
      if (!store.profileBySlug(slug)) return sendJson(res, 404, { error: "profile not found" });
      if (req.method === "GET") return sendJson(res, 200, { profile: slug, mode: isHumanControlled(slug) ? "human" : "agent" });
      if (req.method === "POST") {
        const { mode } = await readJsonBody(req);
        if (mode !== "human" && mode !== "agent") return sendJson(res, 400, { error: "mode must be human or agent" });
        if (mode === "human") humanLeases.set(slug, token.id);
        else humanLeases.delete(slug);
        store.audit({ kind: "vnc.control", profile: slug, mode });
        return sendJson(res, 200, { profile: slug, mode });
      }
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "status") {
      sendJson(res, 200, {
        name: "portal",
        version: VERSION,
        host: HOST,
        port: PORT,
        tailscaleIp: process.env.PORTAL_TAILSCALE_IP || null,
        computer: store.data.computer,
        profiles: store.profiles().length,
        browser: await browserInfo(),
        shell: shellSandboxStatus(),
        headroom: getSystemHeadroom(),
        uptimeSec: Math.floor(process.uptime()),
      });
      return;
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "bots") {
      const bots = [];
      for (const p of store.profiles()) {
        const st = await browser.status(p).catch(() => ({ started: false }));
        bots.push({
          ...p,
          tokens: store.tokensForProfile(p.id).map((t) => store.tokenPublic(t)),
          browserStarted: !!st.started,
          browserUrl: st.url || null,
          home: store.profileHome(p.slug),
          workspace: store.profileWorkspace(p.slug),
        });
      }
      sendJson(res, 200, { bots });
      return;
    }
    if (req.method === "POST" && seg.length === 1 && seg[0] === "bots") {
      const body = await readJsonBody(req);
      const profile = store.createProfile({
        name: body.name,
        slug: body.slug,
        description: body.description,
      });
      const { token: tok, plaintext } = store.newBotToken(profile);
      store.audit({ kind: "ui.create-bot", profile: profile.slug });
      // The bot's isolated browser profile (directory + pinned fingerprint)
      // is created NOW, in the same request — no manual step, no waiting
      // for the first browser launch. If the fingerprint model is
      // unreachable, preparation reports not-ready and the first
      // browser_start draws it lazily instead; bot creation never fails
      // on preparation.
      let browserProfile;
      try {
        browserProfile = { ready: true, ...(await browser.prepare(profile)) };
      } catch (e) {
        browserProfile = {
          ready: false,
          browserProfileDir: store.browserProfileDir(profile.slug),
          error: e.message,
        };
      }
      sendJson(res, 201, { profile, token: store.tokenPublic(tok), plaintext, browserProfile });
      return;
    }
    if (req.method === "POST" && seg.length === 3 && seg[0] === "bots" && seg[2] === "token") {
      const profile = store.profileById(seg[1]);
      if (!profile) {
        sendJson(res, 404, { error: "profile not found" });
        return;
      }
      const { token: tok, plaintext } = store.newBotToken(profile);
      sendJson(res, 201, { token: store.tokenPublic(tok), plaintext });
      return;
    }
    if (req.method === "POST" && seg.length === 3 && seg[0] === "bots" && seg[2] === "rotate") {
      const profile = store.profileById(seg[1]);
      if (!profile) {
        sendJson(res, 404, { error: "profile not found" });
        return;
      }
      for (const t of store.tokensForProfile(profile.id)) store.revokeToken(t.id);
      const { token: tok, plaintext } = store.newBotToken(profile);
      sendJson(res, 201, { token: store.tokenPublic(tok), plaintext });
      return;
    }
    if (req.method === "GET" && seg.length === 4 && seg[0] === "bots" && seg[2] === "token") {
      const plaintext = store.revealToken(seg[3]);
      if (plaintext === null) {
        sendJson(res, 404, { error: "token not found" });
        return;
      }
      sendJson(res, 200, { plaintext });
      return;
    }
    if (req.method === "POST" && seg.length === 4 && seg[0] === "bots" && seg[2] === "revoke") {
      const t = store.revokeToken(seg[3]);
      sendJson(res, 200, { token: store.tokenPublic(t) });
      return;
    }
    if (req.method === "PATCH" && seg.length === 2 && seg[0] === "bots") {
      const body = await readJsonBody(req);
      const p = store.updateProfile(seg[1], {
        name: body.name,
        description: body.description,
        isDefault: body.isDefault,
      });
      sendJson(res, 200, { profile: p });
      return;
    }
    if (req.method === "DELETE" && seg.length === 2 && seg[0] === "bots") {
      const profile = store.profileById(seg[1]);
      if (!profile) {
        sendJson(res, 404, { error: "profile not found" });
        return;
      }
      await browser.close(profile).catch(() => {});
      const result = store.deleteProfile(seg[1]);
      sendJson(res, 200, result);
      return;
    }
    if (
      req.method === "POST" &&
      seg.length === 3 &&
      seg[0] === "browser" &&
      (seg[2] === "start" || seg[2] === "close")
    ) {
      const profile = store.profileBySlug(seg[1]);
      if (!profile) {
        sendJson(res, 404, { error: "profile not found" });
        return;
      }
      if (seg[2] === "start") {
        await browser.ensure(profile);
        sendJson(res, 200, await browser.status(profile));
      } else {
        sendJson(res, 200, await browser.close(profile));
      }
      return;
    }
    if (req.method === "POST" && seg.length === 1 && seg[0] === "install-browser") {
      if ([...installJobs.values()].some((j) => j.state === "running")) {
        sendJson(res, 409, { error: "an install is already running" });
        return;
      }
      const id = `job_${crypto.randomBytes(4).toString("hex")}`;
      const logFile = path.join(store.home, "install.log");
      const job = { id, state: "running", startedAt: Date.now(), log: [] };
      installJobs.set(id, job);
      const out = fs.createWriteStream(logFile, { flags: "a" });
      const child = spawn("bash", ["-lc", "npm install && npx camoufox fetch"], {
        cwd: APP_DIR,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => {
        const line = d.toString();
        job.log.push(line);
        if (job.log.length > 200) job.log.shift();
        out.write(line);
      });
      child.stderr.on("data", (d) => {
        const line = d.toString();
        job.log.push(line);
        if (job.log.length > 200) job.log.shift();
        out.write(line);
      });
      child.on("close", (code) => {
        job.state = code === 0 ? "done" : "failed";
        job.code = code;
        job.finishedAt = Date.now();
        out.end();
        if (code === 0) resetBrowserCache();
      });
      child.on("error", (e) => {
        job.state = "failed";
        job.error = e.message;
        out.end();
      });
      sendJson(res, 202, { id, state: "running" });
      return;
    }
    if (req.method === "GET" && seg.length === 2 && seg[0] === "install-browser") {
      const job = installJobs.get(seg[1]);
      if (!job) {
        sendJson(res, 404, { error: "job not found" });
        return;
      }
      sendJson(res, 200, job);
      return;
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "audit") {
      let lines = [];
      try {
        const raw = fs.readFileSync(store.auditFile, "utf8");
        lines = raw.trim().split("\n").slice(-100).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      } catch {
        lines = [];
      }
      sendJson(res, 200, { entries: lines });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    const status = e.code === 409 ? 409 : 400;
    sendJson(res, status, { error: e.message });
  }
}

// ---- HTTP entry ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const parts = u.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/ui")) {
      res.writeHead(302, { location: "/ui/" });
      res.end();
      return;
    }
    if (req.method === "GET" && u.pathname === "/ui/") {
      const html = await fs.promises.readFile(UI_FILE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && u.pathname === "/ui/view") {
      // Token rides in the query string (a full-page navigation cannot
      // set an Authorization header); the WebSocket connection itself
      // carries the token and is what gets authenticated.
      const html = await fs.promises.readFile(VIEW_FILE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && parts[0] === "novnc") {
      // Static files for the noVNC client used by /ui/view. Only files
      // inside the installed @novnc/novnc package are servable.
      const rel = parts.slice(1).join("/");
      const file = path.resolve(NOVNC_DIR, rel);
      if (!file.startsWith(NOVNC_DIR + path.sep) || rel.includes("..")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      try {
        const data = await fs.promises.readFile(file);
        const type = file.endsWith(".js") || file.endsWith(".mjs")
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : file.endsWith(".html")
              ? "text/html; charset=utf-8"
              : "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(data);
      } catch {
        sendJson(res, 404, { error: "not found" });
      }
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, name: "portal", version: VERSION });
      return;
    }
    if (parts[0] === "api" && parts[1] === "ui") {
      const token = authenticate(req);
      await handleUiApi(req, res, token, parts);
      return;
    }
    if (u.pathname === "/mcp" && req.method === "POST") {
      const token = authenticate(req);
      if (!token) {
        sendJson(res, 401, rpcError(-32001, "unauthorized: valid MCP token required", null));
        return;
      }
      let msg;
      try {
        msg = await readJsonBody(req);
      } catch (e) {
        if (e.code === 413) {
          sendJson(res, 413, rpcError(-32700, "request body too large", null));
        } else {
          sendJson(res, 400, rpcError(-32700, "parse error", null));
        }
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || !msg.method) {
        sendJson(res, 400, rpcError(-32600, "invalid request", msg?.id ?? null));
        return;
      }
      await handleMcp(req, res, token, msg);
      return;
    }
    if (parts[0] === "api" && parts[1] === "computers") {
      const token = authenticate(req);
      if (!token) {
        sendJson(res, 401, { error: "unauthorized: valid MCP token required" });
        return;
      }
      await handleRest(req, res, token, parts);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[portal] listening on http://${HOST}:${PORT} (MCP /mcp, panel /ui/) home=${store.home}`,
  );
  console.log(`[portal] shell sandbox: ${shellSandboxStatus()}`);
});

// ---- live view (noVNC) WebSocket proxy ------------------------------------
// GET /api/computers/:id/vnc — the same endpoint and bindings Agent
// Computer exposes: Bearer header or ?token=, the 'binary' WebSocket
// subprotocol, then the raw RFB byte stream. Portal never terminates
// the RFB stream: bytes pipe straight to the profile's Xvnc display,
// exactly like Agent Computer's control plane pipes to its guest VNC
// bridge. Connecting starts (or promotes) that profile's browser
// headed, the way Agent Computer wakes the computer on viewer connect.
// Which profile is shown is decided by the token: a profile-bound
// token always shows its own profile; the owner token selects one via
// ?profile= (default "default"). That is what makes per-bot views work
// through hob's viewer — each bot profile connects with its own token.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (protocols.has("binary")) return "binary";
    const first = [...protocols][0];
    return first || false;
  },
});

server.on("upgrade", async (req, socket, head) => {
  const fail = (code, msg) => {
    try {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      /* gone */
    }
    socket.destroy();
  };
  let u;
  try {
    u = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return fail(400, "Bad Request");
  }
  const m = /^\/api\/computers\/([^/]+)\/vnc$/.exec(u.pathname);
  if (!m) return fail(404, "Not Found");
  const token = authenticateUpgrade(req, u);
  if (!token) return fail(401, "Unauthorized");
  let computerId;
  try {
    computerId = decodeURIComponent(m[1]);
  } catch {
    return fail(400, "Bad Request");
  }
  if (computerId !== "portal") return fail(404, "Not Found");
  // Bound tokens show their own profile even if ?profile= says otherwise.
  const slug = token.profileSlug || u.searchParams.get("profile") || "default";
  const profile = store.profileBySlug(slug);
  if (!profile) return fail(404, "Not Found");
  let headed;
  try {
    headed = await browser.ensureHeaded(profile);
  } catch (e) {
    console.warn(`[vnc] headed start failed for ${slug}: ${e.message}`);
    return fail(502, "Bad Gateway");
  }
  store.audit({ kind: "vnc.open", profile: profile.slug });
  wss.handleUpgrade(req, socket, head, (ws) => {
    const upstream = net.connect(headed.port, "127.0.0.1");
    // No input without explicit owner takeover, even from custom VNC clients.
    const inputFilter = new RfbClientFilter(() =>
      token.scopes.includes("admin") && humanLeases.get(slug) === token.id
    );
    browser.viewerConnected(profile);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      browser.viewerDisconnected(profile);
      try {
        upstream.destroy();
      } catch {
        /* gone */
      }
      try {
        ws.close();
      } catch {
        /* gone */
      }
    };
    upstream.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(chunk, { binary: true });
        } catch {
          cleanup();
        }
      }
    });
    ws.on("message", (data) => {
      browser.viewerActivity(profile);
      try {
        for (const chunk of inputFilter.push(data)) upstream.write(chunk);
      } catch (err) {
        console.warn(`[vnc] rejected client input: ${err.message}`);
        cleanup();
      }
    });
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    upstream.on("close", cleanup);
    upstream.on("error", (err) => {
      console.warn(`[vnc-upstream-error] profile=${profile.slug}: ${err.message}`);
      cleanup();
    });
  });
});

async function shutdown(signal) {
  console.log(`[portal] ${signal}, closing browsers…`);
  browser.stopIdleCleanup();
  try {
    for (const p of store.profiles()) {
      await browser.close(p).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  store.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
