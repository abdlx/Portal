// Verification suite for Portal speed optimizations:
// 1. SNAPSHOT_JS evaluation (checkVisibility, textContent, CSS selector generation)
// 2. browser_click and browser_fill schema validation with stealth flag
// 3. click() and fill() fast-path vs stealth-path routing
// 4. humanMoveAndClick cubic Bezier curve trajectory and mouse timing
// 5. firefox_user_prefs and humanize: false engine launch configuration
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { SNAPSHOT_JS, humanMoveAndClick, BrowserManager } from "../src/browser.mjs";
import { TOOLS } from "../src/tools.mjs";
import { validateArgs } from "../src/validate.mjs";
import { Store } from "../src/store.mjs";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

console.log("== Running Portal Speed Optimizations Verification ==\n");

// 1. Tool Schemas in tools.mjs
{
  const clickTool = TOOLS.find((t) => t.name === "browser_click");
  const fillTool = TOOLS.find((t) => t.name === "browser_fill");

  check("browser_click tool exists", !!clickTool);
  check("browser_click schema has stealth boolean", clickTool?.inputSchema?.properties?.stealth?.type === "boolean");
  check("browser_click description mentions Bezier/stealth", /stealth/i.test(clickTool?.description || ""));

  check("browser_fill tool exists", !!fillTool);
  check("browser_fill schema has stealth boolean", fillTool?.inputSchema?.properties?.stealth?.type === "boolean");
  check("browser_fill description mentions stealth/variance", /stealth/i.test(fillTool?.description || ""));

  // Validate args with stealth
  let clickValid = false;
  try {
    validateArgs(clickTool.inputSchema, { ref: "e1", stealth: true });
    clickValid = true;
  } catch {}
  check("validateArgs accepts browser_click with stealth: true", clickValid);

  let clickNoStealth = false;
  try {
    validateArgs(clickTool.inputSchema, { ref: "e1" });
    clickNoStealth = true;
  } catch {}
  check("validateArgs accepts browser_click without stealth", clickNoStealth);

  let clickInvalid = false;
  try {
    validateArgs(clickTool.inputSchema, { ref: "e1", stealth: "true" });
  } catch (e) {
    clickInvalid = /boolean/.test(e.message);
  }
  check("validateArgs rejects non-boolean stealth", clickInvalid);

  let fillValid = false;
  try {
    validateArgs(fillTool.inputSchema, { ref: "e1", text: "secret123", stealth: true });
    fillValid = true;
  } catch {}
  check("validateArgs accepts browser_fill with stealth: true", fillValid);
}

