// Browser layer: one persistent Camoufox context per bot profile,
// driven through the `camoufox` npm package (Playwright API over
// Firefox's Juggler protocol). NOT CDP: Mozilla removed the CDP
// implementation from Firefox entirely in Firefox 141 (July 2025),
// and Camoufox is Firefox 158 — there is no CDP endpoint to program
// against. Playwright's Page/Context API is the programming surface,
// which is exactly what this layer uses (goto, evaluate, locators,
// mouse/keyboard) — no CDP sessions anywhere, so nothing here is
// Chromium-specific.
//
// Each profile gets:
//   - its own user-data-dir (cookies, logins, storage persist on disk),
//   - one PINNED fingerprint: an fpgen fingerprint object drawn once
//     with fpgen-js (the same generator Camoufox uses internally),
//     stored as JSON under the store home, and replayed via the
//     `fingerprint:` launch option on every later launch. The launcher
//     salts all seeded draws (fonts, voices, GPU, noise) from the
//     pinned fingerprint, so the presented identity is stable across
//     restarts. Canvas/WebGL readback still varies per session (the
//     canvas seed is not honoured by the shipped build) — pinned
//     identity means stable navigator/screen/WebGL/fonts/timezone,
//     not bit-identical pixels.
//   - timezone Asia/Karachi + locale en-US + 1280x800 viewport,
//   - humanize: false at engine launch for CDP-level fast-path execution;
//     stealth interactions (logins/captchas) use Asymmetric Humanization
//     with cubic Bezier mouse curves and natural keystroke dynamics.
// Engine patches live in the binary itself (C++ level); this layer
// adds no JavaScript injection and no UA overrides.
//
// Camoufox is free software (wrapper MIT, browser MPL-2.0): no key,
// no activation, no concurrent-session limit. The single-session
// guard the CloakBrowser build needed is gone; how many browsers run
// at once is now a RAM question, not a license one.
import fs from "node:fs";
import path from "node:path";
import { startDisplay, stopDisplay, VIEW_WIDTH, VIEW_HEIGHT } from "./vnc.mjs";
import { getSystemHeadroom } from "./tools.mjs";

const IDLE_SLEEP_MS = Math.max(60_000, Number(process.env.PORTAL_BROWSER_IDLE_SLEEP_MINUTES || 30) * 60_000);
const SESSION_FILE = "open-tabs.json";

const MISSING_MSG =
  "Camoufox is not installed yet. Run `npx camoufox fetch` in the app directory (downloads the browser build once), or press Install / repair Camoufox in the Portal panel, then try again.";
const LIBS_MSG =
  "Camoufox needs system libraries this machine does not have yet. Install them, then try again: sudo apt-get install -y --no-install-recommends libgtk-3-0t64 libx11-xcb1 libasound2t64";

let loadersPromise = null;

async function loadLoaders() {
  if (!loadersPromise) {
    loadersPromise = (async () => {
      let camoufox;
      try {
        camoufox = await import("camoufox");
      } catch (e) {
        throw new Error(`${MISSING_MSG} (camoufox package: ${e.message})`);
      }
      let fpgen;
      try {
        fpgen = await import("fpgen-js");
      } catch (e) {
        throw new Error(`fpgen-js package missing: ${e.message}`);
      }
      return { camoufox, fpgen };
    })().catch((e) => {
      loadersPromise = null;
      throw e;
    });
  }
  return loadersPromise;
}

let modelPromise = null;

async function ensureFpgenModel(fpgen) {
  if (!modelPromise) {
    modelPromise = fpgen.ensureModel().catch((e) => {
      modelPromise = null;
      throw new Error(
        `could not download the fingerprint model (fpgen): ${e.message}`,
      );
    });
  }
  return modelPromise;
}

function isMissingLibsError(e) {
  const m = String(e?.message || "") + String(e?.stack || "");
  return /libgtk|libasound|XPCOMGlueLoad|libx11-xcb|libnss3|libnspr/i.test(m);
}

