import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub, unlockSetup } from "../test-support/helper.js";

/**
 * dzpage.com als Verwaltung: Zustandsbericht, Server anlegen, installieren
 * mit Fortschritt, Protokoll, Anmelden und Loeschen per Auftrag. Gegen den
 * Standhalter der Panel-API, mit dem Hilfsprogramm- und SteamCMD-Ersatz.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_HELPER = join(FIXTURES, "fake-helper.sh");
const FAKE_STEAMCMD = join(FIXTURES, "fake-steamcmd.sh");

const env = prepareEnv("remote");
process.on("exit", () => env.cleanup());
chmodSync(FAKE_HELPER, 0o755);
chmodSync(FAKE_STEAMCMD, 0o755);

process.env.DZPAGE_PANEL_HELPER = FAKE_HELPER;
process.env.DZPAGE_PANEL_DOCKER = join(env.root, "kein-docker");
process.env.DZPANEL_FAKE_STATE = join(env.root, "fake-helper");
process.env.DZPAGE_PANEL_PROGRESS_MS = "300";

const { serverDir } = await import("../src/store/servers.js");
const { parseSince } = await import("../src/dzpage/report.js");
const { createInputFrom, tailText } = await import("../src/dzpage/poller.js");
const { steamProgress } = await import("../src/servers/install.js");
const { setSetting, KEYS } = await import("../src/store/settings.js");

const stub = await startDzpageStub();
process.env.DZPAGE_BASE_URL = stub.url;
const panel = await launchPanel();
panel.app.config.steam = { ...panel.app.config.steam, steamcmdPath: FAKE_STEAMCMD };
const client = new Client(panel.url);

test.after(async () => {
  panel.app.poller.stop();
  await panel.stop();
  await stub.stop();
});

function helperCalls() {
  const file = join(process.env.DZPANEL_FAKE_STATE, "calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

async function waitFor(check, { timeoutMs = 20_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Bedingung wurde nicht erreicht.");
}

const resultOf = (jobId, options) => waitFor(() => stub.calls.results.find((r) => r.jobId === jobId), options);
const serverIn = (report, id) => report?.servers.find((s) => s.id === id);
/** Der erste Bericht ab jetzt, auf den die Bedingung zutrifft. */
async function reportWhere(check, { from = stub.calls.reports.length, timeoutMs } = {}) {
  return waitFor(() => stub.calls.reports.slice(from).find(check), { timeoutMs });
}

const SERVER = {
  name: "Fernbestellt",
  gamePort: 2302,
  queryPort: 27016,
  rconPort: 2306,
  rconPassword: "rcon-fern-geheim-1",
  maxPlayers: 40,
  mission: "dayzOffline.chernarusplus",
  memoryMaxMb: 4096,
  cpuQuota: 200,
};

let remoteId = null;

test("Einrichten und mit DZPage verbinden", async () => {
  await unlockSetup(client, env);
  await client.get("/setup/database");
  await client.submit("/setup/database", { kind: "sqlite", action: "save" });
  await client.get("/setup/admin");
  await client.submit("/setup/admin", { username: "admin", password: "panel-passwort-1", password2: "panel-passwort-1" });
  await client.get("/steam");
  await client.submit("/steam", { action: "skip" });
  await client.get("/dzpage");
  await client.submit("/dzpage", { key: stub.key, name: "Testpanel" });
  await client.get("/setup/done");
  await client.submit("/setup/done", {});
  assert.equal(stub.calls.register.length, 1);
});

test("Der Herzschlag bringt den Zustandsbericht mit, ohne Steam-Kontonamen", async () => {
  const from = stub.calls.reports.length;
  panel.app.heartbeat.restart({ immediate: true });
  const report = await reportWhere(() => true, { from });
  assert.equal(report.panelId, "panel123456");
  assert.deepEqual(report.servers, []);
  assert.equal(report.steamLogin, false);
  assert.ok(report.capabilities.includes("create"));
  assert.ok(report.capabilities.includes("logs"));

  await setSetting(panel.app.db, KEYS.steamAccount, "cachedslow_konto");
  await setSetting(panel.app.db, KEYS.steamLoggedInAt, Date.now());
  const next = await panel.app.reporter.report({ force: true });
  assert.equal(next.ok, true);
  const latest = stub.calls.reports.at(-1);
  assert.equal(latest.steamLogin, true);
  assert.doesNotMatch(JSON.stringify(latest), /cachedslow_konto/);
});

