import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepareEnv, startDzpageStub } from "../test-support/helper.js";
import { TERMINAL_LOCALES, terminalTranslator } from "../src/i18n/terminal.js";

/**
 * Kopplung mit dem DZPage-Konto ueber die Kommandozeile, so wie install.sh sie
 * am Ende aufruft: mit dem Einmal-Code aus dem Befehl von dzpage.com, oder mit
 * Link und Bestaetigung im Browser. Gegen den Standhalter der Panel-API, mit
 * dem echten Verwaltungsprogramm als eigenem Prozess.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = join(ROOT, "bin", "dzpage-panel-admin.js");

const env = prepareEnv("pairing");
process.on("exit", () => env.cleanup());
const stub = await startDzpageStub();

test.after(async () => {
  await stub.stop();
});

/** Ausgaben auf Deutsch, wie die Erwartungen unten; `env` ueberschreibt das. */
function runAdmin(args, { onOutput, env: extra = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADMIN, ...args], {
      env: { ...process.env, DZPAGE_BASE_URL: stub.url, DZPAGE_PANEL_LANG: "de", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const take = (chunk) => {
      output += chunk;
      onOutput?.(output);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => resolve({ code, output }));
  });
}

function config() {
  return JSON.parse(readFileSync(env.configFile, "utf8"));
}

