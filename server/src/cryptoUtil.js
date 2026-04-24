import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey() {
  const s = process.env.DEVCLAW_ENCRYPTION_KEY || process.env.JWT_SECRET || "devclaw-dev-only-change-me";
  return crypto.createHash("sha256").update(s).digest();
}

export function encryptSecret(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(b64) {
  if (!b64) return "";
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