test("Server anlegen per Auftrag: gleiche Prüfung, gleich bei DZPage angemeldet", async () => {
  stub.queueJob({ id: "create-1", kind: "create", serverId: null, payload: SERVER });
  panel.app.poller.restart();
  const done = await resultOf("create-1");
  assert.equal(done.status, "done", done.detail);
  assert.match(done.result.serverId, /^[a-f0-9]{12}$/);
  assert.equal(done.result.rconServerId, "rcon123456");
  remoteId = done.result.serverId;

  // Erst "laeuft", dann das Ergebnis.
  assert.ok(stub.calls.progress.some((p) => p.jobId === "create-1"));

  // Angemeldet mit genau dem Passwort aus dem Auftrag.
  const registration = stub.calls.servers.find((s) => s.serverId === remoteId);
  assert.equal(registration.rconPassword, SERVER.rconPassword);
  assert.equal(registration.rconPort, 2306);

  // Dieselben Dateien wie beim Formular im Panel.
  const cfg = readFileSync(join(serverDir(remoteId), "serverDZ.cfg"), "utf8");
  assert.match(cfg, /hostname = "Fernbestellt";/);
  assert.match(cfg, /maxPlayers = 40;/);

  const report = await reportWhere((r) => serverIn(r, remoteId));
  const entry = serverIn(report, remoteId);
  assert.equal(entry.installState, "new");
  assert.equal(entry.state, "stopped");
  assert.equal(entry.registered, true);
  assert.equal(entry.gamePort, 2302);
  assert.equal(entry.memoryMaxMb, 4096);
});

test("Server anlegen: jedes Feld wird geprüft, Fremdes ignoriert", async () => {
  const cases = [
    ["bad-name", { ...SERVER, name: "x", gamePort: 2402, queryPort: 27116, rconPort: 2406 }, "name"],
    ["bad-array", { ...SERVER, gamePort: [2402] }, "payload"],
    ["bad-object", { ...SERVER, name: { toString: "Fernbestellt" } }, "payload"],
    ["bad-password", { ...SERVER, rconPassword: "mit leerzeichen", gamePort: 2402, queryPort: 27116, rconPort: 2406 }, "rcon_password"],
    ["bad-ports", { ...SERVER, gamePort: 2402, queryPort: 2402, rconPort: 2406 }, "port_conflict"],
    ["low-port", { ...SERVER, gamePort: 80, queryPort: 27116, rconPort: 2406 }, "port"],
    ["port-taken", { ...SERVER, name: "Zweiter" }, "port_taken"],
    ["no-payload", undefined, "payload"],
    ["mission", { ...SERVER, mission: "../../etc", gamePort: 2402, queryPort: 27116, rconPort: 2406 }, "mission"],
  ];
  const before = (await panel.app.db.all("SELECT id FROM servers", [])).length;
  for (const [id, payload, code] of cases) stub.queueJob({ id, kind: "create", serverId: null, payload });
  for (const [id, , code] of cases) {
    const result = await resultOf(id);
    assert.equal(result.status, "failed", `${id}: ${result.detail}`);
    assert.equal(result.code, code, `${id}: ${result.detail}`);
  }
  assert.equal((await panel.app.db.all("SELECT id FROM servers", [])).length, before, "nichts darf angelegt sein");

  // Felder ausserhalb des Formulars kommen nicht durch: keine eigene Kennung,
  // keine Laufzeit, keine Pfade.
  stub.queueJob({
    id: "extra",
    kind: "create",
    serverId: null,
    payload: { ...SERVER, name: "Mit Extras", gamePort: 2502, queryPort: 27216, rconPort: 2506, id: "aaaaaaaaaaaa", runtime: "docker", install_state: "ready" },
  });
  const extra = await resultOf("extra");
  assert.equal(extra.status, "done", extra.detail);
  assert.notEqual(extra.result.serverId, "aaaaaaaaaaaa");
  const row = await panel.app.db.get("SELECT runtime, install_state FROM servers WHERE id = ?", [extra.result.serverId]);
  assert.equal(row.runtime, "systemd");
  assert.equal(row.install_state, "new");
});

