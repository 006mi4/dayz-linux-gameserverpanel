import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { createApp } from "./app.js";
import { createHttpServer } from "./http/server.js";
import { createJobs } from "./jobs.js";
import { createThrottle } from "./auth/throttle.js";
import { createHeartbeat } from "./dzpage/heartbeat.js";
import { createPoller } from "./dzpage/poller.js";
import { createReporter } from "./dzpage/report.js";
import { planReregistration } from "./dzpage/servers.js";
import { createUpdateWatcher } from "./servers/updates.js";
import { announceSelfUpdateResult, createPanelUpdateWatcher, markBootSuccessful } from "./panel/updates.js";
import { purgeExpiredSessions } from "./store/sessions.js";
import { trimEvents } from "./store/events.js";
import { countUsers } from "./store/users.js";
import { ensureSetupCode } from "./auth/setupcode.js";
import { DATA_DIR, SETUP_CODE_FILE } from "./paths.js";
import { PANEL_VERSION } from "./version.js";
import { log } from "./log.js";

async function hasAdministrator(app) {
  if (!app.db) return false;
  try {
    return (await countUsers(app.db)) > 0;
  } catch {
    // Eine eingerichtete, aber kaputte Datenbank ist ein Betriebsfehler und
    // kein Grund, einen Einrichtungscode auszugeben.
    return true;
  }
}

/**
 * Start des Panels. Als Funktion und nicht nur als Skript, damit die Tests
 * denselben Weg nehmen wie der Dienst — ein Test, der eine eigene Verdrahtung
 * baut, prueft die falsche Sache.
 */
export async function startPanel({ port, bind } = {}) {
  const config = loadConfig();
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });

  let db = null;
  if (config.database) {
    try {
      db = await openDatabase(config.database);
    } catch (err) {
      // Kein Absturz: die Oberflaeche soll erklaeren koennen, was fehlt.
      log.error(`Datenbank nicht erreichbar: ${err.message}`);
    }
  }

  const app = createApp({ config, db, jobs: createJobs() });
  app.throttle = createThrottle();
  app.reporter = createReporter(app);
  app.heartbeat = createHeartbeat(app);
  app.poller = createPoller(app);
  app.updateWatcher = createUpdateWatcher(app);
  app.panelUpdateWatcher = createPanelUpdateWatcher(app);

  if (db) {
    await purgeExpiredSessions(db).catch((err) => log.warn(`Sitzungen aufräumen: ${err.message}`));
    await trimEvents(db).catch((err) => log.warn(`Ereignisse aufräumen: ${err.message}`));
    // Kommen wir gerade aus einer Selbstaktualisierung? Dann steht das Ergebnis
    // in einer Datei — im Arbeitsspeicher hat es den Neustart nicht ueberlebt.
    await announceSelfUpdateResult(app).catch((err) => log.warn(`Ergebnis der Aktualisierung: ${err.message}`));
    // Fuer die Kopplung, die jetzt besteht: einmal alle Server ueber IPv4 neu
    // anmelden (dzpage/servers.js). Ausgefuehrt wird das nach dem Herzschlag.
    await planReregistration(app).catch((err) => log.warn(`Neuanmeldung planen: ${err.message}`));
  }

  // Ohne Administrator oeffnet nur der Einrichtungscode den Assistenten. Er
  // entsteht vor dem ersten Lauschen: install.sh wartet auf /health und gibt
  // ihn danach aus, und dann muss er schon dastehen. Ins Protokoll kommt nur,
  // wo er liegt.
  let setupOpen = false;
  if (!app.databaseBroken && !(await hasAdministrator(app))) {
    try {
      ensureSetupCode();
      setupOpen = true;
    } catch (err) {
      log.error(`Einrichtungscode nicht anlegbar (${SETUP_CODE_FILE}): ${err.message}`);
    }
  }

  const server = createHttpServer(app);
  const listenPort = port ?? config.port;
  const listenHost = bind ?? config.bind;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actual = server.address();
  const url = `http://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${actual.port}`;
  log.info(`DZPage Panel ${PANEL_VERSION} hört auf ${url}`);
  if (setupOpen) log.info(`Einrichtung offen: Assistent unter ${url}/setup, Einrichtungscode in ${SETUP_CODE_FILE}`);

  app.reporter.start();
  app.heartbeat.start();
  app.poller.start();
  app.updateWatcher.start();
  app.panelUpdateWatcher.start();

  // Wir stehen: Damit gilt der laufende Stand als brauchbar. Im Container ist
  // das die Marke, auf die der Einstieg zurueckfaellt, wenn eine neue Fassung
  // nicht hochkommt.
  await markBootSuccessful();

  return {
    app,
    server,
    url,
    port: actual.port,
    async stop() {
      app.reporter.stop();
      app.heartbeat.stop();
      app.poller.stop();
      app.updateWatcher.stop();
      app.panelUpdateWatcher.stop();
      await new Promise((resolve) => server.close(resolve));
      await app.db?.close().catch(() => undefined);
    },
  };
}

/** Sauberes Beenden: systemd schickt SIGTERM, ein Mensch am Terminal SIGINT. */
export function installSignalHandlers(panel) {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} erhalten, beende.`);
    await panel.stop().catch((err) => log.warn(`Beim Beenden: ${err.message}`));
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
