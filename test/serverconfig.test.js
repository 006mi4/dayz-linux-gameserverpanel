import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub } from "../test-support/helper.js";

/**
 * Die serverDZ.cfg im Panel bearbeiten.
 *
 * Der Punkt, an dem diese Sache steht oder faellt: Die Werte muessen die
 * naechste Installation ueberleben. Deshalb liegen sie in der Datenbank, und
 * deshalb prueft der letzte Test, dass ein erneutes Schreiben der Dateien sie
 * nicht wieder auf den Auslieferungszustand zurueckdreht.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_HELPER = join(FIXTURES, "fake-helper.sh");

const env = prepareEnv("serverconfig");
process.on("exit", () => env.cleanup());
chmodSync(FAKE_HELPER, 0o755);
process.env.DZPAGE_PANEL_HELPER = FAKE_HELPER;
process.env.DZPANEL_FAKE_STATE = join(env.root, "fake-helper");

const { checkCfgEntry, defaultConfig, formatCfgValue, parseCfg, serverConfig, serverDzCfg, writeServerFiles } =
  await import("../src/servers/config.js");
const { serverDir } = await import("../src/store/servers.js");

const stub = await startDzpageStub();
process.env.DZPAGE_BASE_URL = stub.url;
const panel = await launchPanel();
const client = new Client(panel.url);

test.after(async () => {
  panel.app.poller.stop();
  panel.app.updateWatcher.stop();
  panel.app.panelUpdateWatcher.stop();
  await panel.stop();
  await stub.stop();
});

/* ---------------------------------------------------------- Werte schreiben */

test("Zahlen bleiben nackt, Zeichenketten bekommen Anführungszeichen", () => {
  assert.equal(formatCfgValue("5"), "5");
  assert.equal(formatCfgValue("-2.5"), "-2.5");
  assert.equal(formatCfgValue("SystemTime"), '"SystemTime"');
  assert.equal(formatCfgValue(""), '""');
  // Wer die Schreibweise schon selbst mitbringt, bekommt sie nicht doppelt.
  assert.equal(formatCfgValue('{"Zeile 1","Zeile 2"}'), '{"Zeile 1","Zeile 2"}');
  assert.equal(formatCfgValue('"schon fertig"'), '"schon fertig"');
  // Ein Zeilenumbruch wuerde die Datei zerlegen.
  assert.equal(formatCfgValue("erste\nzweite"), '"erste zweite"');
});

test("Schlüssel werden geprüft, bevor sie in die Datei kommen", () => {
  assert.equal(checkCfgEntry("respawnTime", "5").ok, true);
  assert.equal(checkCfgEntry("motd[]", '{"a"}').ok, true);
  assert.equal(checkCfgEntry("", "5").code, "cfg_key_empty");
  assert.equal(checkCfgEntry("respawn Time", "5").code, "cfg_key_invalid");
  assert.equal(checkCfgEntry("class Missions", "x").code, "cfg_key_invalid");
  // Was das Panel selbst setzt, darf nicht doppelt in der Datei stehen.
  assert.equal(checkCfgEntry("hostname", "x").code, "cfg_key_managed");
  assert.equal(checkCfgEntry("maxPlayers", "10").code, "cfg_key_managed");
});

test("Ohne gespeicherte Konfiguration gilt der Auslieferungszustand", () => {
  const server = { name: "Test", max_players: 60, query_port: 27016, mission: "dayzOffline.chernarusplus" };
  assert.deepEqual(serverConfig(server), defaultConfig(server));
  // Die Warteschlange richtet sich nach der Spielerzahl.
  const big = defaultConfig({ max_players: 120 });
  assert.equal(big.find(([key]) => key === "loginQueueMaxPlayers")[1], "120");
  assert.equal(defaultConfig({ max_players: 20 }).find(([key]) => key === "loginQueueMaxPlayers")[1], "50");
});

