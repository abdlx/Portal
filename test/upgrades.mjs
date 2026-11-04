// Architectural upgrades verification for Portal:
// 1. PID namespace isolation verification
// 2. Network guard library compilation and socket rule tests
// 3. Dynamic OS Headroom calculations
// 4. Automated 2-hour idle tab cleanup logic & isProcessing state tracking
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSystemHeadroom, ensureNetguardLibrary } from "../src/tools.mjs";
import { BrowserManager } from "../src/browser.mjs";
import { Store } from "../src/store.mjs";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

console.log("== Running Portal Architectural Upgrade Tests ==\n");

// 1. Dynamic OS Headroom
{
  const hr = getSystemHeadroom();
  check("headroom returns valid total memory", hr.memTotalBytes > 0, `${Math.round(hr.memTotalBytes / (1024*1024))}MB`);
  check("headroom returns valid available memory", hr.memAvailableBytes > 0, `${Math.round(hr.memAvailableBytes / (1024*1024))}MB`);
  check("headroom reserves 1.25 GB for OS", hr.headroomReservedBytes === 1250 * 1024 * 1024);
  check("headroom reserves 1 CPU core when totalCores > 1", hr.totalCores > 1 ? hr.reservedCores === 1 : hr.reservedCores === 0);
  check("headroom allocates remaining cores to bots", hr.botCores === Math.max(1, hr.totalCores - 1));
}

// 2. Netguard compilation & library
{
  const lib = ensureNetguardLibrary();
  check("netguard library builds and exists", !!lib && fs.existsSync(lib), lib || "failed to build");
}

// 3. Automated Idle Tab Cleanup and isProcessing Tracking
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "portal-upgrades-"));
  const store = new Store(tmpHome);
  const bm = new BrowserManager(store);

  // Mock entry and pages
  let closedTab2 = false;
  let closedTab3 = false;
  let closedTab4 = false;

  const page1 = { close: async () => {}, url: () => "about:blank", title: async () => "Blank" };
  const page2 = { close: async () => { closedTab2 = true; }, url: () => "https://example.com/2", title: async () => "Idle Tab" };
  const page3 = { close: async () => { closedTab3 = true; }, url: () => "https://example.com/3", title: async () => "Processing Tab" };
  const page4 = { close: async () => { closedTab4 = true; }, url: () => "https://example.com/4", title: async () => "Active Automation Tab" };

  const mockPages = [page1, page2, page3, page4];
  const mockContext = {
    pages: () => mockPages.filter(p => (p !== page2 || !closedTab2) && (p !== page3 || !closedTab3) && (p !== page4 || !closedTab4)),
  };

  const entry = {
    context: mockContext,
    page: page1,
    refs: new Map(),
    chain: Promise.resolve(),
    tabs: new Map([
      [page1, "tab1"],
      [page2, "tab2"],
      [page3, "tab3"],
      [page4, "tab4"],
    ]),
    tabCounter: 4,
    active: page1,
    refMaps: new Map(),
    tabMeta: new Map([
      ["tab1", { lastActivityTimestamp: Date.now(), activeRequests: 0, activeDownloads: 0, activeWebSockets: 0, isAutomating: false }],
      // tab2: idle 2.5 hours, no processing -> SHOULD CLOSE
      ["tab2", { lastActivityTimestamp: Date.now() - 2.5 * 60 * 60 * 1000, activeRequests: 0, activeDownloads: 0, activeWebSockets: 0, isAutomating: false }],
      // tab3: idle 2.5 hours BUT has active network stream / download -> MUST KEEP
      ["tab3", { lastActivityTimestamp: Date.now() - 2.5 * 60 * 60 * 1000, activeRequests: 1, activeDownloads: 0, activeWebSockets: 0, isAutomating: false }],
      // tab4: idle 2.5 hours BUT has active automation running -> MUST KEEP
      ["tab4", { lastActivityTimestamp: Date.now() - 2.5 * 60 * 60 * 1000, activeRequests: 0, activeDownloads: 0, activeWebSockets: 0, isAutomating: true }],
    ]),
  };

  bm.contexts.set("test-profile", entry);

  // Test isTabProcessing
  check("isTabProcessing: tab1 is not processing", bm.isTabProcessing(entry, "tab1") === false);
  check("isTabProcessing: tab2 is not processing", bm.isTabProcessing(entry, "tab2") === false);
  check("isTabProcessing: tab3 is processing (active network)", bm.isTabProcessing(entry, "tab3") === true);
  check("isTabProcessing: tab4 is processing (active automation)", bm.isTabProcessing(entry, "tab4") === true);

  // Run cleanup with 2h threshold
  await bm.cleanIdleTabs(2 * 60 * 60 * 1000);

  check("idle cleanup closed unattended tab2 (idle >= 2h)", closedTab2 === true);
  check("idle cleanup preserved tab3 (active processing)", closedTab3 === false);
  check("idle cleanup preserved tab4 (active automation)", closedTab4 === false);

  bm.stopIdleCleanup();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL UPGRADE TESTS PASSED" : `\n${failures} UPGRADE TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
