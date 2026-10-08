import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub, unlockSetup } from "../test-support/helper.js";

/**
 * Die Aktualisierung des Panels selbst.
 *
 * Der teure Teil — Dateien austauschen und neu starten — laeuft als eigener
 * Prozess ausserhalb des Panels und wird hier durch den Ersatz-Helfer
 * dargestellt. Was diese Datei prueft, ist alles davor: Welche Fassung gilt als
 * die neueste, was passiert bei einer von Hand kopierten Installation, und
 * kommt beim Helfer wirklich die Fassung an, die die Oberflaeche anzeigt.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_HELPER = join(FIXTURES, "fake-helper.sh");

const env = prepareEnv("panel-updates");
process.on("exit", () => env.cleanup());
chmodSync(FAKE_HELPER, 0o755);
process.env.DZPAGE_PANEL_HELPER = FAKE_HELPER;
process.env.DZPANEL_FAKE_STATE = join(env.root, "fake-helper");

/** Standhalter fuer die Etikettenliste von GitHub. */
const tags = { list: [], status: 200 };
const github = createServer((req, res) => {
  if (tags.status !== 200) {
    res.writeHead(tags.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "nope" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(tags.list.map((name) => ({ name }))));
});
await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
process.env.DZPAGE_PANEL_GITHUB_API = `http://127.0.0.1:${github.address().port}`;

// install.json muss stehen, bevor das Panel zum ersten Mal hineinsieht.
mkdirSync(join(env.root, "etc"), { recursive: true });
writeFileSync(
  join(env.root, "etc", "install.json"),
  JSON.stringify({
    method: "git",
    checkout: "/opt/dzpage-panel",
    repository: "https://github.com/006mi4/dayz-linux-gameserverpanel.git",
    args: ["--with-docker"],
    installedAt: "2026-08-07T10:00:00Z",
  }),
);

const {
  applyPanelUpdate,
  compareVersions,
  fetchLatestVersion,
  latestTag,
  parseVersion,
  PANEL_UPDATE_MODES,
} = await import("../src/panel/updates.js");
const { availableRuntimes, canSelfUpdate, defaultRuntime, installation, repositorySlug } = await import(
  "../src/panel/installation.js"
);
const { PANEL_VERSION } = await import("../src/version.js");
const { getSetting, KEYS } = await import("../src/store/settings.js");

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
  await new Promise((resolve) => github.close(resolve));
});

/* ------------------------------------------------------------- Fassungen */

test("Fassungen werden nach Zahlen verglichen, nicht nach Text", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "zehn ist mehr als neun");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.3.0", "0.3.1"), -1);
  assert.equal(compareVersions("kaputt", "1.0.0"), null);
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("v1.2.3"), null, "das v gehoert zum Etikett, nicht zur Fassung");
});

test("Aus der Etikettenliste kommt die hoechste Freigabe", () => {
  assert.equal(
    latestTag([{ name: "v0.9.0" }, { name: "v0.10.0" }, { name: "v0.2.0" }]),
    "0.10.0",
  );
  // Vorabfassungen und Zweigmarken sollen niemandem ungefragt ins Haus fallen.
  assert.equal(latestTag([{ name: "v1.0.0" }, { name: "v1.1.0-rc1" }, { name: "nightly" }]), "1.0.0");
  assert.equal(latestTag([]), null);
  assert.equal(latestTag(null), null);
});

test("Die Adresse aus install.json bestimmt, wo nachgesehen wird", () => {
  assert.equal(repositorySlug(), "006mi4/dayz-linux-gameserverpanel");
  assert.equal(
    repositorySlug({ repository: "git@github.com:jemand/eigener-fork.git" }),
    "jemand/eigener-fork",
    "auch die SSH-Schreibweise muss gehen — ein Fork soll seine eigenen Fassungen bekommen",
  );
  assert.equal(repositorySlug({ repository: "https://example.com/etwas" }), null);
});

test("GitHub-Abfrage: Antwort, Ratenbegrenzung, unbekanntes Projekt", async () => {
  tags.status = 200;
  tags.list = ["v0.2.0", "v0.3.0", "v0.3.1"];
  assert.equal(await fetchLatestVersion({ slug: "006mi4/dayz-linux-gameserverpanel" }), "0.3.1");

  tags.status = 403;
  await assert.rejects(() => fetchLatestVersion({ slug: "x/y" }), /Ratenbegrenzung/);
  tags.status = 404;
  await assert.rejects(() => fetchLatestVersion({ slug: "x/y" }), /Kein Projekt/);
  tags.status = 200;
});

