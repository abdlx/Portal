import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialVault, normalizeOrigin, originsMatch } from "../src/credential-vault.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "portal-secrets-"));
const profiles = [
  { id: "prof_abcdef12", slug: "ezra" },
  { id: "prof_1234abcd", slug: "leo" },
];
try {
  const vault = new CredentialVault({ home });
  const item = vault.add(profiles[0], {
    name: "Test Account",
    origin: "https://example.com/login",
    username: "alice",
    password: "SHOULD_NOT_BE_IN_ANY_RESPONSE",
  });
  assert.equal(vault.list(profiles[0]).length, 1);
  assert.equal(vault.list(profiles[1]).length, 0);
  assert.equal(JSON.stringify(item).includes("SHOULD_NOT"), false);
  assert.equal(JSON.stringify(vault.list(profiles[0])).includes("SHOULD_NOT"), false);
  assert.equal(vault.getLogin(profiles[0], item.id, "https://example.com/auth").password, "SHOULD_NOT_BE_IN_ANY_RESPONSE");
  assert.throws(() => vault.getLogin(profiles[0], item.id, "https://evil.example.com"));
  assert.throws(() => vault.getLogin(profiles[1], item.id, "https://example.com"));
  assert.throws(() => normalizeOrigin("http://example.com"));
  assert.equal(fs.readFileSync(path.join(home, "credential-vault", profiles[0].id + ".enc"), "utf8").includes("SHOULD_NOT"), false);
  const reload = new CredentialVault({ home });
  assert.equal(reload.getLogin(profiles[0], item.id, "https://example.com").username, "alice");
  const renamed = { ...profiles[0], slug: "social-agent" };
  assert.equal(reload.getLogin(renamed, item.id, "https://example.com").username, "alice");
  // Test originsMatch helper directly
  assert.equal(originsMatch("https://linkedin.com", "https://www.linkedin.com"), true);
  assert.equal(originsMatch("https://www.linkedin.com", "https://linkedin.com"), true);
  assert.equal(originsMatch("https://linkedin.com", "https://linkedin.com"), true);
  assert.equal(originsMatch("https://linkedin.com", "https://evil.linkedin.com"), false);
  assert.equal(originsMatch("https://linkedin.com", "http://www.linkedin.com"), false);
  assert.equal(originsMatch("https://linkedin.com:8443", "https://www.linkedin.com:8443"), true);
  assert.equal(originsMatch("https://linkedin.com:8443", "https://www.linkedin.com:9443"), false);
  assert.equal(originsMatch("invalid-url", "https://linkedin.com"), false);

  // Test getLogin with apex origin matching www subdomain
  const linkedinItem = vault.add(profiles[0], {
    name: "LinkedIn Apex Account",
    origin: "https://linkedin.com",
    username: "abdullah",
    password: "LINKEDIN_SECRET_PASSWORD",
  });
  assert.equal(vault.getLogin(profiles[0], linkedinItem.id, "https://www.linkedin.com/login/").password, "LINKEDIN_SECRET_PASSWORD");
  assert.equal(vault.getLogin(profiles[0], linkedinItem.id, "https://linkedin.com/login/").password, "LINKEDIN_SECRET_PASSWORD");
  assert.throws(() => vault.getLogin(profiles[0], linkedinItem.id, "https://evil.linkedin.com/login/"));

  assert.equal(reload.remove(profiles[0], item.id).deleted, true);
  assert.equal(reload.remove(profiles[0], linkedinItem.id).deleted, true);
  assert.equal(reload.list(profiles[0]).length, 0);
  console.log("PASS encrypted per-bot storage, isolation, origin validation, persistence, rename, deletion");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
