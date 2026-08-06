import test from "node:test";
import assert from "node:assert/strict";
import { Client, launchPanel, prepareEnv, startDzpageStub } from "../test-support/helper.js";

/**
 * Der MySQL-Weg gegen eine echte Datenbank. Laeuft nur, wenn eine angegeben
 * ist — sonst wird uebersprungen, damit die Suite ohne Datenbankserver
 * durchlaeuft:
 *
 *   DZPANEL_MYSQL_HOST=127.0.0.1 DZPANEL_MYSQL_USER=dzpanel \
 *   DZPANEL_MYSQL_PASSWORD=... DZPANEL_MYSQL_DATABASE=dzpanel_test node --test
 */

const HOST = process.env.DZPANEL_MYSQL_HOST;
const dbConfig = {
  kind: "mysql",
  host: HOST,
  port: Number(process.env.DZPANEL_MYSQL_PORT || 3306),
  user: process.env.DZPANEL_MYSQL_USER,
  password: process.env.DZPANEL_MYSQL_PASSWORD ?? "",
  database: process.env.DZPANEL_MYSQL_DATABASE,
};
const skip = HOST ? false : "Keine MySQL-Verbindung angegeben (DZPANEL_MYSQL_HOST).";

const env = prepareEnv("mysql");
process.on("exit", () => env.cleanup());

test("MySQL: Migrationen und Speicherteile", { skip }, async () => {
  const { openDatabase, testDatabase } = await import("../src/db/index.js");
  const { setSetting, getSetting, KEYS } = await import("../src/store/settings.js");
  const { createUser, findUserByUsername, countUsers } = await import("../src/store/users.js");
  const { createSession, getSession, deleteSession } = await import("../src/store/sessions.js");
  const { recordEvent, listEvents, trimEvents } = await import("../src/store/events.js");

  const probe = await testDatabase(dbConfig);
  assert.equal(probe.ok, true, probe.message);

  const db = await openDatabase(dbConfig);
  // Mehrfach oeffnen muss harmlos sein — die Migrationen laufen bei jedem Start.
  await (await openDatabase(dbConfig)).close();

  await setSetting(db, KEYS.steamAccount, "konto");
  await setSetting(db, KEYS.steamAccount, "konto2");
  assert.equal(await getSetting(db, KEYS.steamAccount), "konto2");

  const before = await countUsers(db);
  const user = await createUser(db, { username: `pruefer${Date.now() % 100000}`, password: "x".repeat(12) });
  assert.equal(await countUsers(db), before + 1);
  assert.equal((await findUserByUsername(db, user.username)).id, user.id);

  const session = await createSession(db, { userId: user.id, ip: "127.0.0.1", userAgent: "test" });
  assert.equal((await getSession(db, session.id)).user_id, user.id);
  await deleteSession(db, session.id);
  assert.equal(await getSession(db, session.id), null);

  await recordEvent(db, { kind: "test", message: "MySQL-Prüfung" });
  assert.equal((await listEvents(db, 1))[0].message, "MySQL-Prüfung");
  await trimEvents(db, 0);

  // Benutzer wieder wegräumen, damit ein zweiter Lauf dieselbe Datenbank nutzen kann.
  await db.run("DELETE FROM users WHERE id = ?", [user.id]);
  await db.close();
});

test("MySQL: Assistent läuft mit MySQL durch", { skip }, async () => {
  const stub = await startDzpageStub();
  process.env.DZPAGE_BASE_URL = stub.url;
  const panel = await launchPanel();
  const client = new Client(panel.url);

  await client.get("/setup/database");
  await client.submit("/setup/database", {
    kind: "mysql",
    action: "test",
    host: dbConfig.host,
    port: String(dbConfig.port),
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });
  assert.match(client.lastBody, /Connection works/);

  await client.submit("/setup/database", {
    kind: "mysql",
    action: "save",
    host: dbConfig.host,
    port: String(dbConfig.port),
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });
  assert.equal(client.lastLocation, "/setup/admin");

  await client.get("/setup/admin");
  await client.submit("/setup/admin", {
    username: "mysqladmin",
    password: "panel-passwort-1",
    password2: "panel-passwort-1",
  });
  assert.equal(client.lastLocation, "/steam");

  await client.get("/steam");
  await client.submit("/steam", { action: "skip" });
  await client.get("/dzpage");
  await client.submit("/dzpage", { key: stub.key, name: "MySQL-Panel" });
  assert.equal(client.lastLocation, "/setup/done");

  await client.get("/setup/done");
  await client.submit("/setup/done", {});
  await client.get("/");
  assert.match(client.lastBody, /MySQL/);

  // Tabellen wieder leeren, damit der nächste Lauf frisch beginnt.
  await panel.app.db.run("DELETE FROM sessions", []);
  await panel.app.db.run("DELETE FROM users", []);
  await panel.app.db.run("DELETE FROM settings", []);
  await panel.app.db.run("DELETE FROM events", []);

  await panel.stop();
  await stub.stop();
});
