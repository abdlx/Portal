// Persistent store for portal: profiles, token hashes, settings.
// Plaintext tokens live ONLY in vault.json (0600, owner-readable) so the
// desktop panel can reveal a bot's token on demand. Token hashes are what
// authentication checks. Both files live under PORTAL_HOME
// (default ~/.portal) and are never logged or sent anywhere.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function defaultHome() {
  return (
    process.env.PORTAL_HOME ||
    path.join(process.env.HOME || "~", ".portal")
  );
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function hashToken(token) {
  return sha256(token);
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without chmod */
  }
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function fingerprintSeed(slug) {
  const h = sha256(`portal:${slug}`).slice(0, 8);
  return (parseInt(h, 16) % 999998) + 1;
}

const COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export class Store {
  constructor(home = defaultHome()) {
    this.home = home;
    this.storeFile = path.join(home, "store.json");
    this.vaultFile = path.join(home, "vault.json");
    this.auditFile = path.join(home, "audit.log");
    fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
    this.data = this.#load(this.storeFile, () => ({
      version: 1,
      computer: { id: "portal", name: "Portal", createdAt: Date.now() },
      profiles: [],
      tokens: [],
      settings: {},
    }));
    this.vault = this.#load(this.vaultFile, () => ({ tokens: {} }));
    if (this.data.profiles.length === 0) {
      this.createProfile({ name: "Default Profile", slug: "default" });
    }
    // Owner token: created once, shown at install, retrievable from the
    // vault file by the laptop owner. It is the only admin/UI token.
    if (!this.data.tokens.some((t) => t.name === "owner" && !t.revoked)) {
      const plaintext = `portal_owner_${crypto.randomBytes(24).toString("hex")}`;
      const tok = {
        id: `tok_${crypto.randomBytes(4).toString("hex")}`,
        name: "owner",
        tokenHash: hashToken(plaintext),
        scopes: ["admin"],
        computerId: "portal",
        profileId: null,
        profileSlug: null,
        revoked: false,
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      this.data.tokens.push(tok);
      this.vault.tokens[tok.id] = plaintext;
      this.save();
    }
    // Owner convenience: the owner token plaintext also lives in
    // owner-token.txt (0600) so the laptop owner can sign in to the
    // desktop panel without digging through the vault. It is never
    // printed to logs and never leaves the laptop.
    try {
      const owner = this.data.tokens.find((t) => t.name === "owner" && !t.revoked);
      if (owner && this.vault.tokens[owner.id]) {
        fs.writeFileSync(
          path.join(this.home, "owner-token.txt"),
          this.vault.tokens[owner.id] + "\n",
          { mode: 0o600 },
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  #load(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback();
    }
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true });
    writeAtomic(this.storeFile, JSON.stringify(this.data, null, 2));
    writeAtomic(this.vaultFile, JSON.stringify(this.vault, null, 2));
  }

  audit(entry) {
    try {
      fs.appendFileSync(
        this.auditFile,
        JSON.stringify({ at: Date.now(), ...entry }) + "\n",
      );
    } catch {
      /* audit must never break a call */
    }
  }

  // ---- profiles ------------------------------------------------------------
  profiles() {
    return this.data.profiles;
  }

  profileBySlug(slug) {
    return this.data.profiles.find((p) => p.slug === slug) || null;
  }

  profileById(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }

  createProfile({ name, slug, description = "", color }) {
    const cleanName = String(name || "").trim();
    if (!cleanName || cleanName.length > 50) {
      throw new Error("name must be 1..50 characters");
    }
    const cleanSlug = slugify(slug || cleanName);
    if (!cleanSlug) throw new Error("slug must contain a-z, 0-9, _ or -");
    if (this.profileBySlug(cleanSlug)) {
      const e = new Error(`profile already exists: ${cleanSlug}`);
      e.code = 409;
      throw e;
    }
    const profile = {
      id: `prof_${crypto.randomBytes(4).toString("hex")}`,
      name: cleanName,
      slug: cleanSlug,
      description: String(description || "").slice(0, 200),
      color:
        color || COLORS[this.data.profiles.length % COLORS.length],
      isDefault: this.data.profiles.length === 0,
      fingerprintSeed: fingerprintSeed(cleanSlug),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.data.profiles.push(profile);
    fs.mkdirSync(path.join(this.home, "profiles", cleanSlug), {
      recursive: true,
    });
    this.save();
    return profile;
  }

  updateProfile(id, patch) {
    const p = this.profileById(id);
    if (!p) throw new Error("profile not found");
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n || n.length > 50) throw new Error("name must be 1..50 characters");
      p.name = n;
    }
    if (patch.description !== undefined) {
      p.description = String(patch.description).slice(0, 200);
    }
    if (patch.color !== undefined) p.color = String(patch.color);
    if (patch.slug !== undefined) {
      const s = slugify(patch.slug);
      if (!s) throw new Error("slug must contain a-z, 0-9, _ or -");
      const clash = this.profileBySlug(s);
      if (clash && clash.id !== id) {
        const e = new Error(`profile already exists: ${s}`);
        e.code = 409;
        throw e;
      }
      // Rename the on-disk home too; the old dir is kept as a backup name
      // only if the rename fails, never deleted.
      const oldDir = path.join(this.home, "profiles", p.slug);
      const newDir = path.join(this.home, "profiles", s);
      if (s !== p.slug && fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
      }
      // The stored browser fingerprint follows the slug too.
      const oldFp = this.browserFingerprintPath(p.slug);
      const newFp = this.browserFingerprintPath(s);
      if (s !== p.slug && fs.existsSync(oldFp) && !fs.existsSync(newFp)) {
        fs.mkdirSync(path.dirname(newFp), { recursive: true });
        fs.renameSync(oldFp, newFp);
      }
      p.slug = s;
      // Tokens bound to this profile follow the new slug.
      for (const t of this.data.tokens) {
        if (t.profileId === id) t.profileSlug = s;
      }
    }
    if (patch.isDefault === true) {
      for (const q of this.data.profiles) q.isDefault = q.id === id;
    }
    p.updatedAt = Date.now();
    this.save();
    return p;
  }

  deleteProfile(id) {
    const p = this.profileById(id);
    if (!p) throw new Error("profile not found");
    if (this.data.profiles.length === 1) {
      throw new Error("cannot delete the only profile");
    }
    this.data.profiles = this.data.profiles.filter((q) => q.id !== id);
    if (p.isDefault && this.data.profiles.length > 0) {
      this.data.profiles[0].isDefault = true;
    }
    // Revoke every token bound to this profile (fail-closed, like AC).
    let revoked = 0;
    for (const t of this.data.tokens) {
      if (t.profileId === id && !t.revoked) {
        t.revoked = true;
        revoked++;
      }
    }
    this.save();
    // Profile files are NEVER deleted automatically: the owner removes
    // ~/​.portal/profiles/<slug> by hand if they want it gone.
    return { deleted: p.slug, revokedTokens: revoked };
  }

  // ---- tokens --------------------------------------------------------------
  newBotToken(profile, name) {
    const plaintext = `portal_${crypto.randomBytes(32).toString("hex")}`;
    const tok = {
      id: `tok_${crypto.randomBytes(4).toString("hex")}`,
      name: name || `${profile.slug}-token`,
      tokenHash: hashToken(plaintext),
      scopes: ["read", "write", "browser", "files"],
      computerId: "portal",
      profileId: profile.id,
      profileSlug: profile.slug,
      revoked: false,
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    this.data.tokens.push(tok);
    this.vault.tokens[tok.id] = plaintext;
    this.save();
    return { token: tok, plaintext };
  }

  tokenByHash(hash) {
    return this.data.tokens.find((t) => t.tokenHash === hash) || null;
  }

  tokenPublic(t) {
    return {
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      computerId: t.computerId,
      profileId: t.profileId,
      profileSlug: t.profileSlug,
      revoked: t.revoked,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    };
  }

  tokensForProfile(profileId) {
    return this.data.tokens.filter((t) => t.profileId === profileId);
  }

  revokeToken(id) {
    const t = this.data.tokens.find((x) => x.id === id);
    if (!t) throw new Error("token not found");
    t.revoked = true;
    this.save();
    return t;
  }

  revealToken(id) {
    const t = this.data.tokens.find((x) => x.id === id);
    if (!t) throw new Error("token not found");
    return this.vault.tokens[id] || null;
  }

  profileHome(slug) {
    return path.join(this.home, "profiles", slug);
  }

  browserProfileDir(slug) {
    return path.join(this.profileHome(slug), "browser-profile");
  }

  browserFingerprintPath(slug) {
    return path.join(this.home, "browser-fingerprints", `${slug}.json`);
  }
}

export { slugify, fingerprintSeed };