// 2. SNAPSHOT_JS: DOM Evaluation, checkVisibility, textContent, Fast CSS Selectors
{
  // Build a simulated DOM environment in a vm context
  const mockElements = [];

  class MockElement {
    constructor({ tag, id = null, name = null, ariaLabel = null, text = "", type = "text", visible = true, disabled = false, checked = false, parent = null, prevSibling = null }) {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.name = name;
      this.ariaLabel = ariaLabel;
      this.textContent = text;
      this.type = type;
      this.visible = visible;
      this.disabled = disabled;
      this.checked = checked;
      this.parentElement = parent;
      this.previousElementSibling = prevSibling;
      this.nodeType = 1;
    }

    getAttribute(attr) {
      if (attr === "name") return this.name;
      if (attr === "aria-label") return this.ariaLabel;
      if (attr === "placeholder") return null;
      if (attr === "title") return null;
      if (attr === "alt") return null;
      if (attr === "role") return null;
      return null;
    }

    checkVisibility(opts) {
      return this.visible;
    }
  }

  // Create mock DOM tree
  const body = new MockElement({ tag: "body" });
  const form = new MockElement({ tag: "form", id: "login-form", parent: body });
  const inputUser = new MockElement({ tag: "input", name: "username", text: "", parent: form });
  const inputPass = new MockElement({ tag: "input", name: "password", type: "password", text: "", parent: form, prevSibling: inputUser });
  const btnSubmit = new MockElement({ tag: "button", id: "submit-btn", text: "Sign In", parent: form, prevSibling: inputPass });
  const hiddenBtn = new MockElement({ tag: "button", text: "Hidden", visible: false, parent: body, prevSibling: form });
  const ariaLink = new MockElement({ tag: "a", ariaLabel: "Help Center", text: "Help", parent: body, prevSibling: hiddenBtn });

  const allMockElements = [inputUser, inputPass, btnSubmit, hiddenBtn, ariaLink];

  const sandbox = {
    document: {
      documentElement: { nodeType: 1 },
      body,
      querySelectorAll: (sel) => {
        if (sel.startsWith("#")) {
          const id = sel.slice(1);
          return [body, form, inputUser, inputPass, btnSubmit, hiddenBtn, ariaLink].filter(el => el.id === id);
        }
        if (sel.includes('[name="')) {
          const m = sel.match(/name="([^"]+)"/);
          const name = m ? m[1] : "";
          return allMockElements.filter(el => el.name === name);
        }
        if (sel.includes('[aria-label=')) {
          const m = sel.match(/aria-label="([^"]+)"/);
          const aria = m ? m[1] : "";
          return allMockElements.filter(el => el.ariaLabel === aria);
        }
        // General selector returns candidate interactive elements
        return allMockElements;
      },
    },
    Set,
    Array,
    JSON,
  };

  const script = new vm.Script(`(${SNAPSHOT_JS})()`);
  const result = script.runInNewContext(sandbox);

  check("SNAPSHOT_JS filters out non-visible elements via checkVisibility", !result.some((it) => it.name === "Hidden"));
  check("SNAPSHOT_JS extracts visible elements count", result.length === 4);

  const submitItem = result.find((it) => it.text === "Sign In");
  check("SNAPSHOT_JS uses #id selector for unique IDs", submitItem?.selector === "#submit-btn");

  const userInput = result.find((it) => it.selector.includes('name="username"'));
  check("SNAPSHOT_JS uses [name=...] selector", !!userInput);

  const passInput = result.find((it) => it.isPassword === true);
  check("SNAPSHOT_JS correctly identifies password fields", passInput?.isPassword === true);

  const helpLink = result.find((it) => it.name === "Help Center");
  check("SNAPSHOT_JS uses aria-label selector", helpLink?.selector === 'a[aria-label="Help Center"]');
}

// 3. humanMoveAndClick: Cubic Bezier Curve and Trajectory Execution
{
  const mouseMoves = [];
  let mouseDownCalled = false;
  let mouseUpCalled = false;

  const mockPage = {
    _lastMouseX: 50,
    _lastMouseY: 50,
    mouse: {
      move: async (x, y) => {
        mouseMoves.push({ x, y, time: Date.now() });
      },
      down: async () => {
        mouseDownCalled = true;
      },
      up: async () => {
        mouseUpCalled = true;
      },
    },
  };

  const mockLocator = {
    boundingBox: async () => ({ x: 300, y: 400, width: 100, height: 40 }),
    click: async () => {},
  };

  await humanMoveAndClick(mockPage, mockLocator);

  check("humanMoveAndClick executes multi-step trajectory", mouseMoves.length >= 12);
  check("humanMoveAndClick triggers mouse down", mouseDownCalled);
  check("humanMoveAndClick triggers mouse up", mouseUpCalled);

  // Check end coordinate lands inside the target bounding box (20%-80% of [300..400] x [400..440])
  const finalMove = mouseMoves[mouseMoves.length - 1];
  check(
    "final move lands inside randomized target box",
    finalMove.x >= 320 && finalMove.x <= 380 && finalMove.y >= 408 && finalMove.y <= 432,
    `final=(${Math.round(finalMove.x)}, ${Math.round(finalMove.y)})`,
  );

  // Fallback test: when boundingBox is null
  let forceClickCalled = false;
  const nullBoxLocator = {
    boundingBox: async () => null,
    click: async (opts) => {
      if (opts?.force) forceClickCalled = true;
    },
  };
  await humanMoveAndClick(mockPage, nullBoxLocator);
  check("humanMoveAndClick falls back to force click when boundingBox is null", forceClickCalled);
}

