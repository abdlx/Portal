// Portal-native encrypted credential vault.
// Per-bot AES-256-GCM encrypted files; independent profile-derived keys.
// Master key lives in PORTAL_HOME/credential-master.key (0600), never in
// the browser profile, user workspace, or MCP tool responses.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9_-]{1,50}$/;

function atomicWrite(file, value) {
  const temp = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

export function normalizeOrigin(input) {
  if (typeof input !== "string" || input.length > 2048) throw new Error("Enter a valid HTTPS site URL");
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a valid HTTPS site URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname)
    throw new Error("Only HTTPS origins without embedded credentials are allowed");
  return url.origin;
}

export class CredentialVault {
  constructor(store) {
    this.store = store;
    this.dir = path.join(store.home, "credential-vault");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const file = path.join(store.home, "credential-master.key");
    // Use O_EXCL so concurrent Portal launches cannot silently replace the key.
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, crypto.randomBytes(32)); }
      finally { fs.closeSync(fd); }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw new Error("Invalid credential vault master key");
    this.master = key;
  }

  #file(profile) {
    if (!SLUG.test(profile.slug)) throw new Error("Invalid profile slug");
    return path.join(this.dir, profile.slug + ".enc");
  }

  #key(profile) {
    // A unique derived encryption key for each profile.
    return Buffer.from(crypto.hkdfSync("sha256", this.master, Buffer.from(profile.id), Buffer.from("portal-credentials-v1"), 32));
  }

  #load(profile) {
    const file = this.#file(profile);
    if (!fs.existsSync(file)) return [];
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    if (envelope.v !== 1) throw new Error("Unsupported encrypted credential format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.#key(profile), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(profile.id));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const result = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    const entries = JSON.parse(result.toString("utf8"));
    if (!Array.isArray(entries)) throw new Error("Invalid vault contents");
    return entries;
  }

  #save(profile, entries) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#key(profile), iv);
    cipher.setAAD(Buffer.from(profile.id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
    atomicWrite(this.#file(profile), JSON.stringify({
      v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    }));
  }

  list(profile) {
    return this.#load(profile).map(({ id, name, origin, username, updatedAt }) => ({
      id, name, origin, username, updatedAt,
    }));
  }

  add(profile, input) {
    const { name, origin, username, password } = input || {};
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Credential name required (max 120 characters)");
    if (typeof username !== "string" || username.length > 320) throw new Error("Username must be a string");
    if (typeof password !== "string" || !password || password.length > 16384) throw new Error("Password required (max 16 KiB)");
    const entry = {
      id: crypto.randomUUID(), name: name.trim(), origin: normalizeOrigin(origin),
      username, password, updatedAt: Date.now(),
    };
    const entries = this.#load(profile);
    entries.push(entry);
    this.#save(profile, entries);
    return { id: entry.id, name: entry.name, origin: entry.origin, username: entry.username, updatedAt: entry.updatedAt };
  }

  remove(profile, id) {
    if (!UUID.test(id)) throw new Error("Invalid credential ID");
    const entries = this.#load(profile);
    const updated = entries.filter((x) => x.id !== id);
    if (entries.length === updated.length) throw new Error("Credential not found in this profile");
    this.#save(profile, updated);
    return { deleted: true, id };
  }

  getLogin(profile, id, pageUrl) {
    if (!UUID.test(id)) throw new Error("Invalid credential ID");
    const actual = normalizeOrigin(pageUrl);
    const item = this.#load(profile).find((x) => x.id === id);
    if (!item) throw new Error("Credential not found in this profile");
    if (item.origin !== actual) throw new Error("Browser origin does not match the saved credential");
    return { username: item.username || null, password: item.password };
  }
}
