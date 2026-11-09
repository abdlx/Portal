// Test suite for browser_credential_list and browser_credential_fill MCP tools,
// visible password/username targeting, and origin auto-matching.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOLS } from "../src/tools.mjs";
import { validateArgs } from "../src/validate.mjs";
import { Store } from "../src/store.mjs";
import { CredentialVault } from "../src/credential-vault.mjs";
import { BrowserManager } from "../src/browser.mjs";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

console.log("== Running Portal Credential Tools & Auto-Match Verification ==\n");

// 1. Tool schemas in tools.mjs
const listTool = TOOLS.find((t) => t.name === "browser_credential_list");
const fillTool = TOOLS.find((t) => t.name === "browser_credential_fill");

check("browser_credential_list exists in TOOLS", !!listTool);
check("browser_credential_list scope is browser", listTool?.scope === "browser");
check("browser_credential_list has inputSchema", !!listTool?.inputSchema);

check("browser_credential_fill exists in TOOLS", !!fillTool);
check("browser_credential_fill scope is browser", fillTool?.scope === "browser");
check("browser_credential_fill has inputSchema", !!fillTool?.inputSchema);
check("browser_credential_fill item_id is optional (no required array)", !fillTool?.inputSchema?.required?.includes?.("item_id"));

// 2. Argument validation (validateArgs)
let listValidEmpty = false;
try {
  validateArgs(listTool.inputSchema, {});
  listValidEmpty = true;
} catch {}
check("validateArgs accepts empty arguments for browser_credential_list", listValidEmpty);

let listValidProps = false;
try {
  validateArgs(listTool.inputSchema, { computer: "portal", profile: "dex" });
  listValidProps = true;
} catch {}
check("validateArgs accepts computer and profile for browser_credential_list", listValidProps);

let listRejectUnknown = false;
try {
  validateArgs(listTool.inputSchema, { unknownArg: "value" });
} catch (e) {
  listRejectUnknown = /unknown argument/.test(e.message);
}
check("validateArgs rejects unknown arguments for browser_credential_list", listRejectUnknown);

let fillValidEmpty = false;
try {
  validateArgs(fillTool.inputSchema, {});
  fillValidEmpty = true;
} catch {}
check("validateArgs accepts empty arguments for browser_credential_fill (item_id optional)", fillValidEmpty);

let fillValidWithId = false;
try {
  validateArgs(fillTool.inputSchema, { item_id: "c460a35d-6e46-4bf4-a745-98246f481c5a", tab: "tab1" });
  fillValidWithId = true;
} catch {}
check("validateArgs accepts item_id and tab for browser_credential_fill", fillValidWithId);

let fillRejectUnknown = false;
try {
  validateArgs(fillTool.inputSchema, { unknownArg: 123 });
} catch (e) {
  fillRejectUnknown = /unknown argument/.test(e.message);
}
check("validateArgs rejects unknown arguments for browser_credential_fill", fillRejectUnknown);

