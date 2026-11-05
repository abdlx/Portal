// Optional Vaultwarden integration via the official Bitwarden CLI.
// One BITWARDENCLI_APPDATA_DIR per Portal bot; decrypted session keys live
// only in Portal process memory and are supplied by the local owner.
// The agent only supplies an item UUID and receives a boolean outcome.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class VaultwardenBroker {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
  }

  directory(profile) {
    if (!/^[a-z0-9_-]{1,50}$/.test(profile.slug)) throw new Error("Invalid profile");
    const dir = path.join(this.store.home, "vaultwarden", profile.slug);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  }

  async run(profile, args) {
    const session = this.sessions.get(profile.slug);
    if (!session) throw new Error("Vault locked: owner must unlock this bot's Vaultwarden account");
    const { stdout } = await exec("bw", args, {
      timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, BITWARDENCLI_APPDATA_DIR: this.directory(profile), BW_SESSION: session },
    });
    return stdout;
  }

  unlock(profile, session) {
    if (typeof session !== "string" || session.length < 20 || session.length > 4096)
      throw new Error("Invalid BW_SESSION");
    this.sessions.set(profile.slug, session);
  }

  lock(profile) {
    this.sessions.delete(profile.slug);
  }

  status(profile) {
    return { profile: profile.slug, configured: fs.existsSync(path.join(this.directory(profile), "data.json")), unlocked: this.sessions.has(profile.slug) };
  }

  async list(profile) {
    const items = JSON.parse(await this.run(profile, ["list", "items"]));
    return items.filter((x) => x.type === 1 && x.login).map((x) => ({
      id: x.id, name: x.name, origins: (x.login.uris || []).map((u) => u.uri).filter(Boolean),
    }));
  }

  async getLogin(profile, id, pageUrl) {
    if (!UUID.test(id)) throw new Error("Vault item must be an exact UUID");
    const item = JSON.parse(await this.run(profile, ["get", "item", id]));
    if (item.id?.toLowerCase() !== id.toLowerCase() || item.type !== 1 || !item.login?.password)
      throw new Error("Vault item is not a password login");
    const actual = new URL(pageUrl);
    if (actual.protocol !== "https:") throw new Error("Autofill requires HTTPS");
    const allowed = (item.login.uris || []).some((u) => {
      try {
        const target = new URL(u.uri);
        return target.protocol === "https:" && target.origin === actual.origin;
      } catch { return false; }
    });
    if (!allowed) throw new Error("Page origin not authorized by this vault item");
    return { username: item.login.username || null, password: item.login.password };
  }
}
