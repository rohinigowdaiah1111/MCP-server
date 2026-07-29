import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

/**
 * Encryption-at-rest for the Google OAuth token file (implementationplan.md,
 * Section 6 — "Token storage: encrypted at rest").
 *
 * This server runs as a single local process for one user, so rather than a
 * KMS/secret-manager integration we derive a local symmetric key once and
 * reuse it to seal token.json with AES-256-GCM. The key itself can be
 * supplied via TOKEN_ENCRYPTION_KEY (base64, 32 bytes) for environments that
 * manage secrets externally; otherwise a random key is generated on first
 * run and stored in a git-ignored, owner-only-readable file next to the
 * token.
 */
const ALGORITHM = "aes-256-gcm";
const KEY_PATH = path.join(PROJECT_ROOT, ".token.key");

function loadOrCreateKey(): Buffer {
  const envKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (envKey) {
    const key = Buffer.from(envKey, "base64");
    if (key.length !== 32) {
      throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).");
    }
    return key;
  }

  if (fs.existsSync(KEY_PATH)) {
    return Buffer.from(fs.readFileSync(KEY_PATH, "utf-8").trim(), "base64");
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString("base64"), { mode: 0o600 });
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits (e.g. Windows) */
  }
  return key;
}

interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as EncryptedEnvelope).v === 1 &&
    typeof (value as EncryptedEnvelope).iv === "string" &&
    typeof (value as EncryptedEnvelope).tag === "string" &&
    typeof (value as EncryptedEnvelope).data === "string"
  );
}

export function encryptJson(payload: unknown): string {
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  return JSON.stringify(envelope, null, 2);
}

/** True if `raw` is already in the encrypted envelope format written by `encryptJson`. */
export function isEncryptedFormat(raw: string): boolean {
  try {
    return isEncryptedEnvelope(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * Decrypts a token file previously written by `encryptJson`. For backward
 * compatibility with token.json files written before encryption was added,
 * falls back to parsing the content as plain JSON.
 */
export function decryptJson<T>(raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Token file is not valid JSON and could not be read.");
  }

  if (!isEncryptedEnvelope(parsed)) {
    // Legacy plaintext token file — caller is responsible for re-saving
    // (encrypted) after this returns.
    return parsed as T;
  }

  const key = loadOrCreateKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8")) as T;
}