test("Fassung in package.json und version.js stimmen überein", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    pkg.version,
    PANEL_VERSION,
    "Beide Zahlen gehen nach draussen — die Selbstaktualisierung vergleicht gegen das Etikett v<Fassung>.",
  );
});

/* ------------------------------------------------------------ Herkunft */

test("Ohne install.json wird nichts überschrieben", () => {
  const manual = installation({ reload: true, file: join(env.root, "gibt-es-nicht.json") });
  assert.equal(manual.method, "manual");
  assert.equal(canSelfUpdate(manual), false);
  // Zuruecksetzen, sonst sieht der Rest der Datei die falsche Herkunft.
  assert.equal(installation({ reload: true }).method, "git");
});

test("Im Container ist Docker die einzige Laufzeit", () => {
  assert.deepEqual(availableRuntimes({ method: "docker" }), ["docker"]);
  assert.equal(defaultRuntime({ method: "docker" }), "docker");
  assert.deepEqual(availableRuntimes({ method: "git" }), ["systemd", "docker"]);
  assert.equal(defaultRuntime(), "systemd");
});

test("Eine ältere oder gleiche Fassung wird nicht eingespielt", async () => {
  await assert.rejects(() => applyPanelUpdate(panel.app, PANEL_VERSION), /nicht neuer/);
  await assert.rejects(() => applyPanelUpdate(panel.app, "0.0.1"), /nicht neuer/);
  await assert.rejects(() => applyPanelUpdate(panel.app, "kaputt"), /gültige Fassung/);
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

test("Die Seite zeigt die laufende Fassung und die Herkunft", async () => {
  await completeSetup();
  await client.get("/updates");
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /This panel/);
  assert.match(client.lastBody, new RegExp(PANEL_VERSION.replace(/\./g, "\\.")));
  assert.match(client.lastBody, /github\.com\/006mi4\/dayz-linux-gameserverpanel/);
});

test("Das Verhalten bei neuen Fassungen lässt sich einstellen", async () => {
  for (const mode of PANEL_UPDATE_MODES) {
    await client.get("/updates");
    await client.submit("/updates", { action: "panel-mode", panelMode: mode });
    assert.equal(await getSetting(panel.app.db, KEYS.panelUpdateMode), mode);
  }
  // Ein Wert, den es nicht gibt, faellt auf den Standard zurueck.
  await client.get("/updates");
  await client.submit("/updates", { action: "panel-mode", panelMode: "rm-rf" });
  assert.equal(await getSetting(panel.app.db, KEYS.panelUpdateMode), "auto");
});

test("Prüfen meldet eine neue Fassung und bietet sie an", async () => {
  tags.list = ["v0.1.0", `v${PANEL_VERSION}`, "v9.9.9"];
  await client.get("/updates");
  await client.submit("/updates", { action: "panel-check" });
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /9\.9\.9/);
  assert.equal(await getSetting(panel.app.db, KEYS.panelUpdateLatest), "9.9.9");
  assert.match(client.lastBody, /Install 9\.9\.9/, "die Schaltfläche zum Einspielen muss dastehen");
});

test("Einspielen schickt genau diese Fassung an den Helfer", async () => {
  await client.get("/updates");
  await client.submit("/updates", { action: "panel-install" });
  assert.equal(client.lastStatus, 200);
  assert.match(client.lastBody, /restarts in a moment/);

  const calls = readFileSync(join(env.root, "fake-helper", "calls.log"), "utf8");
  assert.match(calls, /self-update v9\.9\.9/);
});

test("Ist nichts Neues da, passiert beim Einspielen nichts", async () => {
  tags.list = [`v${PANEL_VERSION}`];
  await client.get("/updates");
  await client.submit("/updates", { action: "panel-check" });
  assert.match(client.lastBody, /is the latest one/);

  await client.get("/updates");
  await client.submit("/updates", { action: "panel-install" });
  assert.match(client.lastBody, /is the latest one/);
});

test("Eine unerreichbare Gegenstelle wird erklärt, nicht verschluckt", async () => {
  tags.status = 500;
  await client.get("/updates");
  await client.submit("/updates", { action: "panel-check" });
  assert.match(client.lastBody, /The check failed/);
  assert.match((await getSetting(panel.app.db, KEYS.panelUpdateError)) || "", /500/);
  tags.status = 200;
});
