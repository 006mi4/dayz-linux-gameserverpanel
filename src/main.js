import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { createApp } from "./app.js";
import { createHttpServer } from "./http/server.js";
import { createJobs } from "./jobs.js";
import { createThrottle } from "./auth/throttle.js";
import { createHeartbeat } from "./dzpage/heartbeat.js";
import { createPoller } from "./dzpage/poller.js";
import { purgeExpiredSessions } from "./store/sessions.js";
import { trimEvents } from "./store/events.js";
import { DATA_DIR } from "./paths.js";
import { PANEL_VERSION } from "./version.js";
import { log } from "./log.js";

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
  app.heartbeat = createHeartbeat(app);
  app.poller = createPoller(app);

  if (db) {
    await purgeExpiredSessions(db).catch((err) => log.warn(`Sitzungen aufräumen: ${err.message}`));
    await trimEvents(db).catch((err) => log.warn(`Ereignisse aufräumen: ${err.message}`));
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
  if (!config.database) log.info(`Einrichtung offen — Assistent unter ${url}/setup`);

  app.heartbeat.start();
  app.poller.start();

  return {
    app,
    server,
    url,
    port: actual.port,
    async stop() {
      app.heartbeat.stop();
      app.poller.stop();
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
