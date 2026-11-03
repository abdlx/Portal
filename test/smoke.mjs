// Smoke test for portal. Boots the real server on a scratch
// home dir and a scratch port, then checks the contract hob depends on.
// Browser tools are expected to fail cleanly when CloakBrowser is absent
// (the VM has no CloakBrowser unless installed); that failure message
// itself is asserted. Exit 0 = all pass, 1 = any fail.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  check("profile_current binds dex", JSON.parse(pc.json.result.content[0].text).profileSlug === "dex");

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

  // 8. fs confinement: escape attempt
  const esc = await call(dexToken, "fs_read", { path: "../../etc/passwd" });
  check("fs escape rejected", esc.json.result.isError === true);

  // 9. terminal_exec
  const ex = await call(dexToken, "terminal_exec", { command: "echo hi-$AGENT_PROFILE && pwd" });
  const exJson = JSON.parse(ex.json.result.content[0].text);
  check("terminal_exec runs in profile home", exJson.code === 0 && /hi-dex/.test(exJson.stdout) && exJson.stdout.includes("profiles/dex"));

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

  // 11. Browser tools fail CLEANLY without CloakBrowser (or work if present)
  const bs = await call(dexToken, "browser_snapshot");
  const bsText = bs.json.result.content[0].text;
  check(
    "browser_snapshot: installed works, missing errors clearly",
    bs.json.result.isError === true
      ? /not installed|license key/i.test(bsText)
      : /URL:/.test(bsText),
    bsText.slice(0, 120),
  );

  // 12. Revoked token -> 401 everywhere
  const bots = await fetch(`${BASE}/api/ui/bots`, { headers: { authorization: `Bearer ${ownerToken}` } });
  const botsJson = await bots.json();
  const dexBot = botsJson.bots.find((b) => b.slug === "dex");
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
