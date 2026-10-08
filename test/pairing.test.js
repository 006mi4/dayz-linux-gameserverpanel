import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepareEnv, startDzpageStub } from "../test-support/helper.js";

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

function runAdmin(args, { onOutput } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADMIN, ...args], {
      env: { ...process.env, DZPAGE_BASE_URL: stub.url },
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

test("Ein abgelaufener Kopplungscode wird verständlich abgelehnt", async () => {
  const result = await runAdmin(["link", "--token", "dzp_pair_abgelaufen_0123456789"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /abgelaufen oder schon benutzt/);
});

test("Kopplungscode aus dem Befehl: Schlüssel, Datenbank, Anmeldung bei DZPage", async () => {
  const result = await runAdmin(["link", "--token", "dzp_pair_gueltig_0123456789"]);
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
  const again = await runAdmin(["link", "--token", "dzp_pair_gueltig_0123456789"]);
  assert.equal(again.code, 3);
  assert.match(again.output, /schon mit DZPage verbunden \(Konto TestKonto\)/);
  assert.equal(stub.calls.register.length, 1);
});

test("Link und Bestätigung im Browser, wie bei einem Fernseher-Login", async () => {
  const before = stub.calls.register.length;
  let decided = false;
  const result = await runAdmin(["link", "--force"], {
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
  const result = await runAdmin(["link", "--force"], {
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
