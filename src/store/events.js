/**
 * Ereignisprotokoll des Panels. Jede benannte Aktion landet hier — auch die,
 * die spaeter von DZPage kommen: "Auftraege werden geprueft, nicht blind
 * ausgefuehrt, und jeder Auftrag wird im Panel protokolliert."
 *
 * Bewusst kurz gehalten: Nachrichten sind ganze Saetze in der Oberflaeche,
 * keine Datenhalde, und werden nach Zahl begrenzt aufbewahrt.
 */

const MAX_MESSAGE = 500;
const KEEP_ROWS = 500;

export async function recordEvent(db, { kind, source = "panel", message }) {
  await db.run("INSERT INTO events (at, kind, source, message) VALUES (?, ?, ?, ?)", [
    Date.now(),
    String(kind).slice(0, 40),
    String(source).slice(0, 20),
    String(message ?? "").slice(0, MAX_MESSAGE),
  ]);
}

export async function listEvents(db, limit = 20) {
  const rows = await db.all(
    `SELECT id, at, kind, source, message FROM events ORDER BY id DESC LIMIT ${Number(limit) || 20}`,
    [],
  );
  return rows;
}

/**
 * Aelteste Eintraege wegwerfen. Ein Panel laeuft jahrelang; ohne das waechst
 * die Tabelle ewig. Die Unterabfrage bleibt bei beiden Datenbanken gleich,
 * wenn der Grenzwert erst ermittelt und dann verglichen wird — MySQL erlaubt
 * "LIMIT" in einer Unterabfrage mit IN nicht.
 */
export async function trimEvents(db, keep = KEEP_ROWS) {
  const row = await db.get(
    `SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ${Number(keep) || KEEP_ROWS}`,
    [],
  );
  if (!row) return 0;
  const result = await db.run("DELETE FROM events WHERE id <= ?", [row.id]);
  return result.changes;
}
