import { log } from "../log.js";

/**
 * Wanderungen der Datenbank. Ein Eintrag je Schritt, getrennt fuer SQLite und
 * MySQL — die Typnamen unterscheiden sich, die Logik nicht.
 *
 * Zwei Festlegungen, die alles andere einfach halten:
 * - Zeitpunkte sind Millisekunden seit 1970 als ganze Zahl. Damit gibt es
 *   keine Zeitzonen- und keine Formatunterschiede zwischen den beiden
 *   Datenbanken.
 * - Wahrheitswerte sind 0 und 1.
 */

export const MIGRATIONS = [
  {
    id: 1,
    name: "grundtabellen",
    sqlite: [
      // Die Spalte heisst "name" und nicht "key": KEY ist in MySQL ein
      // reserviertes Wort und muesste dort anders zitiert werden als in
      // SQLite — so bleibt jede Abfrage fuer beide Datenbanken dieselbe.
      `CREATE TABLE settings (
         name TEXT PRIMARY KEY,
         value TEXT
       )`,
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         username TEXT NOT NULL UNIQUE,
         password_hash TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         last_login_at INTEGER
       )`,
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         csrf TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         ip TEXT,
         user_agent TEXT
       )`,
      `CREATE INDEX sessions_expires_at ON sessions(expires_at)`,
      `CREATE TABLE events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at INTEGER NOT NULL,
         kind TEXT NOT NULL,
         source TEXT NOT NULL,
         message TEXT NOT NULL
       )`,
      `CREATE INDEX events_at ON events(at)`,
    ],
    mysql: [
      `CREATE TABLE settings (
         name VARCHAR(64) NOT NULL PRIMARY KEY,
         value TEXT
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE users (
         id VARCHAR(32) NOT NULL PRIMARY KEY,
         username VARCHAR(64) NOT NULL UNIQUE,
         password_hash VARCHAR(255) NOT NULL,
         created_at BIGINT NOT NULL,
         last_login_at BIGINT
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE sessions (
         id VARCHAR(64) NOT NULL PRIMARY KEY,
         user_id VARCHAR(32) NOT NULL,
         csrf VARCHAR(64) NOT NULL,
         created_at BIGINT NOT NULL,
         expires_at BIGINT NOT NULL,
         ip VARCHAR(64),
         user_agent VARCHAR(200),
         CONSTRAINT sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX sessions_expires_at ON sessions(expires_at)`,
      `CREATE TABLE events (
         id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
         at BIGINT NOT NULL,
         kind VARCHAR(40) NOT NULL,
         source VARCHAR(20) NOT NULL,
         message TEXT NOT NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX events_at ON events(at)`,
    ],
  },
  {
    id: 2,
    name: "server",
    sqlite: [
      `CREATE TABLE servers (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         game_port INTEGER NOT NULL,
         query_port INTEGER NOT NULL,
         rcon_port INTEGER NOT NULL,
         rcon_password_enc TEXT NOT NULL,
         max_players INTEGER NOT NULL DEFAULT 60,
         mission TEXT NOT NULL DEFAULT 'dayzOffline.chernarusplus',
         runtime TEXT NOT NULL DEFAULT 'systemd',
         memory_max_mb INTEGER NOT NULL DEFAULT 6144,
         cpu_quota INTEGER NOT NULL DEFAULT 400,
         install_state TEXT NOT NULL DEFAULT 'new',
         installed_at INTEGER,
         autostart INTEGER NOT NULL DEFAULT 1,
         dzpage_server_id TEXT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE UNIQUE INDEX servers_game_port ON servers(game_port)`,
    ],
    mysql: [
      `CREATE TABLE servers (
         id VARCHAR(32) NOT NULL PRIMARY KEY,
         name VARCHAR(80) NOT NULL,
         game_port INT NOT NULL,
         query_port INT NOT NULL,
         rcon_port INT NOT NULL,
         rcon_password_enc VARCHAR(255) NOT NULL,
         max_players INT NOT NULL DEFAULT 60,
         mission VARCHAR(80) NOT NULL DEFAULT 'dayzOffline.chernarusplus',
         runtime VARCHAR(20) NOT NULL DEFAULT 'systemd',
         memory_max_mb INT NOT NULL DEFAULT 6144,
         cpu_quota INT NOT NULL DEFAULT 400,
         install_state VARCHAR(20) NOT NULL DEFAULT 'new',
         installed_at BIGINT,
         autostart TINYINT NOT NULL DEFAULT 1,
         dzpage_server_id VARCHAR(40),
         created_at BIGINT NOT NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE UNIQUE INDEX servers_game_port ON servers(game_port)`,
    ],
  },
  {
    id: 3,
    name: "update-pruefung",
    // update_mode: off | notify | auto. installed_build ist die Nummer aus
    // Steams appmanifest — sie steht in der Datenbank, damit die Uebersicht
    // nicht bei jedem Aufruf ueber die Spieldateien laufen muss.
    sqlite: [
      `ALTER TABLE servers ADD COLUMN update_mode TEXT NOT NULL DEFAULT 'off'`,
      `ALTER TABLE servers ADD COLUMN installed_build TEXT`,
    ],
    mysql: [
      `ALTER TABLE servers ADD COLUMN update_mode VARCHAR(10) NOT NULL DEFAULT 'off'`,
      `ALTER TABLE servers ADD COLUMN installed_build VARCHAR(20)`,
    ],
  },
  {
    id: 4,
    name: "server-konfiguration",
    // Die Eintraege der serverDZ.cfg, die der Kunde selbst bestimmt: als JSON
    // und als Liste von Paaren, damit die Reihenfolge erhalten bleibt und ein
    // neuer Schluessel keine Wanderung braucht.
    //
    // Sie stehen hier und nicht in der Datei, weil das Panel die Datei bei
    // jeder Installation neu schreibt — eine Aenderung von Hand waere beim
    // naechsten Update weg.
    sqlite: [`ALTER TABLE servers ADD COLUMN config_json TEXT`],
    mysql: [`ALTER TABLE servers ADD COLUMN config_json TEXT`],
  },
];

const VERSION_TABLE = {
  sqlite: `CREATE TABLE IF NOT EXISTS schema_migrations (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at INTEGER NOT NULL
           )`,
  mysql: `CREATE TABLE IF NOT EXISTS schema_migrations (
            id INT NOT NULL PRIMARY KEY,
            name VARCHAR(60) NOT NULL,
            applied_at BIGINT NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

/** Fehlende Schritte anwenden. Mehrfacher Aufruf ist harmlos. */
export async function migrate(driver) {
  await driver.exec(VERSION_TABLE[driver.kind]);
  const applied = new Set(
    (await driver.all("SELECT id FROM schema_migrations", [])).map((row) => Number(row.id)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const statements = migration[driver.kind];
    if (!statements) throw new Error(`Migration ${migration.id} kennt ${driver.kind} nicht.`);
    for (const sql of statements) await driver.exec(sql);
    await driver.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
      migration.id,
      migration.name,
      Date.now(),
    ]);
    log.info(`Datenbank auf Stand ${migration.id} gebracht (${migration.name}).`);
  }
}
