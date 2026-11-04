// Sandbox verification for portal (NOT part of `npm test`).
// Run: npm run test:sandbox
//
// The smoke test covers workspace layout over MCP with the shell
// explicitly unsandboxed (test hosts have no bubblewrap). This script
// verifies the sandboxing itself:
//
//   A. Stub-bwrap probe: a fake `bwrap` on PATH records the exact argv,
//      cwd, and env the server builds, then runs the command. Proves the
//      flag sequence, the /tmp/workspace mapping, and the env contract.
//   B. Real-bwrap probe: when a real `bwrap` is installed, a sandboxed
//      shell must see a read-only root, a writable workspace, a hidden
//      real home, and /etc readable. Skipped when bwrap is absent.
//   C. Fail-closed probe: with no bwrap on PATH and no opt-out, the
//      shell must refuse to run with the install hint.
//   D. Mount probe: `unshare -rm` replays the mount order the flags
//      imply (ro root, workspace bind, tmpfs over home) and checks the
//      resulting visibility. Skipped when unshare is unavailable.
//
// Skips never fail. Exit 0 = all executed probes passed.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(HERE, "..");
const PORT = 19880;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let skips = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}
function skip(name, why) {
  skips++;
  console.log(`SKIP ${name} — ${why}`);
}

const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