test("Installieren von dzpage.com: Fortschritt, dann bereit mit Build", async () => {
  const from = stub.calls.reports.length;
  stub.queueJob({ id: "install-1", kind: "update", serverId: remoteId });
  const done = await resultOf("install-1", { timeoutMs: 30_000 });
  assert.equal(done.status, "done", done.detail);

  const progress = stub.calls.progress.filter((p) => p.jobId === "install-1");
  const percents = progress.map((p) => p.percent).filter((p) => p !== undefined);
  assert.ok(percents.length >= 2, `Zwischenstaende erwartet: ${JSON.stringify(progress)}`);
  assert.ok(percents.every((p) => p >= 0 && p <= 100));
  assert.ok(progress.some((p) => /downloading, progress/.test(p.progress ?? "")));
  // Kontoname und Pfade bleiben auf der Maschine.
  assert.ok(
    progress.every((p) => !/cachedslow_konto|\/var\/|servers\//.test(p.progress ?? "")),
    JSON.stringify(progress.map((p) => p.progress)),
  );

  // Waehrend der Installation steht "installing" in einem Bericht, danach "ready".
  await reportWhere((r) => serverIn(r, remoteId)?.installState === "installing", { from });
  const ready = await reportWhere((r) => serverIn(r, remoteId)?.installState === "ready", { from });
  assert.equal(serverIn(ready, remoteId).installedBuild, "24041098");
});

test("Starten von dzpage.com: Zustand, Laufzeit und Speicher kommen an", async () => {
  const from = stub.calls.reports.length;
  stub.queueJob({ id: "start-1", kind: "start", serverId: remoteId });
  const done = await resultOf("start-1");
  assert.equal(done.status, "done", done.detail);
  const report = await reportWhere((r) => serverIn(r, remoteId)?.state === "running", { from });
  const entry = serverIn(report, remoteId);
  assert.equal(entry.memoryBytes, 524288000);
  assert.equal(entry.restarts, 1);
  assert.equal(entry.since, Date.UTC(2026, 0, 5, 10, 0, 0));
});

test("Zwei Installationen gleichzeitig: die zweite wartet statt abzubrechen", async () => {
  const other = await waitFor(async () =>
    panel.app.db.get("SELECT id FROM servers WHERE name = ?", ["Mit Extras"]),
  );
  stub.queueJob({ id: "install-a", kind: "update", serverId: remoteId });
  stub.queueJob({ id: "install-b", kind: "update", serverId: other.id });
  const a = await resultOf("install-a", { timeoutMs: 30_000 });
  const b = await resultOf("install-b", { timeoutMs: 30_000 });
  assert.equal(a.status, "done", a.detail);
  assert.equal(b.status, "done", b.detail);
  // Welcher zuerst drankommt, entscheidet das Rennen um den einen Platz; einer
  // von beiden muss gewartet haben.
  const waited = stub.calls.progress
    .filter((p) => p.jobId === "install-a" || p.jobId === "install-b")
    .map((p) => p.progress ?? "");
  assert.ok(waited.some((text) => /Wartet/.test(text)), waited.join(" | "));
});

test("Protokoll von dzpage.com: letzte Zeilen, Zeilenzahl geprüft", async () => {
  stub.queueJob({ id: "logs-1", kind: "logs", serverId: remoteId, payload: { lines: 200 } });
  const logs = await resultOf("logs-1");
  assert.equal(logs.status, "done", logs.detail);
  assert.match(logs.result, /DayZ server ready/);
  assert.ok(helperCalls().includes(`logs ${remoteId} 200`));

  stub.queueJob({ id: "logs-2", kind: "logs", serverId: remoteId, payload: { lines: 99999 } });
  stub.queueJob({ id: "logs-3", kind: "logs", serverId: remoteId, payload: { lines: "200; rm -rf /" } });
  for (const id of ["logs-2", "logs-3"]) {
    const result = await resultOf(id);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "payload");
  }
});

