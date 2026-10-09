import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepareEnv, startDzpageStub } from "../test-support/helper.js";

/**
 * Was passiert, wenn DZPage einen Schluessel nicht (mehr) annimmt: die
 * verneinte Rueckfrage nach dem Konto, ein widerrufener Schluessel und die
 * Anzeige von "dzpage-panel status". Mit dem echten Verwaltungsprogramm als
 * eigenem Prozess; die Rueckfrage braucht ein echtes Terminal, das script(1)
 * stellt.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = join(ROOT, "bin", "dzpage-panel-admin.js");

const env = prepareEnv("keystate");
process.on("exit", () => env.cleanup());
const stub = await startDzpageStub();
stub.pairing.freshKeys = true;
process.env.DZPAGE_BASE_URL = stub.url;

const { loadConfig } = await import("../src/config.js");
const { openDatabase } = await import("../src/db/index.js");
const { getSetting, setSetting, KEYS } = await import("../src/store/settings.js");
const { createHeartbeat } = await import("../src/dzpage/heartbeat.js");
const { createPoller } = await import("../src/dzpage/poller.js");
const { checkServerInput, createServer } = await import("../src/store/servers.js");

const HAS_SCRIPT = spawnSync("script", ["--version"]).status === 0;
const noScript = HAS_SCRIPT ? false : "script(1) fehlt, ohne Terminal gibt es keine Rückfrage.";

test.after(async () => {
  await stub.stop();
});

function collect(child, { onOutput } = {}) {
  return new Promise((resolve) => {
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

/** Ohne Terminal: eigene Sitzung, damit auch ein Testlauf am Terminal keins vererbt. */
function runAdmin(args, { baseUrl = stub.url } = {}) {
  const child = spawn(process.execPath, [ADMIN, ...args], {
    env: { ...process.env, DZPAGE_BASE_URL: baseUrl },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return collect(child);
}

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * Wie am echten Terminal: Sobald die Frage dasteht, tippt der Mensch `keys`
 * (Text, oder Liste aus [Pause in ms, Text]). `early` tippt er schon vorher,
 * waehrend er noch auf die Bestaetigung wartet.
 */
function runAdminAtTerminal(args, keys, { early = null } = {}) {
  const command = [process.execPath, ADMIN, ...args].map(quote).join(" ");
  const child = spawn("script", ["-qec", command, "/dev/null"], {
    env: { ...process.env, DZPAGE_BASE_URL: stub.url },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (early) child.stdin.write(early);
  const steps = typeof keys === "string" ? [[150, keys]] : keys;
  let typed = false;
  const done = collect(child, {
    onOutput(output) {
      if (!typed && output.includes("[J/n]")) {
        typed = true;
        let delay = 0;
        for (const [pause, text] of steps) {
          delay += pause;
          setTimeout(() => child.stdin.write(text), delay);
        }
      }
    },
  });
  return done.finally(() => child.stdin.end());
}

function storedKey() {
  return JSON.parse(readFileSync(env.configFile, "utf8")).dzpage.key;
}

async function withDb(fn) {
  const db = await openDatabase(loadConfig({ file: env.configFile }).database);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

const rejection = () => withDb((db) => getSetting(db, KEYS.dzpageKeyRejected));

async function status() {
  const result = await runAdmin(["dzpage-status"]);
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}

function newToken(name) {
  const token = `dzp_pair_${name}_0123456789abcdef`;
  stub.pairing.tokens.add(token);
  return token;
}

async function waitFor(check, { timeoutMs = 15_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Bedingung wurde nicht erreicht.");
}

/* ------------------------------------------------- verneinte Rueckfrage */

test("Wer das Konto verneint, widerruft den neuen Schlüssel auf DZPage", { skip: noScript }, async () => {
  const result = await runAdminAtTerminal(["link", "--token", newToken("nein")], "n\n");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /»TestKonto«/);
  assert.match(result.output, /Nicht verbunden\. Der neue Schlüssel ist auf dzpage\.com widerrufen/);

  // Genau der eben ausgestellte Schluessel ist widerrufen, mit sich selbst.
  assert.equal(stub.calls.revoke.length, 1);
  const issued = stub.calls.revoke[0];
  assert.match(issued, /^dzp_panel_frisch/);
  assert.ok(stub.keys.revoked.has(issued));
  // Auf dieser Maschine aendert sich nichts.
  assert.equal(storedKey(), null);
  assert.equal(stub.calls.register.length, 0);
});

test("Strg+C an der Rückfrage gilt als Nein, auch dann ist der Schlüssel widerrufen", { skip: noScript }, async () => {
  const before = stub.calls.revoke.length;
  const result = await runAdminAtTerminal(["link", "--token", newToken("abbruch")], "\x03");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /widerrufen/);
  assert.equal(stub.calls.revoke.length, before + 1);
  assert.equal(storedKey(), null);
});

test("Kennt dzpage.com den Widerruf noch nicht, sagt das Terminal, was zu tun ist", { skip: noScript }, async () => {
  stub.state.noRevoke = true;
  try {
    const result = await runAdminAtTerminal(["link", "--token", newToken("altseite")], "nein\n");
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /konnte das Panel auf dzpage\.com nicht widerrufen \(not_found\)/);
    assert.match(result.output, /unter RCon bei den Panel-Schlüsseln/);
    // Nur der Anfang des Schluessels, nie der ganze.
    assert.doesNotMatch(result.output, /dzp_panel_frisch\d{4}0123456789abcdef/);
    assert.equal(storedKey(), null);
  } finally {
    stub.state.noRevoke = false;
  }
});

test("Ein zweites Strg+C während des Widerrufs bricht ihn nicht ab", { skip: noScript }, async () => {
  const before = stub.calls.revoke.length;
  stub.state.revokeDelayMs = 1500;
  try {
    const result = await runAdminAtTerminal(["link", "--token", newToken("zweimal")], [
      [150, "\x03"],
      [500, "\x03"],
    ]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Widerrufe den neuen Schlüssel/);
    assert.match(result.output, /Der neue Schlüssel ist auf dzpage\.com widerrufen/);
    assert.equal(stub.calls.revoke.length, before + 1);
  } finally {
    stub.state.revokeDelayMs = 0;
  }
});

test("Was vor der Frage getippt wurde, ist keine Antwort darauf", { skip: noScript }, async () => {
  // Enter waehrend des Wartens auf die Bestaetigung: Frueher galt das als Ja.
  const before = stub.calls.revoke.length;
  const result = await runAdminAtTerminal(["link", "--token", newToken("vorab")], "n\n", { early: "\n" });
  assert.equal(result.code, 1, result.output);
  assert.equal(stub.calls.revoke.length, before + 1);
  assert.equal(storedKey(), null);
});

test("Eine unklare Antwort verbindet nicht", { skip: noScript }, async () => {
  const before = stub.calls.revoke.length;
  const result = await runAdminAtTerminal(["link", "--token", newToken("unklar")], "vielleicht\n");
  assert.equal(result.code, 1, result.output);
  assert.equal(stub.calls.revoke.length, before + 1);
  assert.equal(storedKey(), null);
});

test("Enter an der Rückfrage verbindet", { skip: noScript }, async () => {
  const result = await runAdminAtTerminal(["link", "--token", newToken("ja")], "\n");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  assert.match(storedKey(), /^dzp_panel_frisch/);
});

/* ------------------------------------------------ Zustand und Ablehnung */

test("Ohne Terminal und ohne --yes gilt weiter die Voreinstellung", async () => {
  // Automatisierung ohne Terminal: keine Frage, keine Antwort, verbunden.
  const result = await runAdmin(["link", "--force", "--token", newToken("automat")]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
});

test("status zeigt den letzten Kontakt statt nur einen Schlüssel in panel.json", async () => {
  assert.match(await status(), /^verbunden \(Konto TestKonto\), letzter Kontakt \d\d\.\d\d\.\d{4} \d\d:\d\d \(vor weniger als einer Minute\)$/);

  await withDb((db) => setSetting(db, KEYS.dzpageLastSeenAt, Date.now() - 3 * 60 * 60 * 1000));
  assert.match(await status(), /^Schlüssel hinterlegt \(Konto TestKonto\), aber letzter Kontakt .* \(vor 3 Stunden\)\. Protokoll: sudo dzpage-panel logs$/);
  await withDb((db) => setSetting(db, KEYS.dzpageLastSeenAt, Date.now()));
});

test("Der Herzschlag vermerkt einen widerrufenen Schlüssel, status zeigt ihn", async () => {
  const key = storedKey();
  stub.keys.revoked.add(key);
  const config = loadConfig({ file: env.configFile });
  const db = await openDatabase(config.database);
  const heartbeat = createHeartbeat({ config, db });
  try {
    const events = async () =>
      (await db.all("SELECT message FROM events WHERE kind = 'dzpage.key'", [])).map((row) => ({ ...row }));
    heartbeat.start({ immediate: true });
    await waitFor(() => !heartbeat.running);
    assert.equal(await getSetting(db, KEYS.dzpageKeyRejected), "revoked");
    assert.deepEqual(await events(), [{ message: "Panel-Schlüssel abgelehnt (revoked)" }]);

    // Jeder Neustart des Dienstes trifft wieder auf die Ablehnung: Der
    // Zeitpunkt bleibt der erste, und das Protokoll waechst nicht.
    const since = await getSetting(db, KEYS.dzpageKeyRejectedAt);
    heartbeat.start({ immediate: true });
    await waitFor(() => !heartbeat.running);
    assert.equal(await getSetting(db, KEYS.dzpageKeyRejectedAt), since);
    assert.equal((await events()).length, 1);
  } finally {
    heartbeat.stop();
    await db.close();
  }
  assert.match(
    await status(),
    /^Schlüssel abgelehnt \(auf dzpage\.com widerrufen\) seit \d\d\.\d\d\.\d{4} \d\d:\d\d\. Neu verbinden: sudo dzpage-panel link$/,
  );
});

test("link braucht nach einem vermerkten Widerruf kein --force", async () => {
  const denied = stub.calls.denied.length;
  const result = await runAdmin(["link", "--yes", "--token", newToken("nachwiderruf")]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Der gespeicherte Schlüssel wurde auf dzpage\.com widerrufen\. Verbinde neu/);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  // DZPage hat die Ablehnung bei der Nachfrage bestaetigt.
  assert.deepEqual(stub.calls.denied.slice(denied).map((call) => call.path), ["/api/panel/v1/heartbeat"]);
  assert.ok(!stub.keys.revoked.has(storedKey()), "neuer, gueltiger Schluessel");
  assert.equal(await rejection(), null, "der Vermerk ist weg");
  assert.match(await status(), /^verbunden \(Konto TestKonto\)/);
});

test("Der Abholer vermerkt einen widerrufenen Schlüssel ebenso", async () => {
  stub.keys.revoked.add(storedKey());
  const config = loadConfig({ file: env.configFile });
  const db = await openDatabase(config.database);
  const poller = createPoller({ config, db });
  try {
    poller.start();
    await waitFor(() => !poller.running);
    assert.equal(await getSetting(db, KEYS.dzpageKeyRejected), "revoked");
  } finally {
    poller.stop();
    await db.close();
  }
});

test("Ein gelungener Herzschlag nimmt den Vermerk wieder zurück", async () => {
  // Etwa wenn jemand den Schluessel von Hand in panel.json ersetzt hat.
  stub.keys.revoked.delete(storedKey());
  const config = loadConfig({ file: env.configFile });
  const db = await openDatabase(config.database);
  const heartbeat = createHeartbeat({ config, db, reporter: null });
  try {
    heartbeat.start({ immediate: true });
    await waitFor(async () => (await getSetting(db, KEYS.dzpageKeyRejected)) === null);
  } finally {
    heartbeat.stop();
    await db.close();
  }
});

test("Ein veralteter Vermerk bei gültigem Schlüssel wird zurückgenommen, nichts wird ersetzt", async () => {
  const key = storedKey();
  await withDb((db) => setSetting(db, KEYS.dzpageKeyRejected, "invalid_key"));
  const token = newToken("veraltet");
  const result = await runAdmin(["link", "--yes", "--token", token]);
  // Exit 0 statt 3: Herzschlag und Abholer hatten wegen des Vermerks
  // angehalten, und nur nach 0 startet dzpage-panel den Dienst neu.
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /DZPage nimmt den gespeicherten Schlüssel wieder an \(Konto TestKonto\)/);
  assert.equal(storedKey(), key);
  assert.ok(stub.pairing.tokens.has(token), "der Code bleibt unbenutzt");
  assert.equal(await rejection(), null);
});

test("Eine Sperrseite davor (HTML oder JSON ohne Code) gilt nicht als Ablehnung des Schlüssels", async () => {
  const config = loadConfig({ file: env.configFile });
  const db = await openDatabase(config.database);
  try {
    for (const page of ["html", "json"]) {
      const heartbeat = createHeartbeat({ config, db });
      const before = stub.calls.forbidden;
      stub.state.forbiddenPage = page;
      try {
        heartbeat.start({ immediate: true });
        await waitFor(() => stub.calls.forbidden > before);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(heartbeat.running, true, `${page}: der Herzschlag wartet und versucht es spaeter wieder`);
        assert.equal(await getSetting(db, KEYS.dzpageKeyRejected), null, page);
      } finally {
        stub.state.forbiddenPage = null;
        heartbeat.stop();
      }
    }
  } finally {
    await db.close();
  }
});

test("Ohne Vermerk fragt link bei DZPage nach und koppelt bei Ablehnung neu", async () => {
  // Widerrufen, waehrend der Dienst nicht lief: nichts ist vermerkt.
  stub.keys.revoked.add(storedKey());
  assert.equal(await rejection(), null);
  // Ein Server auf der Maschine: DZPage uebernimmt die Zahl aus dem Herzschlag.
  await withDb(async (db) => {
    const checked = checkServerInput({
      name: "Zaehlserver",
      gamePort: "2302",
      queryPort: "27016",
      rconPort: "2306",
      rconPassword: "rcon-geheim-12345",
      maxPlayers: "10",
      mission: "dayzOffline.chernarusplus",
    });
    assert.ok(checked.ok, checked.code);
    await createServer(db, checked.value, loadConfig({ file: env.configFile }).secrets.encryption);
  });
  const denied = stub.calls.denied.length;
  const result = await runAdmin(["link", "--yes", "--token", newToken("ohnevermerk")]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /widerrufen\. Verbinde neu/);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  // Die Nachfrage ist ein Herzschlag mit der echten Serverzahl, keine erfundene 0.
  const asked = stub.calls.denied.slice(denied);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].path, "/api/panel/v1/heartbeat");
  assert.equal(asked[0].payload.panelId, "panel123456");
  assert.equal(asked[0].payload.serverCount, 1);
  assert.ok(!stub.keys.revoked.has(storedKey()));
});

test("Ein gültiger Schlüssel bleibt; derselbe Befehl koppelt nicht doppelt", async () => {
  const key = storedKey();
  const token = newToken("doppelt");
  const result = await runAdmin(["link", "--yes", "--token", token]);
  assert.equal(result.code, 3, result.output);
  assert.match(result.output, /schon mit DZPage verbunden \(Konto TestKonto\)/);
  assert.match(result.output, /Mit einem anderen Konto verbinden: sudo dzpage-panel link --force/);
  assert.equal(storedKey(), key);
  assert.ok(stub.pairing.tokens.has(token), "der Code bleibt unbenutzt");
});

test("Ist DZPage nicht erreichbar, bleibt der Schlüssel und das Terminal sagt warum", async () => {
  const key = storedKey();
  const result = await runAdmin(["link", "--yes", "--token", newToken("netzweg")], { baseUrl: "http://127.0.0.1:9" });
  assert.equal(result.code, 3, result.output);
  assert.match(result.output, /schon mit DZPage verbunden/);
  assert.match(result.output, /gerade nicht bestätigen \(network\)/);
  assert.equal(storedKey(), key);
});

test("Antwortet DZPage nicht auf die Nachfrage, gilt der Vermerk des Dienstes", async () => {
  stub.keys.revoked.add(storedKey());
  await withDb((db) => setSetting(db, KEYS.dzpageKeyRejected, "revoked"));
  stub.state.failHeartbeat = true;
  try {
    const result = await runAdmin(["link", "--yes", "--token", newToken("vermerkgilt")]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /widerrufen\. Verbinde neu/);
    assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  } finally {
    stub.state.failHeartbeat = false;
  }
  assert.ok(!stub.keys.revoked.has(storedKey()));
  assert.equal(await rejection(), null);
});

test("Lehnt DZPage beim Nachholen der Anmeldung ab, wird neu gekoppelt", async () => {
  stub.keys.revoked.add(storedKey());
  await withDb((db) => db.run("DELETE FROM settings WHERE name = 'dzpage_panel_id'", []));
  const result = await runAdmin(["link", "--yes", "--token", newToken("nachholen")]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Hole sie nach/);
  assert.match(result.output, /widerrufen\. Verbinde neu/);
  assert.match(result.output, /Verbunden mit dem DZPage-Konto TestKonto/);
  assert.equal(await rejection(), null);
});

test("status ohne Schlüssel und mit Schlüssel ohne Anmeldung", async () => {
  await withDb((db) => db.run("DELETE FROM settings WHERE name = 'dzpage_panel_id'", []));
  assert.equal(await status(), "Schlüssel hinterlegt, Anmeldung bei DZPage fehlt (sudo dzpage-panel link)");

  const config = loadConfig({ file: env.configFile });
  const { saveConfig } = await import("../src/config.js");
  config.dzpage.key = null;
  saveConfig(config);
  assert.equal(await status(), "nicht verbunden (sudo dzpage-panel link)");
});
