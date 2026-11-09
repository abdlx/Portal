// Test suite for browser_evaluate MCP tool and BrowserManager.evaluate
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

console.log("== Running Portal browser_evaluate Verification ==\n");

// 1. Tool schema in tools.mjs
const evalTool = TOOLS.find((t) => t.name === "browser_evaluate");
check("browser_evaluate tool exists in TOOLS", !!evalTool);
check("browser_evaluate scope is browser", evalTool?.scope === "browser");
check("browser_evaluate has inputSchema", !!evalTool?.inputSchema);

const props = evalTool?.inputSchema?.properties || {};
check("schema has expression string", props.expression?.type === "string");
check("schema expression has description", typeof props.expression?.description === "string" && props.expression.description.length > 0);
check("schema has tab string", props.tab?.type === "string");
check("schema has computer string", props.computer?.type === "string");
check("schema has profile string", props.profile?.type === "string");
check("schema requires expression", Array.isArray(evalTool?.inputSchema?.required) && evalTool.inputSchema.required.includes("expression"));

// 2. Argument validation (validateArgs)
let validCall = false;
try {
  validateArgs(evalTool.inputSchema, { expression: "document.title" });
  validCall = true;
} catch {}
check("validateArgs accepts valid expression", validCall);

let validWithTab = false;
try {
  validateArgs(evalTool.inputSchema, { expression: "1 + 1", tab: "tab1" });
  validWithTab = true;
} catch {}
check("validateArgs accepts expression with tab", validWithTab);

let rejectedMissingExpr = false;
try {
  validateArgs(evalTool.inputSchema, {});
} catch (e) {
  rejectedMissingExpr = /missing argument: expression/.test(e.message);
}
check("validateArgs rejects missing expression", rejectedMissingExpr);

let rejectedInvalidType = false;
try {
  validateArgs(evalTool.inputSchema, { expression: 12345 });
} catch (e) {
  rejectedInvalidType = /string/.test(e.message);
}
check("validateArgs rejects non-string expression", rejectedInvalidType);

let rejectedUnknown = false;
try {
  validateArgs(evalTool.inputSchema, { expression: "true", unknownArg: "test" });
} catch (e) {
  rejectedUnknown = /unknown argument: unknownArg/.test(e.message);
}
check("validateArgs rejects unknown arguments (additionalProperties: false)", rejectedUnknown);

// 3. BrowserManager.evaluate method execution
{
  const mockStore = {
    browserProfileDir: () => "/tmp/test-profile",
  };
  const bm = new BrowserManager(mockStore);

  let evaluatedExpr = null;
  const mockPage = {
    url: () => "https://example.com",
    evaluate: async (expr) => {
      evaluatedExpr = expr;
      if (expr === "document.title") return "Example Domain";
      if (expr === "({ x: 1, y: 'portal' })") return { x: 1, y: "portal" };
      if (expr === "void 0") return undefined;
      return eval(expr);
    },
  };

  const entry = {
    context: { pages: () => [mockPage] },
    page: mockPage,
    refs: new Map(),
    chain: Promise.resolve(),
    tabs: new Map([[mockPage, "tab1"]]),
    tabCounter: 1,
    active: mockPage,
    refMaps: new Map([["tab1", new Map()]]),
    tabMeta: new Map(),
  };
  bm.contexts.set("test-profile", entry);

  check("BrowserManager has evaluate method", typeof bm.evaluate === "function");

  const titleResult = await bm.evaluate({ slug: "test-profile" }, "document.title", "tab1");
  check("BrowserManager.evaluate returns string result", titleResult === "Example Domain");
  check("BrowserManager.evaluate passed expression to page.evaluate", evaluatedExpr === "document.title");

  const objResult = await bm.evaluate({ slug: "test-profile" }, "({ x: 1, y: 'portal' })", "tab1");
  check("BrowserManager.evaluate returns object result", objResult?.x === 1 && objResult?.y === "portal");

  bm.stopIdleCleanup();
}

// 4. MCP tool execution & JSON serialization
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "portal-eval-test-"));
  process.env.PORTAL_HOME = tmpHome;
  const store = new Store(tmpHome);
  const profile = store.createProfile({ name: "Dex", slug: "dex" });

  let evalReturnVal = undefined;
  let lastEvalExpr = null;
  const mockBrowser = {
    async evaluate(prof, expr, tab) {
      lastEvalExpr = expr;
      return evalReturnVal;
    },
  };

  const ctx = {
    store,
    browser: mockBrowser,
    token: { scopes: ["browser", "write", "read"], profileSlug: "dex" },
    isTokenActive: () => true,
  };

  // 4a. Object serialization
  evalReturnVal = { status: "ok", count: 42 };
  const res1 = await evalTool.run(ctx, { expression: "({ status: 'ok', count: 42 })" });
  check("run returns text content", Array.isArray(res1?.content) && res1.content[0]?.type === "text");
  const parsed1 = JSON.parse(res1.content[0].text);
  check("object result is valid JSON string", parsed1.status === "ok" && parsed1.count === 42);

  // 4b. String serialization
  evalReturnVal = "Hello Portal";
  const res2 = await evalTool.run(ctx, { expression: "'Hello Portal'" });
  const parsed2 = JSON.parse(res2.content[0].text);
  check("string result is JSON-stringified", parsed2 === "Hello Portal");

  // 4c. Number and boolean serialization
  evalReturnVal = 123.45;
  const res3 = await evalTool.run(ctx, { expression: "123.45" });
  check("number result is JSON-stringified", JSON.parse(res3.content[0].text) === 123.45);

  evalReturnVal = false;
  const res4 = await evalTool.run(ctx, { expression: "false" });
  check("boolean result is JSON-stringified", JSON.parse(res4.content[0].text) === false);

  // 4d. Undefined handling
  evalReturnVal = undefined;
  const res5 = await evalTool.run(ctx, { expression: "void 0" });
  check("undefined result produces 'undefined' text", res5.content[0].text === "undefined");

  // 4e. batch tool includes browser_evaluate
  const batchTool = TOOLS.find((t) => t.name === "batch");
  check("batch tool exists", !!batchTool);
  check("browser_evaluate is allowed in batch (scope != 'admin')", evalTool.scope !== "admin");

  fs.rmSync(tmpHome, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\nALL BROWSER_EVALUATE TESTS PASSED");
}
