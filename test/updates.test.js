import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub, unlockSetup } from "../test-support/helper.js";

/**
 * Die Update-Pruefung: Build-Nummern lesen, vergleichen, einrichten.
 *
 * Die Vorlage `steamcmd-app-info-223350.txt` ist die echte Ausgabe von
 * SteamCMD (anonyme Anmeldung, 2026-08-07). Sie steht hier, weil an ihr die
 * eine Falle haengt, die ein selbstgebauter Text nicht haette: `"buildid"`
 * kommt mehrfach vor — einmal je Zweig. Ein Muster wuerde je nach Reihenfolge
 * mal den oeffentlichen und mal den experimentellen Stand liefern.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_HELPER = join(FIXTURES, "fake-helper.sh");
const FAKE_STEAMCMD = join(FIXTURES, "fake-steamcmd.sh");
const APP_INFO = readFileSync(join(FIXTURES, "steamcmd-app-info-223350.txt"), "utf8");

const env = prepareEnv("updates");
process.on("exit", () => env.cleanup());
chmodSync(FAKE_HELPER, 0o755);
chmodSync(FAKE_STEAMCMD, 0o755);
process.env.DZPAGE_PANEL_HELPER = FAKE_HELPER;
process.env.DZPANEL_FAKE_STATE = join(env.root, "fake-helper");

const { pick, readVdfBlock } = await import("../src/steam/vdf.js");
const { fetchPublicBuild, installedBuildId, publicBranchFrom } = await import("../src/servers/updates.js");
const { updateState } = await import("../src/routes/updates.js");
const { serverDir } = await import("../src/store/servers.js");
const { getSetting, KEYS } = await import("../src/store/settings.js");

const stub = await startDzpageStub();
process.env.DZPAGE_BASE_URL = stub.url;
const panel = await launchPanel();
const client = new Client(panel.url);

test.after(async () => {
  panel.app.poller.stop();
  panel.app.updateWatcher.stop();
  await panel.stop();
  await stub.stop();
});

/* ------------------------------------------------------------ Zahlen lesen */

test("Der öffentliche Zweig wird gelesen, nicht der experimentelle", () => {
  const branch = publicBranchFrom(APP_INFO);
  assert.equal(branch.buildId, "24041098");
  assert.equal(branch.publishedAt, 1784109540 * 1000);

  // Die Falle: dieselbe Zeile steht im selben Text noch einmal.
  const app = readVdfBlock(APP_INFO, "223350");
  assert.equal(pick(app, "depots", "branches", "experimental_public", "buildid"), "3889697");
  assert.equal(pick(app, "common", "name"), "DayZ Server");
});

test("Die Reihenfolge der Zweige ändert nichts", () => {
  // Steht der experimentelle Zweig zuerst, muss trotzdem der oeffentliche
  // herauskommen — ein Muster auf "buildid" wuerde hier danebengreifen.
  const swapped = `"223350"
{
	"depots"
	{
		"branches"
		{
			"experimental_public"
			{
				"buildid"		"3889697"
			}
			"public"
			{
				"buildid"		"99999999"
			}
		}
	}
}`;
  assert.equal(publicBranchFrom(swapped).buildId, "99999999");
});

test("Vorspann und Abspann von SteamCMD stören den Leser nicht", () => {
  const noisy = `Redirecting stderr to '/tmp/x'\nILocalize::AddFile() failed to load "a.txt".\n${APP_INFO}\nUnloading Steam API...OK\n`;
  assert.equal(publicBranchFrom(noisy).buildId, "24041098");
  assert.equal(publicBranchFrom("nichts davon hier"), null);
  assert.equal(publicBranchFrom(""), null);
});

