import { openSqlite } from "./sqlite.js";
import { openMysql, testMysql } from "./mysql.js";
import { migrate } from "./migrations.js";

/** Datenbank oeffnen und auf den aktuellen Stand bringen. */
export async function openDatabase(dbConfig) {
  if (!dbConfig) throw new Error("Es ist noch keine Datenbank eingerichtet.");
  const driver = dbConfig.kind === "mysql" ? await openMysql(dbConfig) : await openSqlite(dbConfig);
  try {
    await migrate(driver);
  } catch (err) {
    await driver.close().catch(() => undefined);
    throw err;
  }
  return driver;
}

/** Verbindungstest fuer den Assistenten, ohne etwas anzulegen. */
export async function testDatabase(dbConfig) {
  if (dbConfig.kind === "mysql") return testMysql(dbConfig);
  let driver;
  try {
    driver = await openSqlite(dbConfig);
    await driver.get("SELECT 1 AS ok", []);
    return { ok: true, version: "SQLite" };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    await driver?.close().catch(() => undefined);
  }
}

export { migrate };
