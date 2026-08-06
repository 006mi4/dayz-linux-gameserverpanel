import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Passwort-Hashing mit scrypt aus node:crypto. Argon2id waere der
 * Lehrbuchfavorit, kostet aber eine native Abhaengigkeit — und ein Panel, das
 * beim Installieren einen C-Compiler braucht, scheitert bei genau der
 * Zielgruppe, fuer die es gedacht ist. scrypt ist ebenfalls speicherhart und
 * steckt in Node drin.
 *
 * Parameter N=2^15, r=8, p=1, 32 Byte Salt, 64 Byte Schluessel. Der
 * Speicherbedarf ist 128 * N * r = 32 MiB und liegt damit ueber Nodes
 * Standardgrenze — maxmem muss deshalb mitgegeben werden, sonst schlaegt
 * scrypt mit "Invalid scrypt params" fehl.
 */

export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;
const MAXMEM = 96 * 1024 * 1024;

/** Obergrenze, damit ein absurd langes Passwort nicht zur Rechenbremse wird. */
export const MAX_PASSWORD_LENGTH = 200;
export const MIN_PASSWORD_LENGTH = 10;

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password) {
  if (typeof password !== "string" || !password) throw new Error("Passwort fehlt.");
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error("Passwort ist zu lang.");
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Passwort pruefen. Gibt bei jedem Fehler false zurueck statt zu werfen — ein
 * kaputter Hash in der Datenbank darf die Anmeldung nicht in einen Serverfehler
 * verwandeln, der mehr verraet als ein simples "falsch".
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Fremde Parameter koennten uns zu absurdem Speicherbedarf zwingen.
  if (N > 2 ** 17 || r > 16 || p > 4) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  let key;
  try {
    key = await derive(password, salt, { N, r, p });
  } catch {
    return false;
  }
  return timingSafeEqual(key, expected);
}
