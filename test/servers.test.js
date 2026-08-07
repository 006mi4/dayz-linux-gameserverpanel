import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub } from "../test-support/helper.js";

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

const env = prepareEnv("servers");
process.on("exit", () => env.cleanup());
chmodSync(FAKE_HELPER, 0o755);

process.env.DZPAGE_PANEL_HELPER = FAKE_HELPER;
process.env.DZPAGE_PANEL_SUDO = "";
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

  // Löschen fragt nach und räumt dann auf
  await client.submit("/server/action", { id: serverId, action: "delete" });
  assert.match(client.lastBody, /Delete permanently/);
  await client.submit("/server/action", { id: serverId, action: "delete-confirm" });
  assert.equal(client.lastLocation, "/servers");
  assert.equal(existsSync(serverDir(serverId)), false);
  assert.match(helperCalls().join("\n"), new RegExp(`destroy ${serverId}`));
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

  // Auftrag von DZPage: starten
  stub.queueJob({ id: "job1", kind: "start", serverId });
  panel.app.poller.restart();
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
