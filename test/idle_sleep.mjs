// Tests browser hibernation without starting Camoufox.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserManager } from "../src/browser.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-idle-"));
const profile = { slug: "agent" };
const store = {
  profileHome: () => dir,
  profileBySlug: (slug) => slug === "agent" ? profile : null,
};
const manager = new BrowserManager(store);
const page1 = { url: () => "https://example.com/one", on: () => {} };
const page2 = { url: () => "https://example.com/two", on: () => {} };
let closed = 0;
const entry = {
  context: { pages: () => [page1, page2], close: async () => { closed++; } },
  page: page2, active: page2, refs: new Map(), chain: Promise.resolve(),
  tabs: new Map([[page1, "tab1"], [page2, "tab2"]]),
  tabCounter: 2, refMaps: new Map(), tabMeta: new Map(),
  headed: false, display: null, lastActivityAt: Date.now() - 31 * 60_000,
  pendingOps: 0, viewers: 0,
};
manager.contexts.set(profile.slug, entry);
try {
  manager.viewerConnected(profile);
  assert.deepEqual(await manager.sleepIdleBrowsers(), [], "viewer prevents sleep");
  assert.equal(closed, 0);
  manager.viewerDisconnected(profile);
  entry.lastActivityAt = Date.now() - 31 * 60_000;
  entry.pendingOps = 1;
  assert.deepEqual(await manager.sleepIdleBrowsers(), [], "active operations prevent sleep");
  entry.pendingOps = 0;
  entry.lastActivityAt = Date.now() - 31 * 60_000;
  assert.deepEqual(await manager.sleepIdleBrowsers(), ["agent"], "idle profile sleeps");
  assert.equal(closed, 1, "context process was closed");
  assert.equal(manager.contexts.has("agent"), false, "entry released");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "open-tabs.json"), "utf8"));
  assert.deepEqual(state.tabs, ["https://example.com/one", "https://example.com/two"]);
  assert.equal(state.activeIndex, 1);
  console.log("PASS idle browser hibernation, viewer guard, operation guard, tab checkpoint");
} finally {
  manager.stopIdleCleanup();
  fs.rmSync(dir, { recursive: true, force: true });
}