// 3. Execution of browser_credential_list
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "portal-cred-tools-"));
try {
  const store = new Store(tmpHome);
  const dexProf = store.createProfile({ name: "Dex", slug: "dex" });
  const kaiProf = store.createProfile({ name: "Kai", slug: "kai" });
  const vault = new CredentialVault(store);

  // Add credentials for Dex
  const c1 = vault.add(dexProf, {
    name: "LinkedIn Personal",
    origin: "https://www.linkedin.com/login",
    username: "dex@example.com",
    password: "DEX_LINKEDIN_SECRET_PASSWORD",
  });
  const c2 = vault.add(dexProf, {
    name: "GitHub",
    origin: "https://github.com/login",
    username: "dex-dev",
    password: "DEX_GITHUB_SECRET_TOKEN",
  });

  // Add credentials for Kai
  const k1 = vault.add(kaiProf, {
    name: "LinkedIn Social",
    origin: "https://www.linkedin.com/login",
    username: "kai@example.com",
    password: "KAI_LINKEDIN_SECRET_PASSWORD",
  });

  // Test run browser_credential_list for Dex
  const ctxDex = {
    store,
    token: { scopes: ["browser"], profileSlug: "dex" },
    credentialVault: vault,
  };
  const listRes = await listTool.run(ctxDex, {});
  check("browser_credential_list returns text content", Array.isArray(listRes.content) && listRes.content[0].type === "text");
  const parsedDexList = JSON.parse(listRes.content[0].text);
  check("browser_credential_list returns 2 entries for Dex", parsedDexList.length === 2);
  check("Dex list contains id, name, origin, username, updatedAt",
    parsedDexList[0].id === c1.id &&
    parsedDexList[0].name === "LinkedIn Personal" &&
    parsedDexList[0].origin === "https://www.linkedin.com" &&
    parsedDexList[0].username === "dex@example.com" &&
    typeof parsedDexList[0].updatedAt === "number"
  );
  check("browser_credential_list never exposes password",
    !JSON.stringify(listRes).includes("DEX_LINKEDIN_SECRET_PASSWORD") &&
    !JSON.stringify(listRes).includes("password")
  );

  // Profile isolation: Kai only sees Kai's credentials
  const ctxKai = {
    store,
    token: { scopes: ["browser"], profileSlug: "kai" },
    credentialVault: vault,
  };
  const kaiRes = await listTool.run(ctxKai, {});
  const parsedKaiList = JSON.parse(kaiRes.content[0].text);
  check("Kai list only has 1 credential", parsedKaiList.length === 1 && parsedKaiList[0].id === k1.id);
  check("Kai list does not leak Dex credentials", !parsedKaiList.some((x) => x.id === c1.id || x.id === c2.id));

  // 4. Unit testing BrowserManager.fillVaultLogin with simulated DOM
  const bm = new BrowserManager(store);

  // Helper to create a mock page with mock locators
  function createMockPage({
    url = "https://www.linkedin.com/checkpoint/lg/login-submit",
    passwordInputs = [], // array of { visible: boolean, filled: null }
    usernameInputs = [], // array of { visible: boolean, filled: null, selectorMatch: boolean }
  }) {
    return {
      url: () => url,
      locator: (selector) => {
        // Password selector with :visible
        if (selector === 'input[type="password"]:visible') {
          const visibleList = passwordInputs.filter((p) => p.visible);
          return {
            count: async () => visibleList.length,
            first: () => ({
              count: async () => (visibleList.length > 0 ? 1 : 0),
              isVisible: async () => visibleList.length > 0,
              fill: async (val) => {
                if (visibleList[0]) visibleList[0].filled = val;
              },
            }),
          };
        }
        // Legacy selector without :visible
        if (selector === 'input[type="password"]') {
          return {
            count: async () => passwordInputs.length,
            first: () => ({
              count: async () => (passwordInputs.length > 0 ? 1 : 0),
              isVisible: async () => (passwordInputs[0] ? passwordInputs[0].visible : false),
              fill: async (val) => {
                if (passwordInputs[0]) passwordInputs[0].filled = val;
              },
            }),
          };
        }
        // Username selector with :visible
        if (selector.includes("autocomplete") || selector.includes("session_key")) {
          const visibleUsernames = usernameInputs.filter((u) => u.visible && u.selectorMatch !== false);
          return {
            count: async () => visibleUsernames.length,
            first: () => ({
              count: async () => (visibleUsernames.length > 0 ? 1 : 0),
              isVisible: async () => visibleUsernames.length > 0,
              isEnabled: async () => (visibleUsernames[0] ? visibleUsernames[0].enabled !== false : true),
              fill: async (val) => {
                if (visibleUsernames[0]) visibleUsernames[0].filled = val;
              },
            }),
          };
        }
        return {
          count: async () => 0,
          first: () => ({
            count: async () => 0,
            isVisible: async () => false,
            isEnabled: async () => true,
            fill: async () => {},
          }),
        };
      },
    };
  }

  function attachMockContext(slug, mockPage) {
    const entry = {
      context: { pages: () => [mockPage] },
      active: mockPage,
      page: mockPage,
      tabs: new Map([[mockPage, "tab1"]]),
      refMaps: new Map([["tab1", new Map()]]),
      tabMeta: new Map([["tab1", { activeRequests: 0, activeWebSockets: 0, activeDownloads: 0, isAutomating: false, lastActivityTimestamp: Date.now() }]]),
      lastActivityAt: Date.now(),
    };
    bm.contexts.set(slug, entry);
    return entry;
  }

  // 4a. LinkedIn scenario: Two password inputs in DOM (1 hidden, 1 visible)
  {
    const passElements = [
      { visible: false, filled: null }, // hidden SSO / one-tap
      { visible: true, filled: null },  // visible login password
    ];
    const userElements = [
      { visible: false, filled: null }, // hidden email
      { visible: true, filled: null },  // visible session_key
    ];
    const mockPage = createMockPage({
      url: "https://www.linkedin.com/login",
      passwordInputs: passElements,
      usernameInputs: userElements,
    });
    attachMockContext("dex", mockPage);

    // Call fillVaultLogin with optional item_id omitted -> should auto-match https://www.linkedin.com
    const result = await bm.fillVaultLogin(dexProf, vault, undefined, "tab1");
    check("fillVaultLogin succeeds with two password inputs in DOM (1 hidden, 1 visible)", result.success === true);
    check("fillVaultLogin auto-matched correct item_id", result.itemId === c1.id);
    check("visible password input was filled", passElements[1].filled === "DEX_LINKEDIN_SECRET_PASSWORD");
    check("hidden password input was NOT filled", passElements[0].filled === null);
    check("visible username input was filled", userElements[1].filled === "dex@example.com");
    check("hidden username input was NOT filled", userElements[0].filled === null);
  }

  // 4b. Multiple visible password inputs: uses the first visible one
  {
    const passElements = [
      { visible: true, filled: null }, // first visible
      { visible: true, filled: null }, // second visible (e.g. confirmation)
    ];
    const userElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://github.com/login",
      passwordInputs: passElements,
      usernameInputs: userElements,
    });
    attachMockContext("dex", mockPage);

    const result = await bm.fillVaultLogin(dexProf, vault, c2.id, "tab1");
    check("fillVaultLogin succeeds when multiple visible password inputs exist", result.success === true);
    check("first visible password input was filled", passElements[0].filled === "DEX_GITHUB_SECRET_TOKEN");
    check("second password input was NOT filled", passElements[1].filled === null);
  }

  // 4b2. Multi-step login flow: visible but disabled username input (e.g. Google, X) is not filled
  {
    const passElements = [{ visible: true, filled: null }];
    const userElements = [{ visible: true, enabled: false, filled: null }];
    const mockPage = createMockPage({
      url: "https://github.com/login",
      passwordInputs: passElements,
      usernameInputs: userElements,
    });
    attachMockContext("dex", mockPage);

    const result = await bm.fillVaultLogin(dexProf, vault, c2.id, "tab1");
    check("fillVaultLogin succeeds with disabled username input in multi-step flow", result.success === true);
    check("password input was filled cleanly", passElements[0].filled === "DEX_GITHUB_SECRET_TOKEN");
    check("disabled username input was NOT filled", userElements[0].filled === null);
  }

  // 4c. Only hidden password inputs -> throws No visible password input
  {
    const passElements = [{ visible: false, filled: null }];
    const mockPage = createMockPage({
      url: "https://github.com/login",
      passwordInputs: passElements,
    });
    attachMockContext("dex", mockPage);

    let threw = false;
    try {
      await bm.fillVaultLogin(dexProf, vault, c2.id, "tab1");
    } catch (e) {
      threw = /No visible password input in the main document/.test(e.message);
    }
    check("fillVaultLogin throws when only hidden password inputs exist", threw);
  }

  // 4d. Zero password inputs -> throws No visible password input
  {
    const mockPage = createMockPage({
      url: "https://github.com/login",
      passwordInputs: [],
    });
    attachMockContext("dex", mockPage);

    let threw = false;
    try {
      await bm.fillVaultLogin(dexProf, vault, c2.id, "tab1");
    } catch (e) {
      threw = /No visible password input in the main document/.test(e.message);
    }
    check("fillVaultLogin throws when zero password inputs exist", threw);
  }

  // 4e. Auto-match by origin: 0 matching credentials
  {
    const passElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://twitter.com/login",
      passwordInputs: passElements,
    });
    attachMockContext("dex", mockPage);

    let threw = false;
    let errMsg = "";
    try {
      await bm.fillVaultLogin(dexProf, vault, undefined, "tab1");
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    check("auto-match throws when 0 credentials match origin", threw && /No credentials found for origin https:\/\/twitter\.com/.test(errMsg), errMsg);
  }

  // 4f. Auto-match by origin: multiple matching credentials -> error listing IDs
  {
    // Add a second LinkedIn credential for Dex
    const c3 = vault.add(dexProf, {
      name: "LinkedIn Secondary",
      origin: "https://www.linkedin.com/login",
      username: "dex-work@example.com",
      password: "DEX_SECOND_PASSWORD",
    });

    const passElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://www.linkedin.com/login",
      passwordInputs: passElements,
    });
    attachMockContext("dex", mockPage);

    let threw = false;
    let errMsg = "";
    try {
      await bm.fillVaultLogin(dexProf, vault, undefined, "tab1");
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    check("auto-match throws when multiple credentials match origin", threw && /Multiple credentials match origin/.test(errMsg));
    check("multiple match error lists matching IDs", errMsg.includes(c1.id) && errMsg.includes(c3.id), errMsg);

    // Explicit item_id disambiguates
    const explicitRes = await bm.fillVaultLogin(dexProf, vault, c3.id, "tab1");
    check("explicit item_id disambiguates between multiple matching credentials", explicitRes.itemId === c3.id);
    check("explicit item_id filled second password", passElements[0].filled === "DEX_SECOND_PASSWORD");
  }

  // 4g. Explicit item_id with origin mismatch throws
  {
    const passElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://github.com/login",
      passwordInputs: passElements,
    });
    attachMockContext("dex", mockPage);

    let threw = false;
    try {
      await bm.fillVaultLogin(dexProf, vault, c1.id, "tab1"); // c1 is LinkedIn
    } catch (e) {
      threw = /Browser origin does not match the saved credential/.test(e.message);
    }
    check("explicit item_id with origin mismatch throws", threw);
  }

  // 4h. Apex origin auto-matches www subdomain
  {
    const apexCred = vault.add(dexProf, {
      name: "Apex Site",
      origin: "https://my-site.com",
      username: "user-apex",
      password: "SECRET_APEX_PASSWORD",
    });
    const passElements = [{ visible: true, filled: null }];
    const userElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://www.my-site.com/login",
      passwordInputs: passElements,
      usernameInputs: userElements,
    });
    attachMockContext("dex", mockPage);

    const result = await bm.fillVaultLogin(dexProf, vault, undefined, "tab1");
    check("fillVaultLogin auto-matches apex origin to www subdomain", result.success === true && result.itemId === apexCred.id);
    check("password filled from apex credential", passElements[0].filled === "SECRET_APEX_PASSWORD");
  }

  // 4i. www origin auto-matches apex domain
  {
    const wwwCred = vault.add(dexProf, {
      name: "WWW Site",
      origin: "https://www.other-site.com",
      username: "user-www",
      password: "SECRET_WWW_PASSWORD",
    });
    const passElements = [{ visible: true, filled: null }];
    const userElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://other-site.com/login",
      passwordInputs: passElements,
      usernameInputs: userElements,
    });
    attachMockContext("dex", mockPage);

    const result = await bm.fillVaultLogin(dexProf, vault, undefined, "tab1");
    check("fillVaultLogin auto-matches www origin to apex domain", result.success === true && result.itemId === wwwCred.id);
    check("password filled from www credential", passElements[0].filled === "SECRET_WWW_PASSWORD");
  }

  // 4j. Untrusted subdomains do NOT match
  {
    const passElements = [{ visible: true, filled: null }];
    const mockPage = createMockPage({
      url: "https://evil.my-site.com/login",
      passwordInputs: passElements,
    });
    attachMockContext("dex", mockPage);

    let autoMatchThrew = false;
    try {
      await bm.fillVaultLogin(dexProf, vault, undefined, "tab1");
    } catch (e) {
      autoMatchThrew = /No credentials found for origin/.test(e.message);
    }
    check("auto-match rejects untrusted subdomain", autoMatchThrew);
  }

  // 5. Tool integration test: browser_credential_fill calling fillVaultLogin
  {
    let toolCalledWith = null;
    const mockBrowser = {
      fillVaultLogin: async (profile, v, itemId, tab) => {
        toolCalledWith = { profile: profile.slug, itemId, tab };
        return { success: true, profile: profile.slug, origin: "https://example.com" };
      },
    };
    const ctx = {
      store,
      token: { scopes: ["browser"], profileSlug: "dex" },
      credentialVault: vault,
      browser: mockBrowser,
    };

    const fillRes = await fillTool.run(ctx, { tab: "tab1" });
    check("browser_credential_fill runs without item_id", toolCalledWith?.itemId === undefined && toolCalledWith?.tab === "tab1");
    check("browser_credential_fill returns text result", JSON.parse(fillRes.content[0].text).success === true);

    await fillTool.run(ctx, { item_id: c1.id });
    check("browser_credential_fill forwards provided item_id", toolCalledWith?.itemId === c1.id);
  }

  // 6. Batch tool integration with browser_credential_list and browser_credential_fill
  {
    const batchTool = TOOLS.find((t) => t.name === "batch");
    check("batch tool allows browser_credential_list (non-admin scope)", listTool.scope !== "admin");
    check("batch tool allows browser_credential_fill (non-admin scope)", fillTool.scope !== "admin");
  }

} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("\nALL CREDENTIAL TOOLS & AUTO-MATCH TESTS PASSED");
}
