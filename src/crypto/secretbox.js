import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM fuer Geheimnisse, die das Panel wieder im Klartext braucht —
 * allen voran RCon-Passwoerter, die es an den Spielserver weitergibt. Gleiches
 * Verfahren wie auf DZPage.
 *
 * Der Schluessel steht in der Panel-Konfiguration (0600), nicht in der
 * Datenbank: Ein gestohlenes Datenbank-Backup allein soll nichts hergeben.
 */

const IV_LENGTH = 12;
const PREFIX = "v1";

function keyFrom(secret) {
  const key = Buffer.from(secret ?? "", "base64");
  if (key.length !== 32) {
    throw new Error("Verschluesselungsschluessel fehlt oder ist nicht 32 Byte lang.");
  }
  return key;
}

export function encryptSecret(plaintext, secret) {
  if (typeof plaintext !== "string") throw new Error("Nur Text kann verschluesselt werden.");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

/** Gibt null zurueck, wenn der Text nicht zu diesem Schluessel gehoert. */
export function decryptSecret(payload, secret) {
  if (typeof payload !== "string") return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    if (iv.length !== IV_LENGTH || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