function explainLaunchError(e) {
  const m = String(e?.message || e);
  if (isMissingLibsError(e)) return `${LIBS_MSG}\n(${m})`;
  if (/camoufox|executable|browser.*not (found|installed)|fetch/i.test(m)) {
    return `${MISSING_MSG}\n(${m})`;
  }
  return m;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resetBrowserCache() {
  // Kept for the panel install job: installs are picked up fresh because
  // browserInfo() reads the install dir from disk on every call. No-op.
}

export async function browserInfo() {
  // listInstalled() reads the install dir from disk — no download, no launch.
  try {
    if (
      process.env.CAMOUFOX_EXECUTABLE &&
      isExecutableFile(process.env.CAMOUFOX_EXECUTABLE)
    ) {
      return {
        installed: true,
        executable: process.env.CAMOUFOX_EXECUTABLE,
        version: null,
      };
    }
    const { camoufox } = await loadLoaders();
    const installed =
      typeof camoufox.listInstalled === "function"
        ? camoufox.listInstalled()
        : [];
    if (installed.length > 0) {
      const first = installed[0] || {};
      return {
        installed: true,
        executable: camoufox.INSTALL_DIR || null,
        version: first.version ?? first.build ?? first.fullString ?? null,
      };
    }
    return {
      installed: false,
      executable: null,
      version: null,
      error: MISSING_MSG,
    };
  } catch (e) {
    return {
      installed: false,
      executable: null,
      version: null,
      error: e.message,
    };
  }
}

export const SNAPSHOT_JS = `() => {
  const out = [];
  const seen = new Set();
  const sels = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="tab"], [contenteditable="true"], summary';
  const els = document.querySelectorAll(sels);

  function getSelector(el) {
    if (el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id)) {
      if (document.querySelectorAll('#' + el.id).length === 1) {
        return '#' + el.id;
      }
    }
    const name = el.getAttribute('name');
    if (name && /^[a-zA-Z0-9_-]+$/.test(name)) {
      const tagAndName = el.tagName.toLowerCase() + '[name="' + name + '"]';
      if (document.querySelectorAll(tagAndName).length === 1) {
        return tagAndName;
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 50) {
      const tagAndAria = el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(aria) + ']';
      if (document.querySelectorAll(tagAndAria).length === 1) {
        return tagAndAria;
      }
    }
    // Fast shallow CSS path with hierarchical fallback
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(n.id) && document.querySelectorAll('#' + n.id).length === 1) {
        parts.unshift('#' + n.id);
        break;
      }
      const tag = n.tagName.toLowerCase();
      let idx = 1;
      let sib = n.previousElementSibling;
      while (sib) {
        if (sib.tagName === n.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      if (tag === 'body') break;
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  for (const el of els) {
    if (out.length >= 300) break;
    // Native C++ visibility check: zero layout reflow
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    } else {
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
    }

    const sel = getSelector(el);
    if (seen.has(sel)) continue;
    seen.add(sel);

    // textContent reads internal node text without forcing reflow like innerText
    // Never include a password input's value in the agent snapshot.
    // Its value otherwise becomes the element name when labels are absent.
    const text = (el.type === 'password' ? '' : (el.textContent || el.value || '')).replace(/\\s+/g, ' ').trim().slice(0, 80);
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || text || el.tagName).slice(0, 80);
    const role = el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'textbox',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button'}[el.tagName] || el.tagName.toLowerCase());

    out.push({
      tag: el.tagName.toLowerCase(),
      role,
      name,
      text,
      selector: sel,
      disabled: !!el.disabled,
      checked: el.checked === true,
      isPassword: el.type === 'password'
    });
  }
  return out;
}`;

// Helper for cubic Bezier mouse curve and humanized interactions (Asymmetric Humanization)
export async function humanMoveAndClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) {
    await locator.click({ force: true });
    return;
  }
  // Target coordinates randomized inside 20%-80% of bounding box
  const targetX = box.x + box.width * (0.2 + Math.random() * 0.6);
  const targetY = box.y + box.height * (0.2 + Math.random() * 0.6);

  const startX = page._lastMouseX ?? Math.max(0, box.x + (Math.random() - 0.5) * 200);
  const startY = page._lastMouseY ?? Math.max(0, box.y + (Math.random() - 0.5) * 200);

  const dx = targetX - startX;
  const dy = targetY - startY;
  const dist = Math.hypot(dx, dy);

  // Perpendicular deviation for control points
  const perpX = -dy * 0.2 * (Math.random() - 0.5);
  const perpY = dx * 0.2 * (Math.random() - 0.5);

  const p1X = startX + dx * 0.3 + perpX;
  const p1Y = startY + dy * 0.3 + perpY;
  const p2X = startX + dx * 0.7 + perpX * 0.5;
  const p2Y = startY + dy * 0.7 + perpY * 0.5;

  const steps = Math.max(12, Math.min(25, Math.floor(dist / 25)));
  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    // Cubic ease-out curve (Fitts's Law approximation: quick start, smooth deceleration)
    const t = 1 - Math.pow(1 - rawT, 3);
    const oneMinusT = 1 - t;

    const curX =
      Math.pow(oneMinusT, 3) * startX +
      3 * Math.pow(oneMinusT, 2) * t * p1X +
      3 * oneMinusT * Math.pow(t, 2) * p2X +
      Math.pow(t, 3) * targetX;
    const curY =
      Math.pow(oneMinusT, 3) * startY +
      3 * Math.pow(oneMinusT, 2) * t * p1Y +
      3 * oneMinusT * Math.pow(t, 2) * p2Y +
      Math.pow(t, 3) * targetY;

    await page.mouse.move(curX, curY);
    await new Promise((r) => setTimeout(r, 8 + Math.random() * 6));
  }

  page._lastMouseX = targetX;
  page._lastMouseY = targetY;

  // Hover dwell
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 50));
  await page.mouse.up();
}

