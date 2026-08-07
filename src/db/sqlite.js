import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite ueber node:sqlite — in Node 24 stabil, in 22/23 nur mit
 * --experimental-sqlite. Damit bleibt der Standardweg des Panels ohne jede
 * Abhaengigkeit und ohne eigenen Datenbank-Serverprozess.
 *
 * Die Schnittstelle ist absichtlich asynchron, obwohl node:sqlite synchron
 * arbeitet: MySQL ist es nicht, und aufrufender Code soll beide gleich
 * behandeln.
 */

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (err) {
    throw new Error(
      "node:sqlite ist in dieser Node-Version nicht verfuegbar. Node 24 oder neuer " +
        "verwenden, oder das Panel mit --experimental-sqlite starten. " +
        `(${err.message})`,
    );
  }
}

/**
 * node:sqlite nimmt nur null, Zahlen, BigInt, Text und Buffer. Booleans und
 * Date-Objekte wuerden mit "Invalid data type" auffliegen — hier einmal
 * zentral umsetzen, statt an jeder Abfrage daran zu denken.
 */
function normalise(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

/**
 * Die Datenbank ist nichts fuer andere Benutzer der Maschine.
 *
 * node:sqlite legt ihre Dateien mit der umask des Prozesses an, und das ergibt
 * ueblicherweise 0644. Das Datenverzeichnis muss aber durchlaessig sein (0751),
 * damit jeder Spielserver unter seinem eigenen Benutzer in sein Verzeichnis
 * kommt — womit die Datenbank fuer jeden lesbar waere, der ihren Pfad kennt.
 * Darin stehen Passwort-Hashes und die verschluesselten RCon-Passwoerter.
 */
function restrictFiles(file) {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, 0o640);
    } catch {
      // Die Begleitdateien gibt es erst nach dem ersten Schreiben.
    }
  }
}

export async function openSqlite(dbConfig) {
  const { DatabaseSync } = await loadSqlite();
  const file = dbConfig.file;
  if (!file) throw new Error("Fuer SQLite fehlt der Dateipfad.");
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
    // Vor dem Oeffnen: SQLite gibt den Begleitdateien (-wal, -shm) die Rechte
    // der Hauptdatei. Danach waere es zu spaet, sie entstehen mit dem WAL-Pragma.
    closeSync(openSync(file, "a", 0o640));
    restrictFiles(file);
  }

  const db = new DatabaseSync(file);
  // WAL haelt Lesen und Schreiben auseinander; busy_timeout verhindert, dass
  // ein gleichzeitiger Zugriff sofort mit SQLITE_BUSY abbricht.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  if (file !== ":memory:") restrictFiles(file);

  return {
    kind: "sqlite",
    async all(sql, params = []) {
      return db.prepare(sql).all(...normalise(params));
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...normalise(params)) ?? null;
    },
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...normalise(params));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
      };
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}
