// Test suite for browser_screenshot MCP tool and BrowserManager.screenshot
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TOOLS } from "../src/tools.mjs";
import { validateArgs } from "../src/validate.mjs";
import { Store } from "../src/store.mjs";
import { BrowserManager } from "../src/browser.mjs";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

console.log("== Running Portal browser_screenshot Verification ==\n");

// 1. Tool schema in tools.mjs
const tool = TOOLS.find((t) => t.name === "browser_screenshot");
check("browser_screenshot tool exists in TOOLS", !!tool);
check("browser_screenshot scope is browser", tool?.scope === "browser");
check("browser_screenshot has inputSchema", !!tool?.inputSchema);

const props = tool?.inputSchema?.properties || {};
check("schema has fullPage boolean", props.fullPage?.type === "boolean");
check("schema has path string", props.path?.type === "string");
check("schema has save boolean", props.save?.type === "boolean");
check("schema has base64 boolean", props.base64?.type === "boolean");
check("schema has timeout_s number", props.timeout_s?.type === "number");
check("schema has tab string", props.tab?.type === "string");

// 2. Argument validation (validateArgs)
let validEmpty = false;
try {
  validateArgs(tool.inputSchema, {});
  validEmpty = true;
} catch {}
check("validateArgs accepts empty arguments", validEmpty);

let validFull = false;
try {
  validateArgs(tool.inputSchema, {
    tab: "tab1",
    fullPage: true,
    path: "artifacts/page.png",
    save: true,
    base64: false,
    timeout_s: 10,
  });
  validFull = true;
} catch {}
check("validateArgs accepts all supported parameters", validFull);

let rejectedUnknown = false;
try {
  validateArgs(tool.inputSchema, { unknownArg: "test" });
} catch (e) {
  rejectedUnknown = /unknown argument: unknownArg/.test(e.message);
}
check("validateArgs rejects unknown arguments (additionalProperties: false)", rejectedUnknown);

let rejectedInvalidType = false;
try {
  validateArgs(tool.inputSchema, { fullPage: "true" });
} catch (e) {
  rejectedInvalidType = /boolean/.test(e.message);
}
check("validateArgs rejects non-boolean fullPage", rejectedInvalidType);

let rejectedInvalidPath = false;
try {
  validateArgs(tool.inputSchema, { path: 12345 });
} catch (e) {
  rejectedInvalidPath = /string/.test(e.message);
}
check("validateArgs rejects non-string path", rejectedInvalidPath);

// 3. Execution, file writing, and response content shapes
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "portal-shot-test-"));
try {
  process.env.PORTAL_HOME = tmpHome;
  const store = new Store(tmpHome);
  const profile = store.createProfile({ name: "Dex", slug: "dex" });
  const workspace = store.ensureWorkspace("dex");

  const fakePngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

  let lastScreenshotOpts = null;
  const mockBrowser = {
    async screenshot(prof, tab, opts) {
      lastScreenshotOpts = { prof, tab, opts };
      return {
        url: "https://example.com/test",
        title: "Test Page",
        tab: tab || "tab1",
        buffer: fakePngBuffer,
      };
    },
  };

  const ctx = {
    store,
    browser: mockBrowser,
    token: { scopes: ["browser", "write", "read"], profileSlug: "dex" },
    isTokenActive: () => true,
  };

  // Test 3a: Default run (no path specified) -> auto-saves to screenshot.png and returns base64 + text
  const res1 = await tool.run(ctx, {});
  check("default run returns content array with 2 items", Array.isArray(res1.content) && res1.content.length === 2);
  check("content[0] is text metadata", res1.content[0].type === "text");
  const info1 = JSON.parse(res1.content[0].text);
  check("metadata reports ok: true", info1.ok === true);
  check("metadata default path is screenshot.png", info1.path === "screenshot.png");
  check("metadata reports correct byte size", info1.bytes === fakePngBuffer.length);
  check("content[1] is image base64", res1.content[1].type === "image" && res1.content[1].mimeType === "image/png");
  check("image data matches buffer base64", res1.content[1].data === fakePngBuffer.toString("base64"));

  const defaultSavedFile = path.join(workspace, "screenshot.png");
  check("default run wrote screenshot.png to workspace", fs.existsSync(defaultSavedFile));
  check("file content matches PNG buffer", fs.readFileSync(defaultSavedFile).equals(fakePngBuffer));

  // Test 3b: Custom path with nested directory
  const res2 = await tool.run(ctx, {
    path: "artifacts/sub/deep_capture.png",
    fullPage: true,
    timeout_s: 12,
  });
  const info2 = JSON.parse(res2.content[0].text);
  check("custom path reported in metadata", info2.path === "artifacts/sub/deep_capture.png");
  check("fullPage reported as true", info2.fullPage === true);
  check("passed fullPage and timeout to browser.screenshot", lastScreenshotOpts.opts.fullPage === true && lastScreenshotOpts.opts.timeout === 12000);

  const customSavedFile = path.join(workspace, "artifacts", "sub", "deep_capture.png");
  check("nested directory created and file written", fs.existsSync(customSavedFile));
  check("nested file content matches buffer", fs.readFileSync(customSavedFile).equals(fakePngBuffer));

  // Test 3c: save: false -> does not write to disk
  const res3 = await tool.run(ctx, {
    path: "should_not_exist.png",
    save: false,
  });
  const info3 = JSON.parse(res3.content[0].text);
  check("save: false does not report saved path in metadata", info3.path === undefined);
  const unwrittenFile = path.join(workspace, "should_not_exist.png");
  check("save: false did not create file on disk", !fs.existsSync(unwrittenFile));

  // Test 3d: base64: false -> omits image block to save context tokens
  const res4 = await tool.run(ctx, {
    base64: false,
  });
  check("base64: false returns only 1 content block", res4.content.length === 1 && res4.content[0].type === "text");

  // Test 3e: Security: path traversal outside workspace is blocked
  let traversalBlocked = false;
  try {
    await tool.run(ctx, { path: "../../../etc/leaked.png" });
  } catch (e) {
    traversalBlocked = /escapes the profile workspace/.test(e.message);
  }
  check("workspace confinement prevents path traversal", traversalBlocked);

} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// 4. BrowserManager.screenshot method contract
{
  const bm = new BrowserManager(new Store());
  check("BrowserManager has screenshot method", typeof bm.screenshot === "function");
}

// 5. Batch tool compatibility
const batchTool = TOOLS.find((t) => t.name === "batch");
check("batch tool exists", !!batchTool);
check("browser_screenshot scope is allowed in batch (scope != 'admin')", tool.scope !== "admin");

console.log(failures === 0 ? "\nALL SCREENSHOT TESTS PASSED" : `\n${failures} SCREENSHOT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
