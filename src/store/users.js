import { randomBytes } from "node:crypto";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../auth/password.js";

/**
 * Benutzer des Panels. Fuer P2 gibt es genau einen: den Administrator aus dem
 * Assistenten. Die Tabelle kann mehrere halten, damit spaeter kein Umbau
 * noetig ist, aber es gibt bewusst noch keine Benutzerverwaltung.
 *
 * Benutzernamen werden klein geschrieben abgelegt. SQLite vergleicht Text
 * unterscheidend, MySQL standardmaessig nicht — ohne Normalisierung haette
 * dieselbe Anmeldung je Datenbank ein anderes Ergebnis.
 */

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export function normaliseUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function checkUsername(value) {
  const username = normaliseUsername(value);
  if (!USERNAME_PATTERN.test(username)) return { ok: false, code: "username_invalid" };
  return { ok: true, username };
}

export function checkPassword(value, repeat) {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: "password_short" };
  }
  if (value.length > MAX_PASSWORD_LENGTH) return { ok: false, code: "password_long" };
  if (repeat !== undefined && value !== repeat) return { ok: false, code: "password_mismatch" };
  return { ok: true };
}

export async function countUsers(db) {
  const row = await db.get("SELECT COUNT(*) AS count FROM users", []);
  return Number(row?.count ?? 0);
}

export async function createUser(db, { username, password }) {
  const id = randomBytes(12).toString("hex");
  await db.run(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
    [id, normaliseUsername(username), await hashPassword(password), Date.now()],
  );
  return { id, username: normaliseUsername(username) };
}

export async function findUserByUsername(db, username) {
  return db.get("SELECT * FROM users WHERE username = ?", [normaliseUsername(username)]);
}

export async function findUserById(db, id) {
  return db.get("SELECT * FROM users WHERE id = ?", [id]);
}

export async function markLogin(db, id) {
  await db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [Date.now(), id]);
}
