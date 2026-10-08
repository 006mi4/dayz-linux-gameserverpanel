import { randomBytes } from "node:crypto";

/**
 * Sitzungen liegen in der Datenbank, damit ein Neustart des Dienstes niemanden
 * abmeldet. Die Kennung ist ein Zufallswert; das Sitzungscookie enthaelt
 * nichts weiter.
 *
 * Zu jeder Sitzung gehoert ein CSRF-Wert. Jedes Formular des Panels schickt
 * ihn mit — ohne das koennte eine fremde Webseite im Browser des Angemeldeten
 * Aktionen ausloesen, und das Panel startet Prozesse auf einer echten Maschine.
 */

export const SESSION_COOKIE = "dzp_panel_session";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Verlaengern hoechstens einmal pro Stunde — ein Panel soll im Leerlauf nichts schreiben. */
const RENEW_AFTER_MS = 60 * 60 * 1000;

export async function createSession(db, { userId, ip, userAgent }) {
  const id = randomBytes(32).toString("base64url");
  const csrf = randomBytes(18).toString("base64url");
  const now = Date.now();
  await db.run(
    "INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, userId, csrf, now, now + SESSION_TTL_MS, ip ?? null, (userAgent ?? "").slice(0, 200) || null],
  );
  return { id, csrf, expiresAt: now + SESSION_TTL_MS };
}

export async function getSession(db, id) {
  if (typeof id !== "string" || !id) return null;
  const row = await db.get("SELECT * FROM sessions WHERE id = ?", [id]);
  if (!row) return null;
  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    await deleteSession(db, id);
    return null;
  }
  if (Number(row.expires_at) - now < SESSION_TTL_MS - RENEW_AFTER_MS) {
    await db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [now + SESSION_TTL_MS, id]);
  }
  return row;
}

export async function deleteSession(db, id) {
  await db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** Nach einem Passwortwechsel: alle anderen Sitzungen dieses Benutzers beenden. */
export async function deleteOtherSessions(db, userId, keepId = null) {
  if (keepId) {
    await db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [userId, keepId]);
  } else {
    await db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }
}

export async function purgeExpiredSessions(db) {
  const result = await db.run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
  return result.changes;
}
