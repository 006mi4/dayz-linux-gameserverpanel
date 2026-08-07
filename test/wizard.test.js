import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { Client, launchPanel, prepareEnv, startDzpageStub } from "../test-support/helper.js";

/**
 * Der Assistent von Anfang bis Ende, ueber HTTP wie im Browser: Datenbank,
 * Administrator, Steam (uebersprungen), DZPage-Schluessel, Abschluss. Danach
 * die Regeln, die nach dem Einrichten gelten muessen.
 */

const env = prepareEnv("wizard");
const stub = await startDzpageStub();
process.env.DZPAGE_BASE_URL = stub.url;

const panel = await launchPanel();
const client = new Client(panel.url);

test.after(async () => {
  await panel.stop();
  await stub.stop();
  env.cleanup();
});

test("Startseite führt in den Assistenten", async () => {
  await client.get("/");
  assert.equal(client.lastStatus, 303);
  assert.equal(client.lastLocation, "/setup");

  await client.get("/setup");
  assert.equal(client.lastLocation, "/setup/database");
});

test("Sicherheitskopfzeilen und keine Skripte", async () => {
  await client.get("/setup/database");
  const csp = client.lastResponse.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.equal(client.lastResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(client.lastResponse.headers.get("cache-control"), "no-store");
  assert.equal(/<script/i.test(client.lastBody), false);
});

test("Formular ohne CSRF-Wert wird abgewiesen", async () => {
  await client.post("/setup/database", { kind: "sqlite", action: "save" });
  assert.equal(client.lastStatus, 403);
});

test("Formular mit fremdem Origin wird abgewiesen", async () => {
  await client.get("/setup/database");
  await client.post(
    "/setup/database",
    { kind: "sqlite", action: "save", _csrf: client.csrf },
    { headers: { origin: "http://boese.example" } },
  );
  assert.equal(client.lastStatus, 403);
});

test("Formular von fremder Seite wird abgewiesen (Sec-Fetch-Site)", async () => {
  await client.get("/setup/database");
  await client.post(
    "/setup/database",
    { kind: "sqlite", action: "save", _csrf: client.csrf },
    { headers: { "sec-fetch-site": "cross-site" } },
  );
  assert.equal(client.lastStatus, 403);
});

/**
 * Der Fall, an dem der Assistent im echten Browser gescheitert ist: Chrome
 * schickt bei unterdrueckter Herkunft "Origin: null". Das ist kein fremder
 * Ursprung — und curl schickt gar keinen Origin, deshalb fiel es in den Tests
 * vorher nicht auf.
 */
test("Origin: null aus dem Browser wird angenommen", async () => {
  await client.get("/setup/database");
  await client.post(
    "/setup/database",
    { kind: "sqlite", action: "test", _csrf: client.csrf },
    { headers: { origin: "null", "sec-fetch-site": "same-origin" } },
  );
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /Connection works/);
});

test("Schritt 1: SQLite einrichten", async () => {
  await client.get("/setup/database");
  await client.submit("/setup/database", { kind: "sqlite", action: "save" });
  assert.equal(client.lastStatus, 303);
  assert.equal(client.lastLocation, "/setup/admin");

  const config = JSON.parse(readFileSync(env.configFile, "utf8"));
  assert.equal(config.database.kind, "sqlite");
  assert.equal(statSync(config.database.file).isFile(), true);
});

test("Schritt 1: MySQL ohne erreichbaren Server nennt den Grund", async () => {
  await client.get("/setup/database");
  await client.submit("/setup/database", {
    kind: "mysql",
    action: "test",
    host: "127.0.0.1",
    port: "1",
    user: "u",
    password: "p",
    database: "d",
  });
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /Connection failed|mysql2/);
});