export class BrowserManager {
  constructor(store) {
    this.store = store;
    this.contexts = new Map(); // slug -> { context, page, refs: Map, chain: Promise, tabs, tabCounter, active, refMaps, tabMeta }
    this.starting = new Map();
    this.closing = new Map();
    // Profile-level hibernation takes precedence over old per-tab idle eviction.
    this.idleCleanupTimer = setInterval(() => {
      this.sleepIdleBrowsers().catch((err) => console.warn("[portal] idle sleep:", err.message));
    }, 60000).unref();
  }

  stopIdleCleanup() {
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer);
      this.idleCleanupTimer = null;
    }
  }

  #chain(slug, fn) {
    const entry = this.contexts.get(slug);
    if (!entry?.context) throw new Error("browser is not started");
    this.#touch(entry);
    entry.pendingOps = (entry.pendingOps || 0) + 1;
    const prev = entry.chain || Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      entry.pendingOps--;
      this.#touch(entry);
    });
    entry.chain = next;
    return next;
  }

  #touch(entry) {
    entry.lastActivityAt = Date.now();
  }

  viewerConnected(profile) {
    const entry = this.contexts.get(profile.slug);
    if (entry?.context) {
      entry.viewers = (entry.viewers || 0) + 1;
      this.#touch(entry);
    }
  }

  viewerDisconnected(profile) {
    const entry = this.contexts.get(profile.slug);
    if (entry?.context) {
      entry.viewers = Math.max(0, (entry.viewers || 0) - 1);
      this.#touch(entry);
    }
  }

  viewerActivity(profile) {
    const entry = this.contexts.get(profile.slug);
    if (entry?.context) this.#touch(entry);
  }

  #sessionPath(slug) {
    return path.join(this.store.profileHome(slug), SESSION_FILE);
  }

  #saveOpenTabs(slug, entry) {
    this.#syncPages(entry);
    const pages = entry.context.pages();
    const tabs = pages.map((pg) => pg.url()).filter((url) => url && url !== "about:blank");
    const activeIndex = Math.max(0, pages.indexOf(entry.active));
    // Stored next to the persistent browser profile, outside the agent workspace.
    const file = this.#sessionPath(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({
        version: 1, tabs, activeIndex, headed: !!entry.headed, savedAt: Date.now(),
      }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  async #restoreOpenTabs(slug, entry) {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.#sessionPath(slug), "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(saved?.tabs)) return;
    const urls = saved.tabs.filter((url) => {
      if (typeof url !== "string" || url.length > 8192) return false;
      return /^(https?:|file:|about:)/i.test(url) && url !== "about:blank";
    }).slice(0, 50);
    if (!urls.length) return;
    const first = entry.context.pages()[0] || await entry.context.newPage();
    for (let i = 0; i < urls.length; i++) {
      const pg = i === 0 ? first : await entry.context.newPage();
      this.#tabIdFor(entry, pg);
      try {
        await pg.goto(urls[i], { waitUntil: "domcontentloaded", timeout: 20000 });
      } catch (err) {
        console.warn(`[portal] restore tab ${i + 1} in ${slug}: ${err.message}`);
      }
    }
    const index = Math.min(Math.max(Number(saved.activeIndex) || 0, 0), urls.length - 1);
    // Active tab indexing refers to the original pages, but blank tabs are excluded.
    entry.active = entry.context.pages()[index] || first;
    this.#syncPages(entry);
  }

  async sleepIdleBrowsers(maxIdleMs = IDLE_SLEEP_MS) {
    const slept = [];
    for (const [slug, entry] of this.contexts) {
      if (!entry?.context || this.starting.has(slug) || this.closing.has(slug)) continue;
      if ((entry.viewers || 0) > 0 || (entry.pendingOps || 0) > 0) continue;
      if (Date.now() - (entry.lastActivityAt || Date.now()) < maxIdleMs) continue;
      this.#syncPages(entry);
      // Never interrupt in-flight page requests, downloads, or automation.
      if ([...entry.tabs.values()].some((id) => {
        const meta = entry.tabMeta?.get(id);
        // A passive persistent WebSocket alone does not count as user activity.
        return meta && (meta.isAutomating || meta.activeRequests > 0 || meta.activeDownloads > 0);
      })) continue;
      const profile = this.store.profileBySlug(slug);
      if (!profile) continue;
      await this.close(profile, { reason: "idle" });
      slept.push(slug);
    }
    return slept;
  }

  // ---- tabs ---------------------------------------------------------------
  // Tabs are always enabled: every profile's browser can hold as many
  // pages as the machine can carry. A tab id (tab1, tab2, …) is assigned
  // when a page is first seen and stays with that page while it lives.
  // Refs from a snapshot belong to the tab that was snapshotted; switching
  // tabs swaps the ref map, so a ref can never silently act on the
  // wrong tab.
  #tabIdFor(entry, page) {
    let id = entry.tabs.get(page);
    if (!id) {
      id = `tab${++entry.tabCounter}`;
      entry.tabs.set(page, id);
      if (!entry.refMaps.has(id)) entry.refMaps.set(id, new Map());
      if (!entry.tabMeta) entry.tabMeta = new Map();
      if (!entry.tabMeta.has(id)) {
        entry.tabMeta.set(id, {
          lastActivityTimestamp: Date.now(),
          activeRequests: 0,
          activeDownloads: 0,
          activeWebSockets: 0,
          isAutomating: false,
        });
        this.#attachActivityWatchers(entry, page, id);
      }
    }
    return id;
  }

  #attachActivityWatchers(entry, page, tabId) {
    try {
      page.on("request", () => {
        const meta = entry.tabMeta?.get(tabId);
        if (meta) {
          meta.activeRequests++;
          meta.lastActivityTimestamp = Date.now();
        }
      });
      page.on("requestfinished", () => {
        const meta = entry.tabMeta?.get(tabId);
        if (meta && meta.activeRequests > 0) meta.activeRequests--;
      });
      page.on("requestfailed", () => {
        const meta = entry.tabMeta?.get(tabId);
        if (meta && meta.activeRequests > 0) meta.activeRequests--;
      });
      page.on("websocket", (ws) => {
        const meta = entry.tabMeta?.get(tabId);
        if (meta) {
          meta.activeWebSockets++;
          meta.lastActivityTimestamp = Date.now();
        }
        ws.on("close", () => {
          const m = entry.tabMeta?.get(tabId);
          if (m && m.activeWebSockets > 0) m.activeWebSockets--;
        });
      });
      page.on("download", (download) => {
        const meta = entry.tabMeta?.get(tabId);
        if (meta) {
          meta.activeDownloads++;
          meta.lastActivityTimestamp = Date.now();
          // Finish tracking completed, failed, and cancelled downloads.
          Promise.resolve().then(() => download.path()).catch(() => {}).finally(() => {
            meta.activeDownloads = Math.max(0, meta.activeDownloads - 1);
          });
        }
      });
    } catch {
      /* ignore */
    }
  }

  isTabProcessing(entry, tabId) {
    const meta = entry.tabMeta?.get(tabId);
    if (!meta) return false;
    return (
      meta.isAutomating ||
      meta.activeRequests > 0 ||
      meta.activeDownloads > 0 ||
      meta.activeWebSockets > 0
    );
  }

  #touchTab(entry, tabId, isAutomating = false) {
    const meta = entry.tabMeta?.get(tabId);
    if (meta) {
      meta.lastActivityTimestamp = Date.now();
      if (typeof isAutomating === "boolean") meta.isAutomating = isAutomating;
    }
  }

  async cleanIdleTabs(maxIdleMs = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    const closed = [];
    for (const [slug, entry] of this.contexts) {
      if (!entry.context) continue;
      this.#syncPages(entry);
      const pages = entry.context.pages();
      if (pages.length <= 1) continue; // Keep at least one tab open
      for (const pg of pages) {
        const id = entry.tabs.get(pg);
        if (!id) continue;
        const meta = entry.tabMeta?.get(id);
        if (!meta) continue;
        const processing = this.isTabProcessing(entry, id);
        if (!processing && now - meta.lastActivityTimestamp >= maxIdleMs) {
          const idleMin = Math.round((now - meta.lastActivityTimestamp) / 60000);
          console.log(`[portal] auto-closing idle tab ${id} in profile ${slug} (idle for ${idleMin}m >= ${Math.round(maxIdleMs / 60000)}m)`);
          try {
            await pg.close();
            closed.push({ profile: slug, tab: id, idleMin });
          } catch {
            /* already closed */
          }
        }
      }
      this.#syncPages(entry);
    }
    return closed;
  }

  #syncPages(entry) {
    if (!entry.context) return;
    const live = new Set(entry.context.pages());
    for (const [pg, id] of [...entry.tabs]) {
      if (!live.has(pg)) {
        entry.tabs.delete(pg);
        entry.refMaps.delete(id);
        entry.tabMeta?.delete(id);
      }
    }
    for (const pg of live) this.#tabIdFor(entry, pg);
    if (!entry.active || !live.has(entry.active)) {
      entry.active = [...live].pop() || null;
    }
    entry.page = entry.active;
    entry.refs =
      entry.active && entry.refMaps.has(entry.tabs.get(entry.active))
        ? entry.refMaps.get(entry.tabs.get(entry.active))
        : new Map();
    if (entry.active) entry.refMaps.set(entry.tabs.get(entry.active), entry.refs);
  }

  async #activePage(entry, tab) {
    if (!entry.context) throw new Error("browser is not started");
    this.#syncPages(entry);
    if (tab) {
      const found = [...entry.tabs.entries()].find(([, id]) => id === tab);
      if (!found) {
        const known = [...entry.tabs.values()].join(", ") || "(none)";
        throw new Error(`unknown tab: ${tab}. Open tabs: ${known}. Use browser_tab_list to see them.`);
      }
      const [pg, id] = found;
      entry.active = pg;
      entry.page = pg;
      entry.refs = entry.refMaps.get(id) || new Map();
      entry.refMaps.set(id, entry.refs);
      return pg;
    }
    if (!entry.active) {
      const pg = await entry.context.newPage();
      const id = this.#tabIdFor(entry, pg);
      entry.active = pg;
      entry.page = pg;
      entry.refs = new Map();
      entry.refMaps.set(id, entry.refs);
    }
    return entry.active;
  }

  // Create the on-disk browser profile (directory + pinned fingerprint)
  // WITHOUT launching the browser, so a bot created in the panel has its
  // isolated browser profile from the moment it exists. The first
  // browser_start reuses what prepare() stored; if prepare() never ran
  // (or the fingerprint model was unreachable), #start draws it lazily.
  async prepare(profile) {
    const userDataDir = this.store.browserProfileDir(profile.slug);
    fs.mkdirSync(userDataDir, { recursive: true });
    const loaders = await loadLoaders();
    await this.#fingerprint(profile, loaders);
    return { profile: profile.slug, browserProfileDir: userDataDir, fingerprint: "stored" };
  }

  async newTab(profile, url) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await e.context.newPage();
      const id = this.#tabIdFor(e, pg);
      e.active = pg;
      e.page = pg;
      e.refs = new Map();
      e.refMaps.set(id, e.refs);
      this.#touchTab(e, id, true);
      let status = null;
      try {
        if (url) {
          const resp = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          status = resp ? resp.status() : null;
        }
        let title = "";
        try {
          title = await pg.title();
        } catch {
          /* ignore */
        }
        return { tab: id, url: pg.url(), title, status };
      } finally {
        this.#touchTab(e, id, false);
      }
    });
  }

  async listTabs(profile) {
    const entry = this.contexts.get(profile.slug);
    if (!entry?.context) {
      return { started: false, profile: profile.slug, activeTab: null, tabs: [] };
    }
    this.#syncPages(entry);
    const tabs = [];
    for (const pg of entry.context.pages()) {
      let title = "";
      try {
        title = await pg.title();
      } catch {
        /* ignore */
      }
      const id = entry.tabs.get(pg);
      const meta = entry.tabMeta?.get(id);
      const isProcessing = this.isTabProcessing(entry, id);
      tabs.push({
        tab: id,
        url: pg.url(),
        title,
        lastActivityAt: meta?.lastActivityTimestamp || null,
        idleMinutes: meta ? Math.floor((Date.now() - meta.lastActivityTimestamp) / 60000) : 0,
        isProcessing,
      });
    }
    return {
      started: true,
      profile: profile.slug,
      activeTab: entry.active ? entry.tabs.get(entry.active) : null,
      tabs,
    };
  }

  async switchTab(profile, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, false);
      let title = "";
      try {
        title = await pg.title();
      } catch {
        /* ignore */
      }
      return { tab: tabId, url: pg.url(), title };
    });
  }

  async closeTab(profile, tab) {
    const entry = this.contexts.get(profile.slug);
    if (!entry?.context) return { closed: true, tab, started: false };
    return this.#chain(profile.slug, async () => {
      this.#syncPages(entry);
      const found = [...entry.tabs.entries()].find(([, id]) => id === tab);
      if (!found) {
        const known = [...entry.tabs.values()].join(", ") || "(none)";
        throw new Error(`unknown tab: ${tab}. Open tabs: ${known}. Use browser_tab_list to see them.`);
      }
      await found[0].close();
      this.#syncPages(entry);
      return {
        closed: true,
        tab,
        activeTab: entry.active ? entry.tabs.get(entry.active) : null,
        tabs: entry.context.pages().length,
      };
    });
  }

  // A headed browser is a superset of a headless one: every MCP tool
  // works identically on a headed page, so a running headed browser
  // satisfies a headless request. The reverse is not true — a viewer
  // needs pixels, so a headless browser is closed and relaunched headed
  // (the on-disk profile, cookies and logins survive the relaunch).
  async ensure(profile, opts = {}) {
    const slug = profile.slug;
    if (this.closing.has(slug)) await this.closing.get(slug);
    if (this.starting.has(slug)) return this.starting.get(slug);
    const existing = this.contexts.get(slug);
    if (existing?.context) {
      if (opts.headed && !existing.headed) {
        await this.close(profile);
      } else {
        this.#touch(existing);
        return existing;
      }
    }
    // Intelligent OS Headroom: check available system RAM before launching a new browser.
    // Dynamic reservation: 1.25GB reserved for host OS (desktop, systemd).
    const headroom = getSystemHeadroom();
    if (!headroom.headroomOk) {
      await this.cleanIdleTabs(30 * 60 * 1000);
      const retry = getSystemHeadroom();
      if (!retry.headroomOk) {
        const availMB = Math.round(retry.memAvailableBytes / (1024 * 1024));
        const reservedMB = Math.round(retry.headroomReservedBytes / (1024 * 1024));
        throw new Error(
          `Cannot start browser: host memory headroom reached (${availMB}MB available, reserving ${reservedMB}MB for host OS). Free host memory or close unused tabs.`
        );
      }
    }
    const p = this.#start(profile, opts);
    this.starting.set(slug, p);
    try {
      return await p;
    } finally {
      this.starting.delete(slug);
    }
  }

  // Ensure the browser runs headed inside its Xvnc display, for live
  // viewing. Returns the display info the VNC proxy needs.
  async ensureHeaded(profile) {
    const entry = await this.ensure(profile, { headed: true });
    return { display: entry.display.display, port: entry.display.port, profile: profile.slug, headed: true };
  }

  async #fingerprint(profile, loaders) {
    const file = this.store.browserFingerprintPath(profile.slug);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* draw and store below */
    }
    await ensureFpgenModel(loaders.fpgen);
    // Same draw Camoufox performs internally: Firefox browser, Linux OS.
    const fp = loaders.fpgen.generate({ browser: "Firefox", os: "Linux" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fp, null, 2));
    return fp;
  }

  async #start(profile, opts = {}) {
    const bInfo = await browserInfo();
    if (!bInfo.installed) {
      throw new Error(MISSING_MSG);
    }
    const loaders = await loadLoaders();
    const userDataDir = this.store.browserProfileDir(profile.slug);
    fs.mkdirSync(userDataDir, { recursive: true });
    const fingerprint = await this.#fingerprint(profile, loaders);
    // Headed mode (live viewer): the browser draws into the profile's
    // own Xvnc display. Headless stays the default for plain MCP work:
    // lighter, and nothing needs pixels until a viewer connects.
    let display = null;
    if (opts.headed) {
      display = await startDisplay(profile.slug);
    }
    let context;
    try {
      context = await loaders.camoufox.Camoufox({
        persistent_context: true,
        user_data_dir: userDataDir,
        headless: opts.headed ? false : true,
        ...(opts.headed ? { window: [VIEW_WIDTH, VIEW_HEIGHT], env: { DISPLAY: `:${display.display}` } } : {}),
        os: "linux",
        locale: "en-US",
        fingerprint,
        humanize: false,
        // Pinning the fingerprint is the design (stable identity per bot);
        // this silences Camoufox's "not recommended" LeakWarning.
        i_know_what_im_doing: true,
        timezoneId: "Asia/Karachi",
        viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
        firefox_user_prefs: {
          "toolkit.cosmeticAnimations.enabled": false,
          "general.smoothScroll": false,
          "image.animation_mode": "once",
          "browser.cache.disk.enable": false,
          "browser.cache.memory.enable": true,
          "browser.cache.memory.capacity": 1048576,
          "browser.sessionstore.interval": 600000,
          "datareporting.policy.dataSubmissionEnabled": false,
          "toolkit.telemetry.enabled": false,
          "browser.ping-centre.telemetry": false,
          ...(opts.firefox_user_prefs || {}),
        },
        ...(process.env.CAMOUFOX_EXECUTABLE
          ? { executable_path: process.env.CAMOUFOX_EXECUTABLE }
          : {}),
      });
    } catch (e) {
      if (display) await stopDisplay(profile.slug);
      throw new Error(explainLaunchError(e));
    }
    // Browser downloads persist into the profile's workspace, not the
    // OS download folder: every download is saved under
    // <workspace>/downloads/ with a collision-safe name, so what a bot
    // downloads stays in its own folder.
    const downloadsDir = this.store.profileDownloads(profile.slug);
    this.store.ensureWorkspace(profile.slug);
    const saveDownload = async (dl) => {
      try {
        const raw = dl.suggestedFilename() || "download";
        const base = path.basename(raw).replace(/[\\/]/g, "_") || "download";
        let dest = path.join(downloadsDir, base);
        for (let i = 1; fs.existsSync(dest); i++) {
          const ext = path.extname(base);
          dest = path.join(downloadsDir, `${path.basename(base, ext)}-${i}${ext}`);
        }
        await dl.saveAs(dest);
      } catch {
        /* a failed save must never break browsing */
      }
    };
    const attachDownloads = (pg) => {
      try {
        pg.on("download", saveDownload);
      } catch {
        /* ignore */
      }
    };
    context.on("page", attachDownloads);
    for (const pg of context.pages()) attachDownloads(pg);
    const page = context.pages()[0] || (await context.newPage());
    const entry = { context, page, refs: new Map(), chain: Promise.resolve(), tabs: new Map(), tabCounter: 0, active: page, refMaps: new Map(), headed: !!opts.headed, display, lastActivityAt: Date.now(), pendingOps: 0, viewers: 0 };
    this.contexts.set(profile.slug, entry);
    const firstTab = this.#tabIdFor(entry, page);
    entry.refMaps.set(firstTab, entry.refs);
    // Restore saved tabs after the display/browser becomes available.
    // Waiting for every external website here can exceed the reverse-proxy
    // WebSocket upgrade deadline and produce a misleading VNC 1006.
    entry.pendingOps++;
    entry.chain = Promise.resolve().then(() => this.#restoreOpenTabs(profile.slug, entry))
      .catch((err) => {
        console.warn(`[portal] restore session for ${profile.slug}: ${err.message}`);
      })
      .finally(() => {
        entry.pendingOps--;
        this.#touch(entry);
      });
    this.#touch(entry);
    return entry;
  }

  async status(profile) {
    const e = this.contexts.get(profile.slug);
    if (!e?.context) return { started: false, profile: profile.slug, url: null };
    try {
      this.#syncPages(e);
      const tabs = e.context.pages().map((pg) => ({ tab: e.tabs.get(pg), url: pg.url() }));
      return {
        started: true,
        profile: profile.slug,
        url: e.page ? e.page.url() : null,
        activeTab: e.active ? e.tabs.get(e.active) : null,
        tabs,
        headed: !!e.headed,
      };
    } catch {
      return { started: true, profile: profile.slug, url: null };
    }
  }

  async close(profile, { reason = "manual" } = {}) {
    const slug = profile.slug;
    if (this.closing.has(slug)) return this.closing.get(slug);
    const task = (async () => {
      if (this.starting.has(slug)) await this.starting.get(slug).catch(() => {});
      const e = this.contexts.get(slug);
      if (e?.context) {
        // Complete queued agent actions before checkpointing and terminating.
        await (e.chain || Promise.resolve()).catch(() => {});
        try {
          this.#saveOpenTabs(slug, e);
        } catch (err) {
          // Refuse to sleep rather than silently lose the user's open tabs.
          throw new Error(`Cannot save browser tabs for ${slug}: ${err.message}`);
        }
        try {
          await e.context.close();
        } catch (err) {
          console.warn(`[portal] context close for ${slug}: ${err.message}`);
        }
      }
      if (this.contexts.get(slug) === e) this.contexts.delete(slug);
      // Xvnc must also exit: asleep profiles consume no browser/display CPU or RAM.
      await stopDisplay(slug);
      console.log(`[portal] browser ${slug} closed (${reason})`);
      return { closed: true, sleeping: reason === "idle", profile: slug };
    })();
    this.closing.set(slug, task);
    try {
      return await task;
    } finally {
      this.closing.delete(slug);
    }
  }

  async navigate(profile, url, opts = {}) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      let pg;
      if (opts.newTab) {
        pg = await e.context.newPage();
        const id = this.#tabIdFor(e, pg);
        e.active = pg;
        e.page = pg;
        e.refs = new Map();
        e.refMaps.set(id, e.refs);
      } else {
        pg = await this.#activePage(e, opts.tab);
      }
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        const resp = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        let title = "";
        try {
          title = await pg.title();
        } catch {
          /* ignore */
        }
        return { url: pg.url(), title, status: resp ? resp.status() : null, tab: tabId };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  async snapshot(profile, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        // Playwright evaluates a string argument as an expression: a bare
        // arrow function would come back as an unserializable function
        // (undefined). Invoke it.
        const items = await pg.evaluate(`(${SNAPSHOT_JS})()`);
        const refs = new Map();
        const lines = items.map((it, i) => {
          const ref = `e${i + 1}`;
          refs.set(ref, it.selector || it.xpath);
          const extra = [
            it.disabled ? "disabled" : "",
            it.checked ? "checked" : "",
            it.isPassword ? "password" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `${ref} [${it.role}] ${JSON.stringify(it.name)}${extra ? " " + extra : ""}`;
        });
        e.refs = refs;
        e.refMaps.set(tabId, refs);
        let title = "";
        try {
          title = await pg.title();
        } catch {
          /* ignore */
        }
        return { url: pg.url(), title, tab: tabId, elements: lines.join("\n") };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  async #resolveRef(e, ref) {
    const sel = e.refs.get(ref);
    if (!sel) {
      throw new Error(
        `unknown ref: ${ref}. Take a fresh browser_snapshot first — refs go stale after the page changes.`,
      );
    }
    return sel;
  }

  async click(profile, ref, tab, opts = {}) {
    if (typeof tab === "object" && tab !== null && opts && Object.keys(opts).length === 0) {
      opts = tab;
      tab = undefined;
    }
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        const sel = await this.#resolveRef(e, ref);
        const loc = (sel.startsWith("/") || sel.startsWith("xpath="))
          ? pg.locator(sel.startsWith("xpath=") ? sel : `xpath=${sel}`).first()
          : pg.locator(sel).first();
        if (opts.stealth) {
          await humanMoveAndClick(pg, loc);
        } else {
          // Fast-path: bypass actionability and animation waits
          await loc.click({ force: true, noWaitAfter: true, timeout: 5000 });
        }
        return { ok: true, ref, tab: tabId, url: pg.url() };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  async fill(profile, ref, text, tab, opts = {}) {
    if (typeof tab === "object" && tab !== null && opts && Object.keys(opts).length === 0) {
      opts = tab;
      tab = undefined;
    }
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        const sel = await this.#resolveRef(e, ref);
        const loc = (sel.startsWith("/") || sel.startsWith("xpath="))
          ? pg.locator(sel.startsWith("xpath=") ? sel : `xpath=${sel}`).first()
          : pg.locator(sel).first();
        if (opts.stealth) {
          await loc.click({ timeout: 5000 });
          await pg.keyboard.press("Control+a");
          await pg.keyboard.press("Backspace");
          for (const char of text) {
            await pg.keyboard.type(char, { delay: 60 + Math.random() * 80 });
          }
        } else {
          // Fast-path: instant value assignment
          try {
            await loc.fill(text, { force: true, timeout: 5000 });
          } catch {
            try {
              await loc.selectOption({ label: text }, { timeout: 5000 });
            } catch {
              await loc.click({ force: true, timeout: 5000 });
              await pg.keyboard.press("Control+a");
              await pg.keyboard.type(text);
            }
          }
        }
        return { ok: true, ref, tab: tabId };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  async press(profile, key, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        await pg.keyboard.press(key, { timeout: 10000 });
        return { ok: true, key, tab: tabId };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  // Secret stays in the broker; only the outcome enters the tool transcript.
  // Never expose the value in snapshots, logs, or tool results.
  async fillVaultLogin(profile, vault, itemId, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const page = await this.#activePage(e, tab);
      const tabId = e.tabs.get(page);
      this.#touchTab(e, tabId, true);
      try {
        const pageUrl = page.url();
        // Check field presence before decrypting or retrieving the secret.
        // Target visible password inputs so hidden mobile/SSO inputs do not block login.
        const pass = page.locator('input[type="password"]:visible').first();
        if ((await pass.count()) === 0 || !(await pass.isVisible()))
          throw new Error("No visible password input in the main document");

        let targetId = typeof itemId === "string" && itemId.trim() ? itemId.trim() : null;
        if (!targetId) {
          let pageOrigin;
          try {
            pageOrigin = new URL(pageUrl).origin;
          } catch {
            throw new Error(`Invalid page URL: ${pageUrl}`);
          }
          const matches = vault.list(profile).filter((entry) => entry.origin === pageOrigin);
          if (matches.length === 0) {
            throw new Error(`No credentials found for origin ${pageOrigin}`);
          }
          if (matches.length > 1) {
            const ids = matches.map((m) => m.id).join(", ");
            throw new Error(`Multiple credentials match origin ${pageOrigin}: ${ids}. Please specify item_id.`);
          }
          targetId = matches[0].id;
        }

        const login = await vault.getLogin(profile, targetId, pageUrl);
        // Re-check origin after async vault lookup to prevent navigation races.
        if (new URL(page.url()).origin !== new URL(pageUrl).origin)
          throw new Error("Login page changed during credential lookup");
        if (login.username) {
          const name = page.locator(
            'input[autocomplete="username"]:visible, input[type="email"]:visible, input[name="username"]:visible, input#username:visible, input[name="session_key"]:visible, input[name="login"]:visible'
          ).first();
          if ((await name.count()) && (await name.isVisible())) await name.fill(login.username);
        }
        await pass.fill(login.password);
        return {
          success: true,
          profile: profile.slug,
          tab: tabId,
          origin: new URL(pageUrl).origin,
          itemId: targetId,
        };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  async content(profile, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        let title = "";
        try {
          title = await pg.title();
        } catch {
          /* ignore */
        }
        const text = await pg.evaluate(
          "(() => (document.body ? document.body.innerText.slice(0, 50000) : ''))()",
        );
        return { url: pg.url(), title, tab: tabId, text };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }

  async screenshot(profile, tab, opts = {}) {
    if (typeof tab === "object" && tab !== null && opts && Object.keys(opts).length === 0) {
      opts = tab;
      tab = undefined;
    }
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const tabId = e.tabs.get(pg);
      this.#touchTab(e, tabId, true);
      try {
        let title = "";
        try {
          title = await pg.title();
        } catch {
          /* ignore */
        }
        const shotOpts = {};
        if (opts.fullPage) shotOpts.fullPage = true;
        if (opts.timeout) shotOpts.timeout = opts.timeout;
        const buffer = await pg.screenshot(shotOpts);
        return { url: pg.url(), title, tab: tabId, buffer };
      } finally {
        this.#touchTab(e, tabId, false);
      }
    });
  }
}