test("Eine wartende Installation bricht ab, wenn der Server inzwischen gelöscht ist", async () => {
  stub.queueJob({
    id: "create-gone",
    kind: "create",
    serverId: null,
    payload: { ...SERVER, name: "Gleich weg", gamePort: 2902, queryPort: 27616, rconPort: 2906 },
  });
  const created = await resultOf("create-gone");
  assert.equal(created.status, "done", created.detail);
  const goneId = created.result.serverId;

  // Ein anderer Vorgang belegt den einen Platz; die Installation wartet.
  let release;
  const hold = panel.app.jobs.start("test-hold", () => new Promise((resolve) => (release = resolve)));
  assert.equal(hold.ok, true);
  stub.queueJob({ id: "install-gone", kind: "update", serverId: goneId });
  await waitFor(() => stub.calls.progress.find((p) => p.jobId === "install-gone" && /Wartet/.test(p.progress ?? "")));

  // Waehrenddessen verschwindet der Server (wie beim Loeschen im Panel).
  await panel.app.db.run("DELETE FROM servers WHERE id = ?", [goneId]);
  const callsBefore = helperCalls().length;
  release();

  const result = await resultOf("install-gone");
  assert.equal(result.status, "failed");
  assert.equal(result.code, "unknown_server");
  assert.doesNotMatch(helperCalls().slice(callsBefore).join("\n"), new RegExp(`prepare ${goneId}`));
});

test("Ein im Panel angelegter Server lässt sich von dzpage.com aus anmelden", async () => {
  await client.get("/servers/new");
  await client.submit("/servers/new", {
    name: "Lokal angelegt",
    gamePort: "2602",
    queryPort: "27316",
    rconPort: "2606",
    rconPassword: "rcon-lokal-geheim",
    maxPlayers: "10",
    mission: "dayzOffline.chernarusplus",
    memoryMaxMb: "2048",
    cpuQuota: "100",
  });
  const localId = client.lastLocation.split("=")[1];
  const report = await reportWhere((r) => serverIn(r, localId));
  assert.equal(serverIn(report, localId).registered, false);

  stub.queueJob({ id: "register-1", kind: "register", serverId: localId });
  const done = await resultOf("register-1");
  assert.equal(done.status, "done", done.detail);
  assert.equal(done.result.rconServerId, "rcon123456");
  await reportWhere((r) => serverIn(r, localId)?.registered === true);
});

test("Löschen von dzpage.com räumt ab wie die Schaltfläche", async () => {
  const unregisterBefore = stub.calls.unregister.length;
  stub.queueJob({ id: "delete-1", kind: "delete", serverId: remoteId });
  const done = await resultOf("delete-1");
  assert.equal(done.status, "done", done.detail);
  assert.equal(existsSync(serverDir(remoteId)), false);
  assert.ok(helperCalls().includes(`destroy ${remoteId}`));
  assert.deepEqual(stub.calls.unregister.slice(unregisterBefore), [{ panelId: "panel123456", serverId: remoteId }]);
  await reportWhere((r) => !serverIn(r, remoteId));

  // Danach kennt das Panel den Server nicht mehr.
  stub.queueJob({ id: "start-gone", kind: "start", serverId: remoteId });
  const gone = await resultOf("start-gone");
  assert.equal(gone.status, "failed");
  assert.equal(gone.code, "unknown_server");
});

test("Unbekannte Aufträge bleiben abgelehnt, ohne Kennung wird nichts zurückgemeldet", async () => {
  stub.queueJob({ id: "shell-1", kind: "shell", serverId: null, payload: { command: "rm -rf /" } });
  const shell = await resultOf("shell-1");
  assert.equal(shell.status, "failed");
  assert.equal(shell.code, "kind");
  assert.equal(stub.calls.progress.some((p) => p.jobId === "shell-1"), false, "kein 'läuft' für Unbekanntes");

  stub.queueJob({ id: "bad id; drop", kind: "start", serverId: null });
  stub.queueJob({ id: "after-bad", kind: "logs", serverId: "ffffffffffff" });
  await resultOf("after-bad");
  assert.equal(stub.calls.results.some((r) => r.jobId === "bad id; drop"), false);
});

