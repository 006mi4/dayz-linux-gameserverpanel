import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub, unlockSetup } from "../test-support/helper.js";

/**
 * Spielserver: anlegen, Konfigurationsdateien schreiben, starten, stoppen,
 * neu starten — und die Aufträge, die von DZPage kommen.
 *
 * Das privilegierte Hilfsprogramm ist hier durch einen Ersatz vertreten, der
 * seine Aufrufe mitschreibt. Der echte Lauf gegen systemd steht daneben in
 * scripts/verify-runtime.sh und braucht Rootrechte.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_HELPER = join(FIXTURES, "fake-helper.sh");
const FAKE_STEAMCMD = join(FIXTURES, "fake-steamcmd.sh");

const env = prepareEnv("servers");
process.on("exit", () => env.cleanup());
chmodSync(FAKE_HELPER, 0o755);
chmodSync(FAKE_STEAMCMD, 0o755);

process.env.DZPAGE_PANEL_HELPER = FAKE_HELPER;
// Docker gibt es in der Suite nicht — der Pfad ins Leere macht das eindeutig,
// statt sich darauf zu verlassen, dass auf der Maschine keins installiert ist.
process.env.DZPAGE_PANEL_DOCKER = join(env.root, "kein-docker");
process.env.DZPANEL_FAKE_STATE = join(env.root, "fake-helper");

const { checkServerInput, DEFAULTS, serverDir } = await import("../src/store/servers.js");
const { serverDzCfg, battleyeCfg, serverEnv, writeServerFiles } = await import("../src/servers/config.js");

/**
 * Ein Panel und ein Standhalter fuer die ganze Datei: die Pfade stehen beim
 * ersten Laden von paths.js fest, ein zweites Verzeichnis gaebe es im selben
 * Prozess also gar nicht.
 */
const stub = await startDzpageStub();
process.env.DZPAGE_BASE_URL = stub.url;
const panel = await launchPanel();
const client = new Client(panel.url);

test.after(async () => {
  panel.app.poller.stop();
  await panel.stop();
  await stub.stop();
});

async function completeSetup() {
  await unlockSetup(client, env);
  await client.get("/setup/database");
  await client.submit("/setup/database", { kind: "sqlite", action: "save" });
  await client.get("/setup/admin");
  await client.submit("/setup/admin", {
    username: "admin",
    password: "panel-passwort-1",
    password2: "panel-passwort-1",
  });
  await client.get("/steam");
  await client.submit("/steam", { action: "skip" });
  await client.get("/dzpage");
  await client.submit("/dzpage", { key: stub.key, name: "Testpanel" });
  await client.get("/setup/done");
  await client.submit("/setup/done", {});
}

async function createServer(fields) {
  await client.get("/servers/new");
  await client.submit("/servers/new", {
    mission: "dayzOffline.chernarusplus",
    memoryMaxMb: "4096",
    cpuQuota: "200",
    ...fields,
  });
  return client.lastLocation?.startsWith("/server?id=") ? client.lastLocation.split("=")[1] : null;
}