async function bootServer(home, extraEnv) {
  const server = spawn(process.execPath, [path.join(APP, "src", "server.mjs")], {
    env: {
      ...process.env,
      PORTAL_HOST: "127.0.0.1",
      PORTAL_PORT: String(PORT),
      PORTAL_HOME: home,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { server, log: () => log };
}
async function stopServer(server) {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
}
async function rpc(token, msg) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(msg),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function makeBotToken(home) {
  const ownerToken = fs.readFileSync(path.join(home, "owner-token.txt"), "utf8").trim();
  const mk = await fetch(`${BASE}/api/ui/bots`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Dex" }),
  });
  const mkJson = await mk.json();
  return mkJson.plaintext;
}
const call = (token, name, args = {}) =>
  rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

// ---- A. stub-bwrap probe ----------------------------------------------------
{
  const wsRoot = "/tmp/workspace";
  let preExisting = null;
  try {
    preExisting = fs.statSync(wsRoot);
  } catch {
    /* absent */
  }
  // The stub probe needs /tmp/workspace to exist (it is the sandbox cwd the
  // server passes to execFile). Use it only if it is absent (create it)
  // or an empty directory; never touch a non-empty one.
  let proceed = true;
  let createdWsDir = false;
  if (preExisting && !preExisting.isDirectory()) {
    skip("stub-bwrap probe", "/tmp/workspace exists and is not a directory");
    proceed = false;
  } else if (preExisting && fs.readdirSync(wsRoot).length > 0) {
    skip("stub-bwrap probe", "/tmp/workspace exists and is non-empty; refusing to use it as a scratch dir");
    proceed = false;
  } else if (!preExisting) {
    try {
      fs.mkdirSync(wsRoot, { recursive: true });
      createdWsDir = true;
    } catch {
      skip("stub-bwrap probe", "cannot create /tmp/workspace on this host (no permission); the probe needs it as the sandbox cwd");
      proceed = false;
    }
  }
  if (proceed) {
    const created = createdWsDir;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sandbox-"));
    const stubBin = path.join(tmp, "bin");
    const stubLog = path.join(tmp, "stub-log.json");
    fs.mkdirSync(stubBin, { recursive: true });
    // Fake bwrap: logs argv/cwd/env, then runs the command with bash in
    // the REAL workspace (it cannot create the mount namespace).
    fs.writeFileSync(
      path.join(stubBin, "bwrap"),
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
const bashAt = argv.indexOf("bash");
const cmd = argv[bashAt + 2];
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({
  argv, cwd: process.cwd(),
  env: { HOME: process.env.HOME, AGENT_PROFILE: process.env.AGENT_PROFILE, AGENT_WORKSPACE: process.env.AGENT_WORKSPACE },
}));
const r = spawnSync("bash", ["-lc", cmd], { cwd: process.env.STUB_REAL_WORKSPACE, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
`,
      { mode: 0o755 },
    );
    const home = path.join(tmp, "portal-home");
    const { server } = await bootServer(home, {
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_LOG: stubLog,
    });
    try {
      const dexToken = await makeBotToken(home);
      const workspace = path.join(home, "profiles", "dex", "workspace");
      // The stub runs the command in the real workspace, whose path it
      // reads from the server env — so boot once more with it set.
      await stopServer(server);
      const booted = await bootServer(home, {
        PATH: `${stubBin}:${process.env.PATH}`,
        STUB_LOG: stubLog,
        STUB_REAL_WORKSPACE: workspace,
      });
      try {
        const ex = await call(dexToken, "terminal_exec", { command: "echo MARKER && pwd && echo HOME=$HOME && touch probe.txt" });
        const exJson = JSON.parse(ex.json.result.content[0].text);
        check("stub-bwrap: shell runs", exJson.code === 0 && /MARKER/.test(exJson.stdout), exJson.stdout.slice(0, 120));
        check("stub-bwrap: probe file lands in the real workspace", fs.existsSync(path.join(workspace, "probe.txt")));
        const logged = JSON.parse(fs.readFileSync(stubLog, "utf8"));
        const has = (...seq) => {
          let at = -1;
          for (const s of seq) {
            const i = logged.argv.indexOf(s, at + 1);
            if (i === -1) return false;
            at = i;
          }
          return true;
        };
        check("stub-bwrap: ro-bind / / first", has("--ro-bind", "/", "/"));
        check("stub-bwrap: workspace bound at /tmp/workspace", has("--bind", workspace, "/tmp/workspace"));
        check("stub-bwrap: tmpfs /tmp before the bind, proc and dev after", has("--tmpfs", "/tmp", "--bind", workspace, "/tmp/workspace") && has("--proc", "/proc", "--dev", "/dev"));
        check("stub-bwrap: real home hidden after the bind", logged.argv.indexOf("--tmpfs", logged.argv.indexOf("/tmp/workspace")) > logged.argv.indexOf("/tmp/workspace"));
        check("stub-bwrap: unshare-pid flag present", logged.argv.includes("--unshare-pid"));
        check("stub-bwrap: chdir /tmp/workspace then bash -lc", has("--chdir", "/tmp/workspace", "bash", "-lc"));
        check("stub-bwrap: cwd is /tmp/workspace", logged.cwd === "/tmp/workspace", logged.cwd);
        check("stub-bwrap: HOME and AGENT_WORKSPACE are /tmp/workspace", logged.env.HOME === "/tmp/workspace" && logged.env.AGENT_WORKSPACE === "/tmp/workspace", JSON.stringify(logged.env));
        check("stub-bwrap: AGENT_PROFILE is dex", logged.env.AGENT_PROFILE === "dex");
      } finally {
        await stopServer(booted.server);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (created) fs.rmdirSync(wsRoot);
    }
  }
}

// ---- B. real-bwrap probe ------------------------------------------------------
{
  const found = await run("sh", ["-c", "command -v bwrap"]);
  if (found.code !== 0 || !found.stdout.trim()) {
    skip("real-bwrap probe", "bwrap is not installed on this host (install it to run this probe)");
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sandbox-"));
    const home = path.join(tmp, "portal-home");
    const outerHome = process.env.HOME || "/";
    const { server } = await bootServer(home, { PROBE_OUTER_HOME: outerHome });
    try {
      const dexToken = await makeBotToken(home);
      const probe = [
        "echo PWD=$(pwd)",
        "echo HOME=$HOME WS=$AGENT_WORKSPACE",
        "touch probe.txt && echo WS_WRITABLE",
        "touch /etc/probe-should-fail 2>/dev/null && echo ROOT_WRITABLE || echo ROOT_RO",
        "cat /etc/hostname >/dev/null && echo ETC_READABLE",
        "test -e \"$PROBE_OUTER_HOME/.portal\" && echo HOME_LEAK || echo HOME_HIDDEN",
        "ls \"$PROBE_OUTER_HOME\" | head -1",
      ].join(" ; ");
      const ex = await call(dexToken, "terminal_exec", { command: probe });
      const exJson = JSON.parse(ex.json.result.content[0].text);
      const out = exJson.stdout;
      check("real-bwrap: shell runs in /tmp/workspace", exJson.code === 0 && /PWD=\/tmp\/workspace/.test(out), out.slice(0, 200));
      check("real-bwrap: workspace writable", /WS_WRITABLE/.test(out), out.slice(0, 200));
      check("real-bwrap: root read-only", /ROOT_RO/.test(out) && !/ROOT_WRITABLE/.test(out), out.slice(0, 200));
      check("real-bwrap: /etc readable", /ETC_READABLE/.test(out));
      check("real-bwrap: real home hidden", /HOME_HIDDEN/.test(out) && !/HOME_LEAK/.test(out), out.slice(0, 200));
      check("real-bwrap: probe file in workspace", fs.existsSync(path.join(home, "profiles", "dex", "workspace", "probe.txt")));
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---- C. fail-closed probe -----------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sandbox-"));
  const emptyBin = path.join(tmp, "emptybin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const home = path.join(tmp, "portal-home");
  // PATH with no bwrap (and no bash either — the fail-closed path must
  // return before ever execing a shell).
  const { server } = await bootServer(home, { PATH: emptyBin });
  try {
    const dexToken = await makeBotToken(home);
    const ex = await call(dexToken, "terminal_exec", { command: "echo hi" });
    const exJson = JSON.parse(ex.json.result.content[0].text);
    check("fail-closed: no bwrap means the shell refuses", exJson.code === 1 && /bubblewrap/.test(exJson.stderr), exJson.stderr.slice(0, 160));
  } finally {
    await stopServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- D. mount-order probe (unshare) -------------------------------------------
{
  const unshare = await run("sh", ["-c", "command -v unshare && unshare -rm true 2>/dev/null"]);
  if (unshare.code !== 0) {
    skip("mount-order probe", "unshare -rm is not permitted in this host environment");
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-mount-"));
    // Mirrors the bwrap flag order with mount-scoped read-only-ness:
    // the live tree stays writable, a second (bind) view of it is
    // remounted read-only, the workspace is bound from the LIVE view,
    // and only then is home hidden in the read-only view. (Remounting
    // the tmpfs superblock itself read-only would make every bind of
    // it read-only too — that is NOT what bwrap's --ro-bind does.)
    const script = `
set -eu
T="$1"
mount -t tmpfs tmpfs "$T"
mkdir -p "$T/home/user/.portal/profiles/dex/workspace" "$T/home/user/.ssh" "$T/stage" "$T/ro"
echo SECRET > "$T/home/user/.ssh/key"
echo DATA > "$T/home/user/.portal/profiles/dex/workspace/file.txt"
mount --bind "$T" "$T/ro"
mount -o remount,ro,bind "$T/ro"
mount --bind "$T/home/user/.portal/profiles/dex/workspace" "$T/stage"
mount -t tmpfs tmpfs "$T/ro/home/user"
test -w "$T/stage" && echo STAGE_WRITABLE
test -w "$T/ro" && echo ROOT_WRITABLE || echo ROOT_RO
test -e "$T/ro/home/user/.ssh/key" && echo HOME_LEAK || echo HOME_HIDDEN
cat "$T/stage/file.txt"
`;
    const r = await run("unshare", ["-rm", "sh", "-c", script, "sh", tmp]);
    check("mount probe: workspace bind stays writable", /STAGE_WRITABLE/.test(r.stdout), r.stdout + r.stderr);
    check("mount probe: root is read-only after ro-bind", /ROOT_RO/.test(r.stdout) && !/ROOT_WRITABLE/.test(r.stdout), r.stdout + r.stderr);
    check("mount probe: tmpfs over home hides the key", /HOME_HIDDEN/.test(r.stdout) && !/HOME_LEAK/.test(r.stdout), r.stdout + r.stderr);
    check("mount probe: bound file still readable", /DATA/.test(r.stdout), r.stdout + r.stderr);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? `\nSANDBOX PROBES PASSED (${skips} skipped)` : `\n${failures} SANDBOX PROBE(S) FAILED (${skips} skipped)`);
process.exit(failures === 0 ? 0 : 1);