test("Ein falsch geformter Kopplungscode verlässt die Maschine gar nicht", async () => {
  const result = await runAdmin(["link", "--token", "dzp_panel_irgendwas"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /ungültig/);
  assert.equal(stub.calls.pair.length, 0);
});

test("Ohne Sprachangabe und mit LANG=C.UTF-8 antwortet das Terminal auf Englisch", async () => {
  const result = await runAdmin(["link", "--token", "dzp_panel_irgendwas"], {
    env: { DZPAGE_PANEL_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "C.UTF-8" },
  });
  assert.equal(result.code, 1);
  assert.equal(result.output, "This pairing code is invalid. Get a new command on dzpage.com.\n");
});

test("Jede der zehn Sprachen kommt im Terminal an, ohne Rückfall auf Englisch", async () => {
  const english = terminalTranslator("en")("admin.pair.invalid_token");
  for (const locale of TERMINAL_LOCALES) {
    const expected = terminalTranslator(locale)("admin.pair.invalid_token");
    const result = await runAdmin(["link", "--token", "dzp_panel_irgendwas"], { env: { DZPAGE_PANEL_LANG: locale } });
    assert.equal(result.output, `${expected}\n`, locale);
    if (locale !== "en") assert.notEqual(expected, english, locale);
  }
});

test("Ein abgelaufener Kopplungscode wird verständlich abgelehnt", async () => {
  const result = await runAdmin(["link", "--token", "dzp_pair_abgelaufen_0123456789"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /abgelaufen oder schon benutzt/);
});

test("Kopplungscode aus dem Befehl: Schlüssel, Datenbank, Anmeldung bei DZPage", async () => {
  const result = await runAdmin(["link", "--yes", "--token", "dzp_pair_gueltig_0123456789"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);

  // Die Einloesung geht ohne Schluessel hinaus und nennt die Maschine.
  const redeem = stub.calls.pair.findLast((call) => call.path === "/api/panel/v1/pair/redeem");
  assert.equal(redeem.authorization, null);
  assert.equal(redeem.payload.token, "dzp_pair_gueltig_0123456789");
  assert.match(redeem.payload.platform, /\(/);

  // Danach ist das Panel ein ganz normales Panel: Schluessel in der
  // Konfiguration, SQLite als Datenbank, angemeldet bei DZPage.
  const saved = config();
  assert.equal(saved.dzpage.key, stub.key);
  assert.equal(saved.database.kind, "sqlite");
  assert.equal(stub.calls.register.length, 1);

  // Der Code gilt genau einmal.
  assert.equal(stub.pairing.tokens.size, 0);
});

test("Schon gekoppelt: nichts überschreiben, ausser ausdrücklich gewollt", async () => {
  const again = await runAdmin(["link", "--yes", "--token", "dzp_pair_gueltig_0123456789"]);
  assert.equal(again.code, 3);
  assert.match(again.output, /schon mit DZPage verbunden \(Konto TestKonto\)/);
  assert.equal(stub.calls.register.length, 1);
});

test("Link und Bestätigung im Browser, wie bei einem Fernseher-Login", async () => {
  const before = stub.calls.register.length;
  let decided = false;
  const result = await runAdmin(["link", "--yes", "--force"], {
    onOutput(output) {
      // Sobald der Link im Terminal steht, bestaetigt der Mensch auf dzpage.com.
      if (!decided && output.includes("Warte auf Bestätigung")) {
        decided = true;
        setTimeout(() => stub.decideDevice("approved"), 300);
      }
    },
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /https:\/\/dzpage\.example\/link\?code=K7QF-M2X1/);
  assert.match(result.output, /K7QF-M2X1/);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  assert.equal(stub.calls.register.length, before + 1);

  // Der lange Geraetecode bleibt auf der Maschine; im Terminal steht nur der kurze.
  const start = stub.calls.pair.find((call) => call.path === "/api/panel/v1/pair/start");
  assert.equal(start.authorization, null);
  assert.doesNotMatch(result.output, /geraet-1-/);
});

test("Abgelehnte Bestätigung koppelt nicht", async () => {
  let decided = false;
  const result = await runAdmin(["link", "--yes", "--force"], {
    onOutput(output) {
      if (!decided && output.includes("Warte auf Bestätigung")) {
        decided = true;
        setTimeout(() => stub.decideDevice("denied"), 300);
      }
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /abgelehnt/);
});

/**
 * Prueferbefund: DZPage gibt den Schluessel genau einmal heraus. Scheiterte
 * danach nur die Anmeldung, war er bisher verloren und die Kopplung auch.
 */
test("Scheitert nur die Anmeldung, bleibt der Schlüssel und der nächste Aufruf holt sie nach", async () => {
  stub.pairing.tokens.add("dzp_pair_zweiter_0123456789");
  stub.state.failRegister = 1;
  const before = stub.calls.register.length;
  const first = await runAdmin(["link", "--yes", "--force", "--token", "dzp_pair_zweiter_0123456789"]);
  assert.equal(first.code, 1);
  assert.match(first.output, /Schlüssel erhalten, aber die Anmeldung bei DZPage schlug fehl/);
  assert.equal(config().dzpage.key, stub.key, "der Schluessel ist gespeichert");

  // Die Panel-ID der vorigen Tests loeschen, damit der Zustand dem echten
  // Abbruch entspricht: Schluessel da, Anmeldung fehlt.
  const { openDatabase } = await import("../src/db/index.js");
  const db = await openDatabase(config().database);
  await db.run("DELETE FROM settings WHERE name = 'dzpage_panel_id'", []);
  await db.close();

  const second = await runAdmin(["link"]);
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /Hole sie nach/);
  assert.match(second.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  assert.equal(stub.calls.register.length, before + 1);
});

test("Eine Antwort, die nicht wie ein Schlüssel aussieht, wird nicht gespeichert", async () => {
  const { isPanelKey } = await import("../src/dzpage/pairing.js");
  assert.equal(isPanelKey("dzp_panel_0123456789abcdef0123"), true);
  assert.equal(isPanelKey("dzp_panel_kurz"), false);
  assert.equal(isPanelKey("dzp_panel_0123456789abcdef\r\nX-Evil: 1"), false);
  assert.equal(isPanelKey("irgendwas"), false);
});

test("--token ohne Wert fällt nicht still auf den Link zurück", async () => {
  const result = await runAdmin(["link", "--yes", "--force", "--token"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /fehlt der Kopplungscode/);
});