test("Schritt 2: Administrator anlegen", async () => {
  await client.get("/setup/admin");
  await client.submit("/setup/admin", { username: "admin", password: "kurz", password2: "kurz" });
  assert.match(client.lastBody, /at least 10 characters/);

  await client.submit("/setup/admin", {
    username: "admin",
    password: "panel-passwort-1",
    password2: "panel-passwort-2",
  });
  assert.match(client.lastBody, /do not match/);

  await client.submit("/setup/admin", {
    username: "Admin",
    password: "panel-passwort-1",
    password2: "panel-passwort-1",
  });
  assert.equal(client.lastStatus, 303);
  assert.equal(client.lastLocation, "/steam");

  const cookie = client.lastResponse.headers.getSetCookie().find((c) => c.startsWith("dzp_panel_session="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

test("Schritt 3: Steam lässt sich überspringen", async () => {
  await client.get("/steam");
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /Steam account name/);

  await client.submit("/steam", { action: "skip" });
  assert.equal(client.lastStatus, 303);
  assert.equal(client.lastLocation, "/dzpage");
});

test("Schritt 4: falscher Schlüssel wird erklärt und nicht zurückgeschrieben", async () => {
  await client.get("/dzpage");
  assert.equal(client.lastStatus, 200);

  await client.submit("/dzpage", { key: "kein-schluessel", name: "Testpanel" });
  assert.match(client.lastBody, /starts with dzp_panel_/);

  await client.submit("/dzpage", { key: "dzp_panel_falsch", name: "Testpanel" });
  assert.match(client.lastBody, /does not know this key/);
  assert.equal(client.lastBody.includes("dzp_panel_falsch"), false);
});

test("Schritt 4: richtiger Schlüssel meldet das Panel an", async () => {
  await client.get("/dzpage");
  await client.submit("/dzpage", { key: stub.key, name: "Testpanel" });
  assert.equal(client.lastStatus, 303);
  assert.equal(client.lastLocation, "/setup/done");

  assert.equal(stub.calls.register.length, 1);
  assert.equal(stub.calls.register[0].name, "Testpanel");
  assert.match(stub.calls.register[0].platform, /Linux/);

  const config = JSON.parse(readFileSync(env.configFile, "utf8"));
  assert.equal(config.dzpage.key, stub.key);
  assert.equal(statSync(env.configFile).mode & 0o777, 0o600);
});

test("Schritt 5: Abschluss schließt den Assistenten", async () => {
  await client.get("/setup/done");
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /TestKonto/);

  await client.submit("/setup/done", {});
  assert.equal(client.lastLocation, "/");

  for (const path of ["/setup", "/setup/database", "/setup/admin", "/setup/done"]) {
    await client.get(path);
    assert.equal(client.lastStatus, 404, `${path} muss nach dem Einrichten 404 liefern`);
  }
});

test("Übersicht zeigt den Zustand", async () => {
  await client.get("/");
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /Dashboard/);
  assert.match(client.lastBody, /SQLite/);
  assert.match(client.lastBody, /TestKonto/);
  assert.match(client.lastBody, /not signed in/);
});

test("Herzschlag meldet sich bei DZPage", async () => {
  panel.app.heartbeat.restart({ immediate: true });
  for (let i = 0; i < 50 && stub.calls.heartbeat.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(stub.calls.heartbeat.length >= 1, true);
  assert.equal(stub.calls.heartbeat[0].panelId, "panel123456");
  assert.equal(stub.calls.heartbeat[0].serverCount, 0);
  panel.app.heartbeat.stop();
});

test("Abmelden, falsche Anmeldung, richtige Anmeldung", async () => {
  await client.get("/");
  await client.submit("/logout", {});
  assert.equal(client.lastLocation, "/login");

  await client.get("/");
  assert.equal(client.lastLocation, "/login");

  await client.get("/login");
  await client.submit("/login", { username: "admin", password: "falsch-falsch" });
  assert.equal(client.lastStatus, 401);
  assert.match(client.lastBody, /Wrong username or password/);

  await client.submit("/login", { username: "admin", password: "panel-passwort-1" });
  assert.equal(client.lastStatus, 303);
  assert.equal(client.lastLocation, "/");
});

test("Anmeldung wird gedrosselt", async () => {
  // Angemeldet leitet /login weiter — fuer diesen Test muss die Sitzung weg.
  await client.get("/");
  await client.submit("/logout", {});
  await client.get("/login?lang=de");
  let sawLock = false;
  for (let i = 0; i < 10; i += 1) {
    await client.submit("/login", { username: "admin", password: `falsch-${i}` });
    if (client.lastStatus === 429 || /Zu viele Versuche/.test(client.lastBody)) {
      sawLock = true;
      break;
    }
  }
  assert.equal(sawLock, true);
  panel.app.throttle.reset("127.0.0.1");
  panel.app.throttle.reset("::ffff:127.0.0.1");
});

test("Sprache lässt sich umschalten und bleibt", async () => {
  await client.get("/login?lang=de");
  assert.match(client.lastBody, /Am Panel anmelden/);
  await client.get("/login");
  assert.match(client.lastBody, /Am Panel anmelden/);
  await client.get("/login?lang=en");
  assert.match(client.lastBody, /Sign in to the panel/);
});