test("Die installierte Nummer kommt aus Steams appmanifest", () => {
  const id = "aabbccdd0011";
  const steamapps = join(serverDir(id), "game", "steamapps");
  assert.equal(installedBuildId(id), null, "ohne Datei gibt es keine Nummer");

  mkdirSync(steamapps, { recursive: true });
  copyFileSync(join(FIXTURES, "appmanifest_223350.acf"), join(steamapps, "appmanifest_223350.acf"));
  assert.equal(installedBuildId(id), "24041098");

  // Eine unbrauchbare Kennung darf keinen Pfad ergeben, sondern null.
  assert.equal(installedBuildId("../../etc"), null);
});

test("Der Vergleich benennt die drei Fälle", () => {
  assert.equal(updateState("24041098", "24041098"), "current");
  assert.equal(updateState("24000000", "24041098"), "outdated");
  assert.equal(updateState(null, "24041098"), "unknown");
  assert.equal(updateState("24041098", null), "unchecked");
});

test("SteamCMD wird anonym gefragt und die Antwort ausgewertet", async () => {
  panel.app.config.steam = { ...panel.app.config.steam, steamcmdPath: FAKE_STEAMCMD };
  const branch = await fetchPublicBuild({ config: panel.app.config });
  assert.equal(branch.buildId, "24041098");
});

/* -------------------------------------------------------- Über die Oberfläche */

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

test("Zeitplan und Verhalten lassen sich über die Oberfläche einrichten", async () => {
  await completeSetup();

  await client.get("/servers/new");
  await client.submit("/servers/new", {
    name: "Updateserver",
    gamePort: "2302",
    queryPort: "27016",
    rconPort: "2306",
    rconPassword: "rcon-geheim-1",
    maxPlayers: "40",
    mission: "dayzOffline.chernarusplus",
    memoryMaxMb: "4096",
    cpuQuota: "200",
  });
  const serverId = client.lastLocation.split("=")[1];

  await client.get("/updates");
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /Updates/);
  assert.match(client.lastBody, /Updateserver/);
  assert.match(client.lastBody, /never/);

  // Zeitplan einschalten
  await client.submit("/updates", { action: "schedule", enabled: "1", interval: "60" });
  assert.equal(client.lastStatus, 200);
  assert.equal(await getSetting(panel.app.db, KEYS.updateCheckEnabled), "1");
  assert.equal(await getSetting(panel.app.db, KEYS.updateCheckInterval), "60");

  // Ein Abstand, den es nicht gibt, faellt auf den Standard zurueck
  await client.get("/updates");
  await client.submit("/updates", { action: "schedule", enabled: "1", interval: "7" });
  assert.equal(await getSetting(panel.app.db, KEYS.updateCheckInterval), "360");

  // Zeitplan wieder aus
  await client.get("/updates");
  await client.submit("/updates", { action: "schedule", interval: "360" });
  assert.equal(await getSetting(panel.app.db, KEYS.updateCheckEnabled), "0");

  // Verhalten je Server
  await client.get("/updates");
  await client.submit("/updates", { action: "modes", [`mode_${serverId}`]: "auto" });
  let server = await panel.app.db.get("SELECT update_mode FROM servers WHERE id = ?", [serverId]);
  assert.equal(server.update_mode, "auto");

  // Ein unbekannter Wert wird nicht uebernommen
  await client.get("/updates");
  await client.submit("/updates", { action: "modes", [`mode_${serverId}`]: "rm-rf" });
  server = await panel.app.db.get("SELECT update_mode FROM servers WHERE id = ?", [serverId]);
  assert.equal(server.update_mode, "auto");
});

test("Die Serverseite zeigt den Stand der Spieldateien", async () => {
  const rows = await panel.app.db.all("SELECT id FROM servers", []);
  const id = rows[0].id;
  const steamapps = join(serverDir(id), "game", "steamapps");
  mkdirSync(steamapps, { recursive: true });
  copyFileSync(join(FIXTURES, "appmanifest_223350.acf"), join(steamapps, "appmanifest_223350.acf"));

  await client.get(`/server?id=${id}`);
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /24041098/);
  assert.match(client.lastBody, /not checked yet/);
});
