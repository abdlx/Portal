// Browser layer: one persistent CloakBrowser context per bot profile,
// driven through the cloakbrowser wrapper's own launchPersistentContext
// (Playwright under the hood) — NOT raw playwright-core, NOT agent-browser,
// NOT cloakserve. Each profile gets:
//   - its own user-data-dir (cookies, logins, storage persist on disk),
//   - one fixed --fingerprint seed (stable identity across restarts),
//   - timezone Asia/Karachi + locale en-US via binary flags (not CDP
//     emulation, which the wrapper strips as detectable),
//   - humanize: true (human-like mouse/keyboard/scroll, wrapper-level).
// Engine patches live in the binary itself (C++ level); this layer adds
// no JavaScript injection and no UA overrides.
//
// LICENSE, read from the installed package (cloakbrowser 0.7.0, verified
// 2026-11-03 from node_modules): the wrapper is MIT, but the stealth
// binary is distributed behind a key from cloakbrowser.dev. A FREE key
// (obtained interactively with `npx cloakbrowser login`, or pasted via
// the CLOAKBROWSER_LICENSE_KEY env var) allows the latest binary with
// ONE concurrent browser session. A Pro key lifts that limit. There is
// no keyless headless launch: in a server process (no TTY) ensureBinary
// fails with PromptClosedError, which this layer turns into an
// actionable error telling the owner to run the login on the laptop.
// Consequence, enforced here: starting one bot's browser closes any
// other bot's running browser first. Profiles persist on disk, so only
// the live page is lost — never cookies or logins.
import fs from "node:fs";

const MISSING_MSG =
  "CloakBrowser is not installed yet. Open the Portal desktop app and press Install CloakBrowser, or run `npm install` in the app directory, then try again.";
const LICENSE_MSG =
  "No CloakBrowser license key is saved on this laptop. In a terminal on the laptop run: npx cloakbrowser login (choose the free key, or paste a Pro key), then restart the portal service. The free key allows one browser session at a time.";

let wrapperPromise = null;

async function loadWrapper() {
  if (!wrapperPromise) {
    wrapperPromise = import("cloakbrowser").catch((e) => {
      wrapperPromise = null;
      throw new Error(`${MISSING_MSG} (cloakbrowser package: ${e.message})`);
    });
  }
  return wrapperPromise;
}

function isLicenseError(e) {
  const m = String(e?.message || "") + String(e?.name || "");
  return (
    /PromptClosed/i.test(m) ||
    /license/i.test(m) ||
    /CLOAKBROWSER_LICENSE_KEY/i.test(m)
  );
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
  wrapperPromise = null;
}

export async function browserInfo() {
  // binaryInfo() reads the cache from disk — no download, no launch.
  try {
    if (process.env.CLOAKBROWSER_EXECUTABLE && isExecutableFile(process.env.CLOAKBROWSER_EXECUTABLE)) {
      return { installed: true, executable: process.env.CLOAKBROWSER_EXECUTABLE, version: null };
    }
    const mod = await loadWrapper();
    const info = mod.binaryInfo ? mod.binaryInfo() : null;
    if (info && info.installed && info.binaryPath) {
      return { installed: true, executable: info.binaryPath, version: info.version };
    }
    return { installed: false, executable: null, version: info?.version ?? null, error: MISSING_MSG };
  } catch (e) {
    return { installed: false, executable: null, version: null, error: e.message };
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
    while (n && n.nodeType === 1 && n.tagName.toLowerCase() !== 'html') {
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
    else this.contexts.set(slug, { context: null, page: null, refs: new Map(), chain: next });
    return next;
  }

  async ensure(profile) {
    const slug = profile.slug;
    const existing = this.contexts.get(slug);
    if (existing?.context) return existing;
    if (this.starting.has(slug)) return this.starting.get(slug);
    const p = this.#start(profile);
    this.starting.set(slug, p);
    try {
      return await p;
    } finally {
      this.starting.delete(slug);
    }
  }

  async #start(profile) {
    // Free-key rule: one concurrent browser session. Close any other
    // bot's running browser first; its profile is on disk, so nothing
    // persistent is lost.
    for (const [slug, entry] of [...this.contexts.entries()]) {
      if (slug !== profile.slug && entry.context) {
        try {
          await entry.context.close();
        } catch {
          /* ignore */
        }
        this.contexts.delete(slug);
      }
    }
    const mod = await loadWrapper();
    if (typeof mod.launchPersistentContext !== "function") {
      throw new Error(`${MISSING_MSG} (installed cloakbrowser package has no launchPersistentContext)`);
    }
    const userDataDir = this.store.browserProfileDir(profile.slug);
    fs.mkdirSync(userDataDir, { recursive: true });
    let context;
    try {
      context = await mod.launchPersistentContext({
        userDataDir,
        headless: true,
        args: [`--fingerprint=${profile.fingerprintSeed}`],
        timezone: "Asia/Karachi",
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
        humanize: true,
      });
    } catch (e) {
      if (isLicenseError(e)) throw new Error(LICENSE_MSG);
      throw e;
    }
    const page = context.pages()[0] || (await context.newPage());
    const entry = { context, page, refs: new Map(), chain: Promise.resolve() };
    this.contexts.set(profile.slug, entry);
    return entry;
  }

  async status(profile) {
    const e = this.contexts.get(profile.slug);
    if (!e?.context) return { started: false, profile: profile.slug, url: null };
    try {
      return { started: true, profile: profile.slug, url: e.page.url() };
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
    return { closed: true, profile: profile.slug };
  }

  async navigate(profile, url) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const resp = await e.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      let title = "";
      try {
        title = await e.page.title();
      } catch {
        /* ignore */
      }
      return { url: e.page.url(), title, status: resp ? resp.status() : null };
    });
  }

  async snapshot(profile) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const items = await e.page.evaluate(SNAPSHOT_JS);
      e.refs = new Map();
      const lines = items.map((it, i) => {
        const ref = `e${i + 1}`;
        e.refs.set(ref, it.xpath);
        const extra = [
          it.disabled ? "disabled" : "",
          it.checked ? "checked" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `${ref} [${it.role}] ${JSON.stringify(it.name)}${extra ? " " + extra : ""}`;
      });
      let title = "";
      try {
        title = await e.page.title();
      } catch {
        /* ignore */
      }
      return { url: e.page.url(), title, elements: lines.join("\n") };
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

  async click(profile, ref) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const xpath = await this.#resolveRef(e, ref);
      await e.page.locator(`xpath=${xpath}`).first().click({ timeout: 10000 });
      return { ok: true, ref, url: e.page.url() };
    });
  }

  async fill(profile, ref, text) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      const xpath = await this.#resolveRef(e, ref);
      const loc = e.page.locator(`xpath=${xpath}`).first();
      try {
        await loc.fill(text, { timeout: 10000 });
      } catch {
        try {
          await loc.selectOption({ label: text }, { timeout: 5000 });
        } catch {
          await loc.click({ timeout: 10000 });
          await e.page.keyboard.press("Control+a");
          await e.page.keyboard.type(text);
        }
      }
      return { ok: true, ref };
    });
  }

  async press(profile, key) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      await e.page.keyboard.press(key, { timeout: 10000 });
      return { ok: true, key };
    });
  }

  async content(profile) {
    const e = await this.ensure(profile);
    return this.#chain(profile.slug, async () => {
      let title = "";
      try {
        title = await e.page.title();
      } catch {
        /* ignore */
      }
      const text = await e.page.evaluate(
        "() => document.body ? document.body.innerText.slice(0, 50000) : ''",
      );
      return { url: e.page.url(), title, text };
    });
  }
}
