import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { prepareEnv } from "../test-support/helper.js";

const env = prepareEnv("units");
process.on("exit", () => env.cleanup());

const { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } = await import("../src/auth/password.js");
const { encryptSecret, decryptSecret } = await import("../src/crypto/secretbox.js");
const { loadConfig, saveConfig } = await import("../src/config.js");
const { MESSAGES, LOCALES, translate, pickLocale } = await import("../src/i18n/index.js");
const { createThrottle } = await import("../src/auth/throttle.js");
const { escapeHtml, html, raw } = await import("../src/http/html.js");
const { quoteArgument, buildCommandLine } = await import("../src/steam/pty.js");
const { openDatabase } = await import("../src/db/index.js");
const { setSetting, getSetting, KEYS } = await import("../src/store/settings.js");
const { createUser, findUserByUsername, countUsers, checkUsername } = await import("../src/store/users.js");
const { createSession, getSession, deleteSession } = await import("../src/store/sessions.js");
const { recordEvent, listEvents, trimEvents } = await import("../src/store/events.js");

test("scrypt: Passwort prüfen, falsches Passwort ablehnen", async () => {
  const hash = await hashPassword("ein-gutes-passwort");
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("ein-gutes-passwort", hash), true);
  assert.equal(await verifyPassword("ein-gutes-passwor", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("scrypt: kaputte Hashes ergeben false statt Ausnahme", async () => {
  for (const broken of ["", "scrypt$", "argon2$1$2$3$4$5", "scrypt$999999999$8$1$aaaa$bbbb"]) {
    assert.equal(await verifyPassword("x".repeat(12), broken), false);
  }
});

test("AES-256-GCM: hin und zurück, fremder Schlüssel scheitert", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const other = Buffer.alloc(32, 9).toString("base64");
  const box = encryptSecret("rcon-geheim", key);
  assert.notEqual(box, "rcon-geheim");
  assert.equal(decryptSecret(box, key), "rcon-geheim");
  assert.equal(decryptSecret(box, other), null);
  assert.equal(decryptSecret("kaputt", key), null);
});

test("Konfiguration: Geheimnisse werden erzeugt und die Datei bleibt 0600", () => {
  const config = loadConfig();
  assert.equal(Buffer.from(config.secrets.session, "base64").length, 32);
  assert.equal(Buffer.from(config.secrets.encryption, "base64").length, 32);
  assert.equal(statSync(env.configFile).mode & 0o777, 0o600);

  config.port = 9111;
  saveConfig(config);
  assert.equal(loadConfig().port, 9111);
  assert.equal(statSync(env.configFile).mode & 0o777, 0o600);
});

test("Sprachen: beide Tabellen haben dieselben Schlüssel", () => {
  const base = Object.keys(MESSAGES.en).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), base, `Sprache ${locale} weicht ab`);
  }
});

test("Sprachen: Auswahl und Platzhalter", () => {
  assert.equal(pickLocale({ query: "de" }), "de");
  assert.equal(pickLocale({ cookie: "de" }), "de");
  assert.equal(pickLocale({ acceptLanguage: "de-DE,de;q=0.9" }), "de");
  assert.equal(pickLocale({ acceptLanguage: "fr-FR" }), "en");
  assert.equal(translate("de", "setup.stepOf", { current: 2, total: 5 }), "Schritt 2 von 5");
  assert.equal(translate("de", "gibt.es.nicht"), "gibt.es.nicht");
});

test("HTML: maskiert alles Eingesetzte, raw() bleibt unangetastet", () => {
  assert.equal(escapeHtml('<script>"x"&\'y\''), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  assert.equal(html`<p>${"<b>"}</p>`, "<p>&lt;b&gt;</p>");
  assert.equal(html`<p>${raw("<b>")}</p>`, "<p><b></p>");
});

test("Drosselung: sperrt nach zu vielen Versuchen und gibt wieder frei", () => {
  const throttle = createThrottle({ max: 3, windowMs: 1000, lockMs: 1000 });
  assert.equal(throttle.check("a").locked, false);
  throttle.fail("a");
  throttle.fail("a");
  assert.equal(throttle.check("a").locked, false);
  assert.equal(throttle.fail("a").locked, true);
  assert.equal(throttle.check("a", Date.now() + 1500).locked, false);
  throttle.reset("a");
  assert.equal(throttle.size, 0);
});

test("Pseudo-Konsole: gefährliche Zeichen kommen nicht in die Kommandozeile", () => {
  assert.equal(buildCommandLine("/usr/games/steamcmd", ["+login", "konto"]), "'/usr/games/steamcmd' '+login' 'konto'");
  for (const bad of ["a b", "a;rm -rf /", "$(id)", "`id`", "a'b", "a\nb", "a&b", "a|b"]) {
    assert.throws(() => quoteArgument(bad), /unerlaubte Zeichen/, `sollte abgelehnt werden: ${bad}`);
  }
});

test("SQLite: Migrationen, Einstellungen, Benutzer, Sitzungen, Ereignisse", async () => {
  const db = await openDatabase({ kind: "sqlite", file: ":memory:" });

  await setSetting(db, KEYS.steamAccount, "konto");
  await setSetting(db, KEYS.steamAccount, "konto2");
  assert.equal(await getSetting(db, KEYS.steamAccount), "konto2");
  assert.equal(await getSetting(db, "gibt-es-nicht"), null);

  assert.equal(checkUsername("Ad Min").ok, false);
  assert.equal(checkUsername("AdMin").username, "admin");
  assert.equal(await countUsers(db), 0);
  const user = await createUser(db, { username: "AdMin", password: "x".repeat(MIN_PASSWORD_LENGTH) });
  assert.equal(await countUsers(db), 1);
  assert.equal((await findUserByUsername(db, "ADMIN")).id, user.id);

  const session = await createSession(db, { userId: user.id, ip: "127.0.0.1", userAgent: "test" });
  assert.equal((await getSession(db, session.id)).user_id, user.id);
  await deleteSession(db, session.id);
  assert.equal(await getSession(db, session.id), null);
  assert.equal(await getSession(db, "gibt-es-nicht"), null);

  for (let i = 0; i < 12; i += 1) await recordEvent(db, { kind: "test", message: `Ereignis ${i}` });
  assert.equal((await listEvents(db, 5)).length, 5);
  assert.equal((await listEvents(db, 5))[0].message, "Ereignis 11");
  await trimEvents(db, 4);
  assert.equal((await listEvents(db, 50)).length, 4);

  await db.close();
});

test("SQLite: abgelaufene Sitzungen gelten nicht mehr", async () => {
  const db = await openDatabase({ kind: "sqlite", file: ":memory:" });
  const user = await createUser(db, { username: "admin", password: "x".repeat(12) });
  const session = await createSession(db, { userId: user.id });
  await db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [Date.now() - 1000, session.id]);
  assert.equal(await getSession(db, session.id), null);
  await db.close();
});