// 4. click() and fill() Fast-Path vs Stealth-Path Execution
{
  const mockStore = {
    browserProfileDir: () => "/tmp/test-profile",
  };
  const bm = new BrowserManager(mockStore);

  let clickParams = null;
  let fillParams = null;
  let keysTyped = [];

  const mockLocator = {
    first: () => mockLocator,
    click: async (opts) => {
      clickParams = opts;
    },
    fill: async (val, opts) => {
      fillParams = { val, opts };
    },
    boundingBox: async () => ({ x: 100, y: 100, width: 50, height: 20 }),
  };

  const mockPage = {
    locator: (sel) => mockLocator,
    url: () => "https://example.com",
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {},
    },
    keyboard: {
      press: async () => {},
      type: async (char) => {
        keysTyped.push(char);
      },
    },
  };

  const entry = {
    context: { pages: () => [mockPage] },
    page: mockPage,
    refs: new Map([["e1", "#test-button"], ["e2", "#test-input"]]),
    chain: Promise.resolve(),
    tabs: new Map([[mockPage, "tab1"]]),
    tabCounter: 1,
    active: mockPage,
    refMaps: new Map([["tab1", new Map([["e1", "#test-button"], ["e2", "#test-input"]])]]),
    tabMeta: new Map(),
  };
  bm.contexts.set("test-profile", entry);

  // Fast-path click
  clickParams = null;
  await bm.click({ slug: "test-profile" }, "e1", "tab1", { stealth: false });
  check("fast-path click uses force: true and noWaitAfter: true", clickParams?.force === true && clickParams?.noWaitAfter === true);

  // Stealth-path click
  clickParams = null;
  await bm.click({ slug: "test-profile" }, "e1", "tab1", { stealth: true });
  // Stealth calls humanMoveAndClick, which does not pass noWaitAfter
  check("stealth click executes humanized curve without fast-path noWaitAfter", clickParams?.noWaitAfter !== true);

  // Fast-path fill
  fillParams = null;
  await bm.fill({ slug: "test-profile" }, "e2", "fastval", "tab1", { stealth: false });
  check("fast-path fill uses force: true", fillParams?.val === "fastval" && fillParams?.opts?.force === true);

  // Stealth-path fill
  fillParams = null;
  keysTyped = [];
  await bm.fill({ slug: "test-profile" }, "e2", "stealthval", "tab1", { stealth: true });
  check("stealth fill types characters sequentially", keysTyped.join("") === "stealthval");

  bm.stopIdleCleanup();
}

// 5. Verification of firefox_user_prefs and humanize: false in browser.mjs source
{
  const browserCode = fs.readFileSync(path.join(import.meta.dirname, "../src/browser.mjs"), "utf8");

  check("browser.mjs configures humanize: false", /humanize:\s*false/.test(browserCode));
  check("browser.mjs has toolkit.cosmeticAnimations.enabled: false", /"toolkit\.cosmeticAnimations\.enabled":\s*false/.test(browserCode));
  check("browser.mjs has general.smoothScroll: false", /"general\.smoothScroll":\s*false/.test(browserCode));
  check("browser.mjs has image.animation_mode: once", /"image\.animation_mode":\s*"once"/.test(browserCode));
  check("browser.mjs has browser.cache.disk.enable: false", /"browser\.cache\.disk\.enable":\s*false/.test(browserCode));
  check("browser.mjs has browser.cache.memory.enable: true", /"browser\.cache\.memory\.enable":\s*true/.test(browserCode));
  check("browser.mjs has browser.sessionstore.interval: 600000", /"browser\.sessionstore\.interval":\s*600000/.test(browserCode));
}

console.log(failures === 0 ? "\nALL SPEED OPTIMIZATION TESTS PASSED" : `\n${failures} SPEED OPTIMIZATION TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