test("Ein dzpage.com ohne Zustandsbericht wird nicht nach jedem Anlass gefragt", async () => {
  stub.state.noReport = true;
  try {
    const first = await panel.app.reporter.report({ force: true });
    assert.equal(first.ok, false);
    assert.equal(first.code, "not_found");
    const misses = stub.calls.reportMisses;
    for (let i = 0; i < 3; i += 1) await panel.app.reporter.report({ force: true });
    assert.equal(stub.calls.reportMisses, misses, "nach der ersten Absage Ruhe");

    // Der Herzschlag laeuft davon unberuehrt weiter.
    const beats = stub.calls.heartbeat.length;
    panel.app.heartbeat.restart({ immediate: true });
    await waitFor(() => stub.calls.heartbeat.length > beats);
  } finally {
    stub.state.noReport = false;
  }
});

test("Startzeit aus systemd und Docker", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  assert.equal(parseSince("Thu 2026-10-08 10:00:00 UTC", now), Date.UTC(2026, 9, 8, 10, 0, 0));
  assert.equal(parseSince("2026-10-08T10:00:00.123456789Z", now), Date.parse("2026-10-08T10:00:00.123Z"));
  assert.equal(parseSince("0001-01-01T00:00:00Z", now), null);
  assert.equal(parseSince("n/a", now), null);
  assert.equal(parseSince("", now), null);
  assert.equal(parseSince(null, now), null);
  assert.equal(parseSince("Thu 2027-10-08 10:00:00 UTC", now), null, "Zukunft ist ein Messfehler");
  // Andere Zone: Ortszeit dieses Prozesses, wie systemd sie geschrieben hat.
  assert.equal(parseSince("Thu 2026-10-08 10:00:00 CEST", now), new Date(2026, 9, 8, 10, 0, 0).getTime());
});

test("Fortschritt aus der SteamCMD-Ausgabe und Protokoll-Kürzung", () => {
  assert.deepEqual(steamProgress(["Logging in", " Update state (0x61) downloading, progress: 62.25 (1 / 2)", "x"]), {
    percent: 62.25,
    text: "Update state (0x61) downloading, progress: 62.25 (1 / 2)",
  });
  // Andere Zeilen gehen nie hinaus, auch nicht ersatzweise: Darin stehen der
  // Steam-Kontoname und Pfade der Maschine.
  assert.deepEqual(steamProgress(["Installiere DayZ (App 223350) nach /var/lib/dzpage-panel/servers/x/game."]), {
    percent: null,
    text: null,
  });
  assert.deepEqual(steamProgress(["Logging in user 'mein_konto' [U:1:0] to Steam Public...OK"]), {
    percent: null,
    text: null,
  });
  assert.deepEqual(steamProgress(["progress: 50 bei mein_konto"]), { percent: null, text: null });
  assert.deepEqual(steamProgress([]), { percent: null, text: null });

  const long = Array.from({ length: 5000 }, (_, i) => `Zeile ${i} ${"x".repeat(40)}`).join("\n");
  const tail = tailText(long, 4096);
  assert.ok(Buffer.byteLength(tail) <= 4096);
  assert.match(tail, /Zeile 4999 /);
  assert.equal(tailText("kurz"), "kurz");
  // Eine einzelne Zeile ueber der Grenze: ihr Ende statt eines leeren Protokolls.
  const oneLine = tailText(`Anfang${"y".repeat(10_000)}Ende`, 4096);
  assert.equal(Buffer.byteLength(oneLine), 4096);
  assert.match(oneLine, /Ende$/);

  assert.throws(() => createInputFrom(null), /keine Serverangaben/);
  assert.throws(() => createInputFrom([1, 2]), /keine Serverangaben/);
  assert.deepEqual(createInputFrom({ name: "A", gamePort: 2302, extra: "x" }), { name: "A", gamePort: "2302" });
});