function helperCalls() {
  const file = join(process.env.DZPANEL_FAKE_STATE, "calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

async function waitFor(check, { timeoutMs = 20_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Bedingung wurde nicht erreicht.");
}

test("Eingaben werden geprüft", () => {
  const good = {
    name: "Mein Server",
    gamePort: "2302",
    queryPort: "27016",
    rconPort: "2306",
    maxPlayers: "60",
    mission: DEFAULTS.mission,
    rconPassword: "geheim-genug",
    memoryMaxMb: "6144",
    cpuQuota: "400",
  };
  assert.equal(checkServerInput(good).ok, true);
  assert.equal(checkServerInput({ ...good, name: "x" }).code, "name");
  assert.equal(checkServerInput({ ...good, gamePort: "80" }).code, "port");
  assert.equal(checkServerInput({ ...good, queryPort: "2302" }).code, "port_conflict");
  assert.equal(checkServerInput({ ...good, maxPlayers: "0" }).code, "players");
  assert.equal(checkServerInput({ ...good, mission: "../etc/passwd" }).code, "mission");
  assert.equal(checkServerInput({ ...good, rconPassword: "mit leer" }).code, "rcon_password");
  assert.equal(checkServerInput({ ...good, memoryMaxMb: "10" }).code, "memory");
});

test("Konfigurationsdateien sehen aus wie die eines laufenden Servers", () => {
  const server = {
    id: "aabbccddeeff",
    name: 'Test "Server"',
    max_players: 40,
    query_port: 27016,
    game_port: 2302,
    rcon_port: 2306,
    mission: "dayzOffline.chernarusplus",
    cpu_quota: 400,
  };
  const cfg = serverDzCfg(server);
  assert.match(cfg, /hostname = "Test Server";/);
  assert.match(cfg, /maxPlayers = 40;/);
  assert.match(cfg, /steamQueryPort = 27016;/);
  assert.match(cfg, /template = "dayzOffline\.chernarusplus";/);
  assert.match(cfg, /class Missions/);

  assert.equal(battleyeCfg({ rconPassword: "abc123", rconPort: 2306 }), "RConPassword abc123\nRConPort 2306\nRestrictRCon 0\n");
  assert.throws(() => battleyeCfg({ rconPassword: "mit leer", rconPort: 2306 }), /Leerzeichen/);
  assert.match(serverEnv(server), /DZ_PORT=2302/);
  assert.match(serverEnv(server), /DZ_CPU_COUNT=4/);
});

test("Eine alte aktive BattlEye-Datei wird entfernt", () => {
  const server = {
    id: "112233445566",
    name: "Server",
    max_players: 10,
    query_port: 27016,
    game_port: 2402,
    rcon_port: 2406,
    mission: "dayzOffline.chernarusplus",
    cpu_quota: 200,
  };
  const battleye = join(serverDir(server.id), "profiles", "battleye");
  mkdirSync(battleye, { recursive: true });
  writeFileSync(join(battleye, "beserver_x64_active_37e9cd34.cfg"), "RConPassword alt\n");

  writeServerFiles(server, "neues-passwort");

  assert.equal(existsSync(join(battleye, "beserver_x64_active_37e9cd34.cfg")), false);
  // BattlEye liest je nach Version klein oder gross geschrieben — beide da.
  for (const name of ["beserver_x64.cfg", "BEServer_x64.cfg"]) {
    assert.match(readFileSync(join(battleye, name), "utf8"), /RConPassword neues-passwort/);
  }
});

test("Server anlegen, steuern und löschen — über die Oberfläche", async () => {
  await completeSetup();

  await client.get("/servers");
  assert.match(client.lastBody, /No servers yet/);
  const serverId = await createServer({
    name: "Testserver",
    gamePort: "2302",
    queryPort: "27016",
    rconPort: "2306",
    rconPassword: "rcon-geheim-1",
    maxPlayers: "40",
  });
  assert.equal(client.lastStatus, 303);
  assert.match(serverId, /^[a-f0-9]{12}$/);
  const detailPath = `/server?id=${serverId}`;

  // Die Konfigurationsdateien liegen sofort da, auch ohne Spieldateien.
  assert.equal(existsSync(join(serverDir(serverId), "serverDZ.cfg")), true);
  assert.match(readFileSync(join(serverDir(serverId), "server.env"), "utf8"), /DZ_PORT=2302/);

  // Zweiter Server mit demselben Port wird abgewiesen
  await createServer({
    name: "Zweiter",
    gamePort: "2302",
    queryPort: "27017",
    rconPort: "2307",
    rconPassword: "rcon-geheim-2",
    maxPlayers: "40",
  });
  assert.match(client.lastBody, /already uses one of these ports/);

  // Steuern
  await client.get(detailPath);
  assert.match(client.lastBody, /Testserver/);
  assert.match(client.lastBody, /stopped/);

  await client.submit("/server/action", { id: serverId, action: "start" });
  assert.equal(client.lastLocation, detailPath);
  await client.get(detailPath);
  assert.match(client.lastBody, /running/);
  assert.match(client.lastBody, /500 MB/);

  await client.submit("/server/action", { id: serverId, action: "stop" });
  await client.get(detailPath);
  assert.match(client.lastBody, /stopped/);

  await client.submit("/server/action", { id: serverId, action: "autostart-on" });
  await client.get(detailPath);
  assert.match(client.lastBody, /Yes/);

  // Bei DZPage anmelden
  await client.submit("/server/action", { id: serverId, action: "register" });
  assert.equal(stub.calls.servers.length, 1);
  assert.equal(stub.calls.servers[0].rconPort, 2306);
  assert.equal(stub.calls.servers[0].rconPassword, "rcon-geheim-1");
  await client.get(detailPath);
  assert.match(client.lastBody, /registered/);

  const calls = helperCalls().join("\n");
  assert.match(calls, new RegExp(`start ${serverId}`));
  assert.match(calls, new RegExp(`stop ${serverId}`));
  assert.match(calls, new RegExp(`enable ${serverId}`));

  // Die Firewall wird vor jedem Start mit den drei Ports angesprochen, und die
  // Seite sagt, was davon zu halten ist.
  assert.match(helperCalls().join("\n"), new RegExp(`firewall-open ${serverId} 2302 27016 2306`));
  await client.get(detailPath);
  assert.match(client.lastBody, /no local firewall active/);
  assert.match(client.lastBody, /UDP 2302, 27016, 2306 must be reachable/);

  // Löschen fragt nach und räumt dann auf
  await client.submit("/server/action", { id: serverId, action: "delete" });
  assert.match(client.lastBody, /Delete permanently/);
  await client.submit("/server/action", { id: serverId, action: "delete-confirm" });
  assert.equal(client.lastLocation, "/servers");
  assert.equal(existsSync(serverDir(serverId)), false);
  const after = helperCalls().join("\n");
  assert.match(after, new RegExp(`destroy ${serverId}`));
  assert.match(after, new RegExp(`firewall-close ${serverId} 2302 27016 2306`));
  // Bei DZPage abgemeldet, sonst stuende der Server dort weiter in der Liste.
  assert.deepEqual(stub.calls.unregister, [{ panelId: "panel123456", serverId }]);
});

test("Aufträge von DZPage werden geprüft und ausgeführt", async () => {
  const serverId = await createServer({
    name: "Fernserver",
    gamePort: "2402",
    queryPort: "27116",
    rconPort: "2406",
    rconPassword: "rcon-geheim-3",
    maxPlayers: "20",
  });
  assert.match(serverId, /^[a-f0-9]{12}$/);

  // Ohne Spieldateien wird ein Start abgelehnt, statt "ausgefuehrt" zu melden,
  // waehrend DayZ sofort wieder aussteigt.
  stub.queueJob({ id: "job0", kind: "start", serverId });
  panel.app.poller.restart();
  const refused = await waitFor(() => stub.calls.results.find((r) => r.jobId === "job0"));
  assert.equal(refused.status, "failed");
  assert.match(refused.detail, /nicht installiert/);

  // Waehrend einer Installation heisst die Antwort "laeuft gerade", nicht
  // "nicht installiert".
  await panel.app.db.run("UPDATE servers SET install_state = 'installing' WHERE id = ?", [serverId]);
  stub.queueJob({ id: "job0b", kind: "restart", serverId });
  const busy = await waitFor(() => stub.calls.results.find((r) => r.jobId === "job0b"));
  assert.equal(busy.status, "failed");
  assert.match(busy.detail, /gerade installiert/);

  // Auftrag von DZPage: starten. Entscheidend ist, dass DayZServer da liegt,
  // nicht der Vermerk in der Datenbank (Server aus 0.3.x stehen oft auf
  // "fehlgeschlagen" und haben ihre Dateien trotzdem).
  await panel.app.db.run("UPDATE servers SET install_state = 'failed' WHERE id = ?", [serverId]);
  mkdirSync(join(serverDir(serverId), "game"), { recursive: true });
  writeFileSync(join(serverDir(serverId), "game", "DayZServer"), "#!/bin/sh\n", { mode: 0o755 });
  stub.queueJob({ id: "job1", kind: "start", serverId });
  const result = await waitFor(() => stub.calls.results.find((r) => r.jobId === "job1"));
  assert.equal(result.status, "done");
  assert.match(helperCalls().join("\n"), new RegExp(`start ${serverId}`));

  // Auftrag mit unbekanntem Server wird abgelehnt, nicht ausgeführt
  stub.queueJob({ id: "job2", kind: "restart", serverId: "ffffffffffff" });
  const rejected = await waitFor(() => stub.calls.results.find((r) => r.jobId === "job2"));
  assert.equal(rejected.status, "failed");
  assert.match(rejected.detail, /kennt/);

  // Unbekannte Auftragsart wird ebenfalls abgelehnt
  stub.queueJob({ id: "job3", kind: "rm-rf", serverId });
  const unknown = await waitFor(() => stub.calls.results.find((r) => r.jobId === "job3"));
  assert.equal(unknown.status, "failed");
  assert.match(unknown.detail, /Unbekannte Auftragsart/);

  panel.app.poller.stop();
});

test("Vor dem Starten wird eingerichtet", async () => {
  const serverId = await createServer({
    name: "Heilserver",
    gamePort: "2502",
    queryPort: "27216",
    rconPort: "2506",
    rconPassword: "rcon-geheim-4",
    maxPlayers: "20",
  });

  await client.get(`/server?id=${serverId}`);
  await client.submit("/server/action", { id: serverId, action: "start" });
  // prepare legt Benutzer, Rechte und Drop-in an. Ohne diesen Aufruf bleibt ein
  // Server, dessen Einrichtung einmal abgeraeumt wurde, fuer immer unstartbar —
  // genau das ist auf einem echten Server passiert.
  const calls = helperCalls();
  const prepared = calls.findIndex((line) => line.startsWith(`prepare ${serverId}`));
  const started = calls.findIndex((line) => line === `start ${serverId}`);
  assert.ok(prepared >= 0, "prepare muss aufgerufen worden sein");
  assert.ok(started > prepared, `start muss danach kommen: ${calls.join(" | ")}`);
});

test("Ein misslungener Laufzeitwechsel lässt den Server heil", async () => {
  const serverId = await createServer({
    name: "Wechselserver",
    gamePort: "2602",
    queryPort: "27316",
    rconPort: "2606",
    rconPassword: "rcon-geheim-5",
    maxPlayers: "20",
  });
  const before = helperCalls().length;

  // Docker gibt es in dieser Umgebung nicht, also scheitert prepare. Frueher
  // hat der Wechsel die alte Laufzeit vorher abgeraeumt: Benutzer weg, Unit
  // weg, neue Laufzeit nicht da — der Server war danach nicht mehr zu starten.
  await client.get(`/server?id=${serverId}`);
  await client.submit("/server/action", { id: serverId, action: "runtime-docker" });

  const row = await panel.app.db.get("SELECT runtime FROM servers WHERE id = ?", [serverId]);
  assert.equal(row.runtime, "systemd", "die Laufzeit darf erst nach dem Gelingen umgestellt werden");
  const calls = helperCalls().slice(before).join("\n");
  assert.doesNotMatch(calls, new RegExp(`destroy ${serverId}`), "nichts darf abgeraeumt worden sein");
});

/**
 * Ein Weg fuer Schaltflaeche, DZPage-Auftrag und automatische Aktualisierung.
 * Bis 0.3.x hielten nur die automatische Aktualisierung einen laufenden Server
 * an; die Schaltflaeche und der Auftrag von dzpage.com tauschten die Dateien
 * unter dem laufenden DayZ aus.
 */
test("Spieldateien aktualisieren hält einen laufenden Server an und startet ihn wieder", async () => {
  const { setSetting, KEYS } = await import("../src/store/settings.js");
  panel.app.config.steam = { ...panel.app.config.steam, steamcmdPath: FAKE_STEAMCMD };
  await setSetting(panel.app.db, KEYS.steamAccount, "cached_konto");

  const serverId = await createServer({
    name: "Updateserver",
    gamePort: "2702",
    queryPort: "27416",
    rconPort: "2706",
    rconPassword: "rcon-geheim-6",
    maxPlayers: "20",
  });
  const detailPath = `/server?id=${serverId}`;
  const row = () => panel.app.db.get("SELECT install_state, installed_build FROM servers WHERE id = ?", [serverId]);

  // Erstinstallation ueber die Oberflaeche
  await client.get(detailPath);
  await client.submit("/server/action", { id: serverId, action: "install" });
  assert.match(client.lastLocation, /^\/job\?id=/);
  const first = await panel.app.jobs.current().completion;
  assert.equal(first.status, "ok", first.error);
  assert.equal((await row()).install_state, "ready");
  assert.equal((await row()).installed_build, "24041098");
  assert.match(first.lines.join("\n"), /Bibliotheken von DayZServer/);
  // Neu angelegte Server stehen auf "startet mit der Maschine"; nach der
  // ersten Installation gibt es etwas zu starten, also wird die Unit aktiviert.
  assert.match(helperCalls().join("\n"), new RegExp(`enable ${serverId}`));

  await client.get(detailPath);
  await client.submit("/server/action", { id: serverId, action: "start" });
  await client.get(detailPath);
  assert.match(client.lastBody, /running/);

  // Aktualisierung von DZPage aus: anhalten, installieren, wieder starten.
  const before = helperCalls().length;
  stub.queueJob({ id: "job-update", kind: "update", serverId });
  panel.app.poller.restart();
  const result = await waitFor(() => stub.calls.results.find((r) => r.jobId === "job-update"), { timeoutMs: 30_000 });
  panel.app.poller.stop();
  assert.equal(result.status, "done", result.detail);
  const calls = helperCalls().slice(before);
  const stopAt = calls.indexOf(`stop ${serverId}`);
  const prepareAt = calls.findIndex((line) => line.startsWith(`prepare ${serverId}`));
  const startAt = calls.lastIndexOf(`start ${serverId}`);
  assert.ok(stopAt >= 0 && stopAt < prepareAt && prepareAt < startAt, calls.join(" | "));

  // Scheitert eine Aktualisierung, bleibt der Server benutzbar und laeuft
  // mit den alten Dateien weiter. Frueher stand er danach auf "fehlgeschlagen",
  // und der Start-Knopf war gesperrt.
  await setSetting(panel.app.db, KEYS.steamAccount, "abgelaufen_konto");
  await client.get(detailPath);
  await client.submit("/server/action", { id: serverId, action: "install" });
  const failed = await panel.app.jobs.current().completion;
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Steam-Sitzung ist abgelaufen/);
  assert.equal((await row()).install_state, "ready");
  await client.get(detailPath);
  assert.match(client.lastBody, /running/);
});

test("ldd-Ausgabe: fehlende Bibliotheken werden erkannt", async () => {
  const { parseLddOutput } = await import("../src/servers/install.js");
  const sample = [
    "\tlinux-vdso.so.1 (0x00007ffd5b3f2000)",
    "\tlibsteam_api.so => /srv/dayz/game/libsteam_api.so (0x00007f0e3c600000)",
    "\tlibcurl.so.4 => not found",
    "\tlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f0e3c200000)",
    "\tlibcurl.so.4 => not found",
  ].join("\n");
  assert.deepEqual(parseLddOutput(sample), ["libcurl.so.4"]);
  assert.deepEqual(parseLddOutput("\tnot a dynamic executable"), []);
});

/**
 * Prueferbefunde zu updateGameFiles: Ein Server zwischen zwei Startversuchen
 * ("starting") wird ebenfalls angehalten, und ein Fehler NACH dem Download
 * laesst ihn nicht mit Dateien wieder anlaufen, die es so nicht mehr gibt.
 */
test("Aktualisierung: abstürzender Server wird angehalten, Fehler nach dem Download lässt ihn aus", async () => {
  const { setSetting, KEYS } = await import("../src/store/settings.js");
  panel.app.config.steam = { ...panel.app.config.steam, steamcmdPath: FAKE_STEAMCMD };
  await setSetting(panel.app.db, KEYS.steamAccount, "cached_konto");

  const serverId = await createServer({
    name: "Absturzserver",
    gamePort: "2802",
    queryPort: "27516",
    rconPort: "2806",
    rconPassword: "rcon-geheim-7",
    maxPlayers: "20",
  });
  const detailPath = `/server?id=${serverId}`;
  const stateFile = join(process.env.DZPANEL_FAKE_STATE, `${serverId}.state`);
  const failFlag = join(process.env.DZPANEL_FAKE_STATE, "fail-prepare");

  await client.get(detailPath);
  await client.submit("/server/action", { id: serverId, action: "install" });
  assert.equal((await panel.app.jobs.current().completion).status, "ok");

  // systemd zwischen zwei Startversuchen: auch das muss vor dem Download weg.
  writeFileSync(stateFile, "starting\n");
  let before = helperCalls().length;
  await client.get(detailPath);
  await client.submit("/server/action", { id: serverId, action: "install" });
  assert.equal((await panel.app.jobs.current().completion).status, "ok");
  let calls = helperCalls().slice(before);
  assert.ok(calls.includes(`stop ${serverId}`), calls.join(" | "));
  assert.ok(calls.lastIndexOf(`start ${serverId}`) > calls.indexOf(`stop ${serverId}`), calls.join(" | "));

  // Jetzt scheitert ein Schritt nach dem Download.
  writeFileSync(stateFile, "running\n");
  writeFileSync(failFlag, "1\n");
  before = helperCalls().length;
  await client.get(detailPath);
  await client.submit("/server/action", { id: serverId, action: "install" });
  const failed = await panel.app.jobs.current().completion;
  rmSync(failFlag);
  assert.equal(failed.status, "failed");
  assert.match(failed.lines.join("\n"), /bleibt angehalten/);
  calls = helperCalls().slice(before);
  assert.ok(calls.includes(`stop ${serverId}`), calls.join(" | "));
  assert.equal(calls.includes(`start ${serverId}`), false, "mit halb ausgetauschten Dateien kein Neustart");
  const row = await panel.app.db.get("SELECT install_state FROM servers WHERE id = ?", [serverId]);
  assert.equal(row.install_state, "failed");
});
