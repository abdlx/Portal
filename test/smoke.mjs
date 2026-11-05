// Smoke test for portal. Boots the real server on a scratch
// home dir and a scratch port, then checks the contract hob depends on.
// Browser tools use the real Camoufox engine when installed; when it is
// absent they must fail cleanly with the not-installed message, which is
// itself asserted. Exit 0 = all pass, 1 = any fail.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lc-smoke-"));
const PORT = 19879;
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(HERE, "..");

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

const server = spawn("node", [path.join(APP, "src", "server.mjs")], {
  env: {
    ...process.env,
    PORTAL_HOST: "127.0.0.1",
    PORTAL_PORT: String(PORT),
    PORTAL_HOME: HOME,
    // The sandbox itself is verified separately (unshare mount probe +
    // stub/real bwrap harness). This VM has no bubblewrap, and the shell
    // fails closed without it, so the smoke run uses the documented
    // owner opt-out: the shell runs unsandboxed, still rooted at the
    // workspace. Never set this in production.
    PORTAL_ALLOW_UNSANDBOXED_SHELL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitHealth(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function rpc(token, msg) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(msg),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const call = (token, name, args = {}) =>
  rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

try {
  check("server starts", await waitHealth(), serverLog.slice(-500));

  const ownerToken = fs.readFileSync(path.join(HOME, "owner-token.txt"), "utf8").trim();
  check("owner token file exists", ownerToken.startsWith("portal_owner_"));

  // 1. No token -> 401
  const noAuth = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  check("MCP without token -> 401", noAuth.status === 401);

  // 2. Owner creates a bot via the panel API
  const mk = await fetch(`${BASE}/api/ui/bots`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Dex" }),
  });
  const mkJson = await mk.json();
  check("panel creates bot Dex", mk.status === 201 && mkJson.profile?.slug === "dex", JSON.stringify(mkJson).slice(0, 200));
  const dexToken = mkJson.plaintext;
  check("bot token issued", typeof dexToken === "string" && dexToken.startsWith("portal_"));
  check("bot creation auto-creates browser profile", typeof mkJson.browserProfile?.browserProfileDir === "string" && typeof mkJson.browserProfile?.ready === "boolean", JSON.stringify(mkJson.browserProfile));
  check("browser profile dir exists on disk", fs.existsSync(path.join(HOME, "profiles", "dex", "browser-profile")));
  check("bot creation auto-creates workspace + downloads", fs.existsSync(path.join(HOME, "profiles", "dex", "workspace")) && fs.existsSync(path.join(HOME, "profiles", "dex", "workspace", "downloads")));

  // 3. initialize + tools/list (scope filtering: no admin tools for bot)
  const init = await rpc(dexToken, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  check("initialize negotiates version", init.json?.result?.protocolVersion === "2025-03-26");
  check("serverInfo name", init.json?.result?.serverInfo?.name === "portal");
  const list = await rpc(dexToken, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const names = (list.json?.result?.tools || []).map((t) => t.name);
  check("tools/list has computer_list + batch", names.includes("computer_list") && names.includes("batch"));
  check("tools/list hides admin tools from bot token", !names.includes("computer_create"));

  // 4. Bare tools/call with NO prior initialize (the panel path)
  const cl = await call(dexToken, "computer_list");
  const computers = JSON.parse(cl.json.result.content[0].text);
  check("computer_list returns [portal]", Array.isArray(computers) && computers[0]?.id === "portal", JSON.stringify(computers).slice(0, 120));

  const st = await call(dexToken, "computer_status");
  check("computer_status ready", JSON.parse(st.json.result.content[0].text).state === "ready");

  const pc = await call(dexToken, "profile_current");
  const pcJson = JSON.parse(pc.json.result.content[0].text);
  check("profile_current binds dex", pcJson.profileSlug === "dex");
  check("profile_current reports workspace", pcJson.workspace === path.join(HOME, "profiles", "dex", "workspace"), pcJson.workspace);

  // 5. Cross-profile rejection BEFORE any work
  const cross = await call(dexToken, "fs_list", { profile: "kai", path: "." });
  check(
    "bound token acting as another profile is rejected",
    cross.json.result.isError === true && /bound to profile dex/.test(cross.json.result.content[0].text),
    cross.json.result.content[0].text.slice(0, 120),
  );

  // 6. Unknown argument rejected
  const unk = await call(dexToken, "fs_list", { bogus: 1 });
  check("unknown argument rejected", unk.json.result.isError === true);

  // 7. Batch: write + read, then stop-on-error
  const batch = await call(dexToken, "batch", {
    steps: [
      { tool: "fs_write", args: { path: "hello.txt", content: "MANGO-9" } },
      { tool: "fs_read", args: { path: "hello.txt" } },
    ],
  });
  const bres = JSON.parse(batch.json.result.content[0].text);
  const readBack = JSON.parse(bres.steps[1].result[0].text);
  check("batch write+read round-trips", readBack.content === "MANGO-9", JSON.stringify(bres).slice(0, 200));
  check("fs_write lands in the workspace on disk", fs.readFileSync(path.join(HOME, "profiles", "dex", "workspace", "hello.txt"), "utf8") === "MANGO-9");
  check("fs_write does not leak into the profile home", !fs.existsSync(path.join(HOME, "profiles", "dex", "hello.txt")));

  // 8. fs confinement: escape attempts, including the sibling
  // browser-profile directory (one level up from the workspace)
  const esc = await call(dexToken, "fs_read", { path: "../../etc/passwd" });
  check("fs escape rejected", esc.json.result.isError === true);
  const esc2 = await call(dexToken, "fs_read", { path: "../browser-profile" });
  check("fs escape to browser profile rejected", esc2.json.result.isError === true);

  // 9. terminal_exec
  const ex = await call(dexToken, "terminal_exec", { command: "echo hi-$AGENT_PROFILE && pwd" });
  const exJson = JSON.parse(ex.json.result.content[0].text);
  check("terminal_exec runs in the workspace", exJson.code === 0 && /hi-dex/.test(exJson.stdout) && exJson.stdout.includes(path.join("profiles", "dex", "workspace")), exJson.stdout.slice(0, 160));

  // 10. REST fallback
  const rest = await fetch(`${BASE}/api/computers`, { headers: { authorization: `Bearer ${dexToken}` } });
  const restJson = await rest.json();
  check("REST GET /api/computers returns array", Array.isArray(restJson) && restJson[0]?.id === "portal");
  const wake = await fetch(`${BASE}/api/computers/portal/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${dexToken}`, "content-type": "application/json" },
    body: "{}",
  });
  check("REST wake returns ready", (await wake.json()).state === "ready");

  // 11. Browser tools: real Camoufox launch when installed, clean error when not
  const bs = await call(dexToken, "browser_snapshot");
  const bsText = bs.json.result.content[0].text;
  const browserAvailable = bs.json.result.isError !== true;
  check(
    "browser_snapshot: installed works, missing errors clearly",
    browserAvailable ? /URL:/.test(bsText) : /not installed/i.test(bsText),
    bsText.slice(0, 120),
  );

  const bshot = await call(dexToken, "browser_screenshot");
  const bshotText = bshot.json.result.content[0].text;
  check(
    "browser_screenshot: installed works, missing errors clearly",
    browserAvailable ? /ok/.test(bshotText) : /not installed/i.test(bshotText),
    bshotText.slice(0, 120),
  );

  // 12. Multiple tabs (only when the browser is installed)
  if (browserAvailable) {
    const t2 = await call(dexToken, "browser_tab_new", { url: "data:text/html,<h1>Tab Two</h1>" });
    const t2Json = JSON.parse(t2.json.result.content[0].text);
    check("browser_tab_new opens tab2", t2Json.tab === "tab2", JSON.stringify(t2Json).slice(0, 120));
    const tl = await call(dexToken, "browser_tab_list");
    const tlJson = JSON.parse(tl.json.result.content[0].text);
    check("browser_tab_list shows 2 tabs, tab2 active", tlJson.tabs.length === 2 && tlJson.activeTab === "tab2", JSON.stringify(tlJson).slice(0, 160));
    const sw = await call(dexToken, "browser_tab_switch", { tab: "tab1" });
    check("browser_tab_switch returns to tab1", JSON.parse(sw.json.result.content[0].text).tab === "tab1");
    const nt = await call(dexToken, "browser_navigate", { url: "data:text/html,<h1>Tab Three</h1>", newTab: true });
    const ntJson = JSON.parse(nt.json.result.content[0].text);
    check("browser_navigate newTab opens a tab", typeof ntJson.tab === "string" && ntJson.tab !== "tab1", JSON.stringify(ntJson).slice(0, 120));
    const cl = await call(dexToken, "browser_tab_close", { tab: ntJson.tab });
    check("browser_tab_close closes the new tab", JSON.parse(cl.json.result.content[0].text).closed === true);
    const tl2 = await call(dexToken, "browser_tab_list");
    const tl2Json = JSON.parse(tl2.json.result.content[0].text);
    check("tab3 closed, tab1 + tab2 remain", tl2Json.tabs.length === 2 && tl2Json.tabs.some((t) => t.tab === "tab1") && tl2Json.tabs.some((t) => t.tab === "tab2"), JSON.stringify(tl2Json).slice(0, 160));
  } else {
    console.log("SKIP tab checks — browser not installed");
  }

  // 11b. Live viewer surface: upgrade without a token -> 401, the
  // viewer page and the noVNC client serve. The full RFB handshake,
  // frames and input are covered by the VNC probe; smoke stays
  // host-independent and needs no Xvnc.
  const upgradeStatus = (url) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, ["binary"]);
      ws.once("open", () => {
        ws.close();
        resolve("open");
      });
      ws.once("unexpected-response", (_req, res) => resolve(`HTTP ${res.statusCode}`));
      ws.once("error", (e) => resolve(`ERR ${e.message}`));
    });
  check(
    "VNC upgrade without token is 401",
    (await upgradeStatus(`ws://127.0.0.1:${PORT}/api/computers/portal/vnc`)) === "HTTP 401",
  );
  const viewRes = await fetch(`${BASE}/ui/view`);
  check("viewer page serves with RFB import", viewRes.ok && (await viewRes.text()).includes("/novnc/core/rfb.js"));
  const rfbRes = await fetch(`${BASE}/novnc/core/rfb.js`);
  check("noVNC rfb.js serves", rfbRes.ok && (await rfbRes.text()).includes("class RFB"));

  // 12. Revoked token -> 401 everywhere
  const bots = await fetch(`${BASE}/api/ui/bots`, { headers: { authorization: `Bearer ${ownerToken}` } });
  const botsJson = await bots.json();
  const dexBot = botsJson.bots.find((b) => b.slug === "dex");
  check("panel lists workspace path per bot", dexBot?.workspace === path.join(HOME, "profiles", "dex", "workspace"), dexBot?.workspace);
  const tokId = dexBot.tokens[0].id;
  await fetch(`${BASE}/api/ui/bots/x/revoke/${tokId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const after = await rpc(dexToken, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
  check("revoked token -> 401", after.status === 401);
} catch (e) {
  console.log("FAIL exception:", e);
  failures++;
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} SMOKE TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
