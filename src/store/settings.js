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
  /** DZPage hat den Schluessel abgelehnt: "revoked" oder "invalid_key", und seit wann. */
  dzpageKeyRejected: "dzpage_key_rejected",
  dzpageKeyRejectedAt: "dzpage_key_rejected_at",
  runtime: "runtime",

  /** Update-Pruefung: Zeitplan und letzter bekannter Stand bei Steam. */
  updateCheckEnabled: "update_check_enabled",
  updateCheckInterval: "update_check_interval_minutes",
  updateCheckedAt: "update_checked_at",
  updateAvailableBuild: "update_available_build",
  updatePublishedAt: "update_published_at",
  updateLastError: "update_last_error",

  /** Aktualisierung des Panels selbst (Git/GitHub, nicht Steam). */
  panelUpdateMode: "panel_update_mode",
  panelUpdateCheckedAt: "panel_update_checked_at",
  panelUpdateLatest: "panel_update_latest",
  panelUpdateError: "panel_update_error",
  /** Fassung, zu der schon ein Ereignis im Protokoll steht. */
  panelUpdateAnnounced: "panel_update_announced",
  /** Zeitstempel des Ergebnisses, das nach dem Neustart schon gemeldet wurde. */
  panelUpdateResultAt: "panel_update_result_at",
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