test("Kaputtes JSON macht keinen Server unstartbar", () => {
  const base = { name: "Test", max_players: 60, query_port: 27016, mission: "dayzOffline.chernarusplus" };
  assert.deepEqual(serverConfig({ ...base, config_json: "{kaputt" }), defaultConfig(base));
  assert.deepEqual(serverConfig({ ...base, config_json: '{"kein":"array"}' }), defaultConfig(base));
  // Eine leere Liste ist dagegen eine Ansage und bleibt leer.
  assert.deepEqual(serverConfig({ ...base, config_json: "[]" }), []);
  // Ein Schluessel, den das Panel selbst setzt, wird ausgesiebt.
  assert.deepEqual(serverConfig({ ...base, config_json: '[["hostname","fremd"],["respawnTime","9"]]' }), [
    ["respawnTime", "9"],
  ]);
});

test("Eine von Hand angepasste Datei geht nicht verloren", () => {
  // Wer vor dieser Fassung in der Datei etwas geaendert hat, soll seine Werte
  // im Panel wiederfinden — nicht beim ersten Speichern verlieren.
  const text = `// Von dzpage-panel erzeugt.
hostname = "Alt";
maxPlayers = 60;
steamQueryPort = 27016;
respawnTime = 30;
disable3rdPerson = 1;
motd[] = {"Von Hand","Zweite Zeile"};
class Missions
{
    class DayZ
    {
        template = "dayzOffline.chernarusplus";
    };
};
`;
  const entries = parseCfg(text);
  // Was das Panel selbst setzt und was im Block steht, gehoert nicht dazu.
  assert.deepEqual(entries.map(([key]) => key), ["respawnTime", "disable3rdPerson", "motd[]"]);
  assert.equal(entries[2][1], '{"Von Hand","Zweite Zeile"}');

  // Und die Werte kommen unveraendert wieder heraus.
  const again = serverDzCfg({
    name: "Alt",
    max_players: 60,
    query_port: 27016,
    mission: "dayzOffline.chernarusplus",
    config_json: JSON.stringify(entries),
  });
  assert.match(again, /respawnTime = 30;/);
  assert.match(again, /motd\[\] = \{"Von Hand","Zweite Zeile"\};/);
  assert.equal(parseCfg("").length, 0);
});

test("Die Datei enthält die Werte des Panels und die des Kunden", () => {
  const server = {
    name: 'Mein "Server"',
    max_players: 40,
    query_port: 27016,
    mission: "dayzOffline.enoch",
    config_json: '[["respawnTime","9"],["motd[]","{\\"Hallo\\"}"]]',
  };
  const text = serverDzCfg(server);
  assert.match(text, /hostname = "Mein Server";/, "Anführungszeichen im Namen würden die Datei zerlegen");
  assert.match(text, /maxPlayers = 40;/);
  assert.match(text, /steamQueryPort = 27016;/);
  assert.match(text, /respawnTime = 9;/);
  assert.match(text, /motd\[\] = \{"Hallo"\};/);
  assert.match(text, /template = "dayzOffline\.enoch";/);
});

/* -------------------------------------------------------- Über die Oberfläche */

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

let serverId = null;
const cfgFile = () => readFileSync(join(serverDir(serverId), "serverDZ.cfg"), "utf8");

test("Die Seite zeigt die Werte und die Vorschau", async () => {
  await completeSetup();
  await client.get("/servers/new");
  await client.submit("/servers/new", {
    name: "Konfigserver",
    gamePort: "2302",
    queryPort: "27016",
    rconPort: "2306",
    rconPassword: "rcon-geheim-1",
    maxPlayers: "40",
    mission: "dayzOffline.chernarusplus",
    memoryMaxMb: "4096",
    cpuQuota: "200",
  });
  serverId = client.lastLocation.split("=")[1];

  await client.get(`/server/config?id=${serverId}`);
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /serverDZ\.cfg/);
  assert.match(client.lastBody, /respawnTime/);
  assert.match(client.lastBody, /hostname = &quot;Konfigserver&quot;/, "die Vorschau zeigt die echte Zeile");

  await client.get("/server/config?id=gibtesnicht");
  assert.equal(client.lastStatus, 404);
});

