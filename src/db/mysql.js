/**
 * MySQL/MariaDB — gedacht fuer Leute, die ohnehin eine Instanz betreiben. Die
 * Abhaengigkeit mysql2 kommt nur dann dazu, wenn diese Art auch gewaehlt wird;
 * fehlt sie, sagt das Panel im Klartext, welcher Befehl fehlt.
 */

export const MYSQL_INSTALL_HINT = "npm install --omit=dev mysql2";

async function loadMysql() {
  try {
    return await import("mysql2/promise");
  } catch {
    throw new Error(
      `Fuer MySQL fehlt das Paket mysql2. Im Panel-Verzeichnis nachinstallieren: ${MYSQL_INSTALL_HINT}`,
    );
  }
}

function poolOptions(dbConfig) {
  if (!dbConfig.host || !dbConfig.database || !dbConfig.user) {
    throw new Error("Fuer MySQL fehlen Host, Benutzer oder Datenbankname.");
  }
  return {
    host: dbConfig.host,
    port: Number(dbConfig.port) || 3306,
    user: dbConfig.user,
    password: dbConfig.password ?? "",
    database: dbConfig.database,
    charset: "utf8mb4",
    connectionLimit: 5,
    waitForConnections: true,
    // Ein Panel hat kein Interesse an Mehrfach-Anweisungen; ausgeschaltet ist
    // es eine Angriffsflaeche weniger.
    multipleStatements: false,
    dateStrings: true,
  };
}

function normalise(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

export async function openMysql(dbConfig) {
  const mysql = await loadMysql();
  const pool = mysql.createPool(poolOptions(dbConfig));
  // Sofort einmal verbinden, damit ein falsches Passwort beim Start auffliegt
  // und nicht erst beim ersten Klick in der Oberflaeche.
  const probe = await pool.getConnection();
  probe.release();

  return {
    kind: "mysql",
    async all(sql, params = []) {
      const [rows] = await pool.execute(sql, normalise(params));
      return rows;
    },
    async get(sql, params = []) {
      const [rows] = await pool.execute(sql, normalise(params));
      return rows[0] ?? null;
    },
    async run(sql, params = []) {
      const [result] = await pool.execute(sql, normalise(params));
      return {
        changes: result.affectedRows ?? 0,
        lastInsertRowid: result.insertId ? Number(result.insertId) : null,
      };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Verbindungstest fuer den Assistenten. Gibt die Klartextursache zurueck,
 * damit im Formular nicht nur "Fehler" steht.
 */
export async function testMysql(dbConfig) {
  let driver;
  try {
    driver = await openMysql(dbConfig);
    const row = await driver.get("SELECT VERSION() AS version", []);
    return { ok: true, version: row?.version ?? "unbekannt" };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await driver?.close().catch(() => undefined);
  }
}
