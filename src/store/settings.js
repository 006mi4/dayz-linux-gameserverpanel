/**
 * Zustand des Panels als Schluessel-Wert-Paare. Hier liegt alles, was sich im
 * Betrieb aendert und kein Geheimnis ist: Fortschritt des Assistenten,
 * Panel-ID von DZPage, Name des Steam-Kontos.
 *
 * Geheimnisse gehoeren NICHT hierher, sondern in die Konfigurationsdatei.
 */

export const KEYS = {
  setupCompletedAt: "setup_completed_at",
  steamAccount: "steam_account",
  steamLoggedInAt: "steam_logged_in_at",
  steamSkipped: "steam_skipped",
  dzpagePanelId: "dzpage_panel_id",
  dzpageAccount: "dzpage_account",
  dzpageHeartbeatSeconds: "dzpage_heartbeat_seconds",
  dzpageLastSeenAt: "dzpage_last_seen_at",
  runtime: "runtime",
};

export async function getSetting(db, name) {
  const row = await db.get("SELECT value FROM settings WHERE name = ?", [name]);
  return row ? row.value : null;
}

export async function getSettings(db, names) {
  const out = {};
  for (const name of names) out[name] = await getSetting(db, name);
  return out;
}

export async function setSetting(db, name, value) {
  const text = value === null || value === undefined ? null : String(value);
  // Der Aufsetz-Ausdruck ist der einzige Unterschied zwischen den beiden
  // Datenbanken, den der Speicherteil kennen muss.
  const sql =
    db.kind === "mysql"
      ? "INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)"
      : "INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value";
  await db.run(sql, [name, text]);
}

export async function deleteSetting(db, name) {
  await db.run("DELETE FROM settings WHERE name = ?", [name]);
}

export async function getNumber(db, name) {
  const value = await getSetting(db, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function isSetupComplete(db) {
  return (await getSetting(db, KEYS.setupCompletedAt)) !== null;
}