test("Einen Wert ändern, einen neuen hinzufügen, einen entfernen", async () => {
  await client.get(`/server/config?id=${serverId}`);
  const entries = defaultConfig({ max_players: 40 });
  const fields = { action: "entries", id: serverId };
  entries.forEach(([key, value], index) => {
    fields[`k_${index}`] = key;
    fields[`v_${index}`] = key === "disable3rdPerson" ? "1" : value;
  });
  // Den Auslieferungswert storageAutoFix entfernen und motd[] ergaenzen.
  fields[`del_${entries.findIndex(([key]) => key === "storageAutoFix")}`] = "1";
  fields.newKey = "motd[]";
  fields.newValue = '{"Willkommen","Regeln lesen"}';

  await client.submit("/server/config", fields);
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /next restart/);

  const text = cfgFile();
  assert.match(text, /disable3rdPerson = 1;/, "der geänderte Wert steht in der Datei");
  assert.match(text, /motd\[\] = \{"Willkommen","Regeln lesen"\};/, "der neue Wert auch");
  assert.doesNotMatch(text, /storageAutoFix/, "der entfernte nicht mehr");
});

test("Doppelte, fremde und unbrauchbare Schlüssel werden abgewiesen", async () => {
  const before = cfgFile();

  await client.get(`/server/config?id=${serverId}`);
  await client.submit("/server/config", { action: "entries", id: serverId, newKey: "respawnTime", newValue: "3" });
  assert.match(client.lastBody, /appears twice/);

  await client.get(`/server/config?id=${serverId}`);
  await client.submit("/server/config", { action: "entries", id: serverId, newKey: "hostname", newValue: "x" });
  assert.match(client.lastBody, /set by the panel/);

  await client.get(`/server/config?id=${serverId}`);
  await client.submit("/server/config", { action: "entries", id: serverId, newKey: "rm -rf", newValue: "x" });
  assert.match(client.lastBody, /not a valid key/);

  assert.equal(cfgFile(), before, "eine abgewiesene Eingabe darf die Datei nicht anfassen");
});

test("Grundwerte lassen sich nachträglich ändern", async () => {
  await client.get(`/server/config?id=${serverId}`);
  await client.submit("/server/config", {
    action: "basics",
    id: serverId,
    name: "Umbenannt",
    maxPlayers: "80",
    mission: "dayzOffline.enoch",
  });
  assert.equal(client.lastStatus, 200);

  const row = await panel.app.db.get("SELECT name, max_players, mission FROM servers WHERE id = ?", [serverId]);
  assert.equal(row.name, "Umbenannt");
  assert.equal(Number(row.max_players), 80);
  assert.equal(row.mission, "dayzOffline.enoch");

  const text = cfgFile();
  assert.match(text, /hostname = "Umbenannt";/);
  assert.match(text, /maxPlayers = 80;/);
  assert.match(text, /template = "dayzOffline\.enoch";/);

  // Ein unbrauchbarer Wert aendert nichts.
  await client.get(`/server/config?id=${serverId}`);
  await client.submit("/server/config", {
    action: "basics",
    id: serverId,
    name: "Umbenannt",
    maxPlayers: "9000",
    mission: "dayzOffline.enoch",
  });
  const again = await panel.app.db.get("SELECT max_players FROM servers WHERE id = ?", [serverId]);
  assert.equal(Number(again.max_players), 80);
});

test("Die Werte überleben ein erneutes Schreiben der Dateien", async () => {
  // Genau das passiert bei jeder Installation und bei jedem DayZ-Update: Die
  // Datei wird neu geschrieben. Stuende die Konfiguration nur in der Datei,
  // waere sie an dieser Stelle weg.
  const server = await panel.app.db.get("SELECT * FROM servers WHERE id = ?", [serverId]);
  writeServerFiles(server, "rcon-geheim-1");

  const text = cfgFile();
  assert.match(text, /disable3rdPerson = 1;/);
  assert.match(text, /motd\[\] = \{"Willkommen","Regeln lesen"\};/);
  assert.doesNotMatch(text, /storageAutoFix/);
});

test("Zurück auf den Auslieferungszustand", async () => {
  await client.get(`/server/config?id=${serverId}`);
  await client.submit("/server/config", { action: "defaults", id: serverId });
  assert.equal(client.lastStatus, 200);

  const text = cfgFile();
  assert.match(text, /storageAutoFix = 1;/);
  assert.match(text, /disable3rdPerson = 0;/);
  assert.doesNotMatch(text, /motd/);
});
