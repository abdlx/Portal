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
//   - humanize: true (human-like mouse movement, wrapper-level).
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

const SNAPSHOT_JS = `() => {
  const out = [];
  const seen = new Set();
  const sels = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="tab"], [contenteditable="true"], summary';
  const els = document.querySelectorAll(sels);
  function xpathFor(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      let idx = 1;
      let sib = n.previousElementSibling;
      while (sib) { if (sib.tagName === n.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(tag + '[' + idx + ']');
      n = n.parentElement;
      if (parts.length > 12) break;
    }
    return '/' + parts.join('/');
  }
  for (const el of els) {
    if (out.length >= 300) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const xp = xpathFor(el);
    if (seen.has(xp)) continue;
    seen.add(xp);
    const text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || text || el.tagName).slice(0, 80);
    const role = el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'textbox',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button'}[el.tagName] || el.tagName.toLowerCase());
    out.push({ tag: el.tagName.toLowerCase(), role, name, text, xpath: xp, disabled: !!el.disabled, checked: el.checked === true });
  }
  return out;
}`;

export class BrowserManager {
  constructor(store) {
    this.store = store;
    this.contexts = new Map(); // slug -> { context, page, refs: Map, chain: Promise }
    this.starting = new Map();
  }

  #chain(slug, fn) {
    const prev = this.contexts.get(slug)?.chain || Promise.resolve();
    const next = prev.then(fn, fn);
    const entry = this.contexts.get(slug);
    if (entry) entry.chain = next;
    else this.contexts.set(slug, { context: null, page: null, refs: new Map(), chain: next, tabs: new Map(), tabCounter: 0, active: null, refMaps: new Map() });
    return next;
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
    }
    return id;
  }

  #syncPages(entry) {
    if (!entry.context) return;
    const live = new Set(entry.context.pages());
    for (const [pg, id] of [...entry.tabs]) {
      if (!live.has(pg)) {
        entry.tabs.delete(pg);
        entry.refMaps.delete(id);
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
      let status = null;
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
      tabs.push({ tab: entry.tabs.get(pg), url: pg.url(), title });
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
      let title = "";
      try {
        title = await pg.title();
      } catch {
        /* ignore */
      }
      return { tab: e.tabs.get(pg), url: pg.url(), title };
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
    const existing = this.contexts.get(slug);
    if (existing?.context) {
      if (opts.headed && !existing.headed) {
        await this.close(profile);
      } else {
        return existing;
      }
    }
    if (this.starting.has(slug)) return this.starting.get(slug);
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
        humanize: true,
        // Pinning the fingerprint is the design (stable identity per bot);
        // this silences Camoufox's "not recommended" LeakWarning.
        i_know_what_im_doing: true,
        timezoneId: "Asia/Karachi",
        viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
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
    const entry = { context, page, refs: new Map(), chain: Promise.resolve(), tabs: new Map(), tabCounter: 0, active: page, refMaps: new Map(), headed: !!opts.headed, display };
    this.contexts.set(profile.slug, entry);
    const firstTab = this.#tabIdFor(entry, page);
    entry.refMaps.set(firstTab, entry.refs);
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

  async close(profile) {
    const e = this.contexts.get(profile.slug);
    if (e?.context) {
      try {
        await e.context.close();
      } catch {
        /* already closed */
      }
    }
    this.contexts.delete(profile.slug);
    // The display belongs to the browser session: no browser, no view.
    // Awaited: a lingering Xvnc would hold its display number and
    // poison the next allocation (see vnc.mjs).
    await stopDisplay(profile.slug);
    return { closed: true, profile: profile.slug };
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
      const resp = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      let title = "";
      try {
        title = await pg.title();
      } catch {
        /* ignore */
      }
      return { url: pg.url(), title, status: resp ? resp.status() : null, tab: e.tabs.get(pg) };
    });
  }

  async snapshot(profile, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      // Playwright evaluates a string argument as an expression: a bare
      // arrow function would come back as an unserializable function
      // (undefined). Invoke it.
      const items = await pg.evaluate(`(${SNAPSHOT_JS})()`);
      const refs = new Map();
      const lines = items.map((it, i) => {
        const ref = `e${i + 1}`;
        refs.set(ref, it.xpath);
        const extra = [
          it.disabled ? "disabled" : "",
          it.checked ? "checked" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `${ref} [${it.role}] ${JSON.stringify(it.name)}${extra ? " " + extra : ""}`;
      });
      e.refs = refs;
      e.refMaps.set(e.tabs.get(pg), refs);
      let title = "";
      try {
        title = await pg.title();
      } catch {
        /* ignore */
      }
      return { url: pg.url(), title, tab: e.tabs.get(pg), elements: lines.join("\n") };
    });
  }

  async #resolveRef(e, ref) {
    const xpath = e.refs.get(ref);
    if (!xpath) {
      throw new Error(
        `unknown ref: ${ref}. Take a fresh browser_snapshot first — refs go stale after the page changes.`,
      );
    }
    return xpath;
  }

  async click(profile, ref, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const xpath = await this.#resolveRef(e, ref);
      await pg.locator(`xpath=${xpath}`).first().click({ timeout: 10000 });
      return { ok: true, ref, tab: e.tabs.get(pg), url: pg.url() };
    });
  }

  async fill(profile, ref, text, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      const xpath = await this.#resolveRef(e, ref);
      const loc = pg.locator(`xpath=${xpath}`).first();
      try {
        await loc.fill(text, { timeout: 10000 });
      } catch {
        try {
          await loc.selectOption({ label: text }, { timeout: 5000 });
        } catch {
          await loc.click({ timeout: 10000 });
          await pg.keyboard.press("Control+a");
          await pg.keyboard.type(text);
        }
      }
      return { ok: true, ref, tab: e.tabs.get(pg) };
    });
  }

  async press(profile, key, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      await pg.keyboard.press(key, { timeout: 10000 });
      return { ok: true, key, tab: e.tabs.get(pg) };
    });
  }

  async content(profile, tab) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const pg = await this.#activePage(e, tab);
      let title = "";
      try {
        title = await pg.title();
      } catch {
        /* ignore */
      }
      const text = await pg.evaluate(
        "(() => (document.body ? document.body.innerText.slice(0, 50000) : ''))()",
      );
      return { url: pg.url(), title, tab: e.tabs.get(pg), text };
    });
  }
}
