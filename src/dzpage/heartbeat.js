import { DzpageClient } from "./client.js";
import { getSetting, KEYS, setSetting } from "../store/settings.js";
import { countServers } from "../store/servers.js";
import { clearKeyRejected, isRejection, markKeyRejected } from "./keystate.js";
import { reregisterServersOnce } from "./servers.js";
import { log } from "../log.js";

/**
 * Lebenszeichen an DZPage. Ein Zeitgeber, keine Warteschlange: DZPage sagt in
 * seiner Antwort, wie oft es gerufen werden will, und das Panel haelt sich
 * daran.
 *
 * Bei Netzfehlern wird der Abstand verdoppelt (bis 15 Minuten) — ein Panel auf
 * einer Leitung, die gerade weg ist, darf nicht im Sekundentakt klopfen.
 *
 * Nach jedem gelungenen Herzschlag geht der Zustandsbericht hinaus (report.js).
 */

const DEFAULT_INTERVAL_S = 60;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export function createHeartbeat(app) {
  let timer = null;
  let stopped = true;
  let backoffMs = 0;
  /** Zaehlt die Starts, damit ein alter Durchlauf einen neuen nicht anhaelt. */
  let generation = 0;

  function client() {
    return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    const run = generation;
    try {
      const panelId = await getSetting(app.db, KEYS.dzpagePanelId);
      if (!panelId) {
        stop();
        return;
      }
      const serverCount = await countServers(app.db).catch(() => 0);
      const result = await client().heartbeat({ panelId, serverCount });

      if (result.ok) {
        backoffMs = 0;
        await setSetting(app.db, KEYS.dzpageLastSeenAt, Date.now());
        await clearKeyRejected(app.db);
        if (result.heartbeatSeconds) {
          await setSetting(app.db, KEYS.dzpageHeartbeatSeconds, result.heartbeatSeconds);
        }
        // Mit jedem Herzschlag der Zustand der Server: Speicher und Laufzeit
        // aendern sich ohne Anlass, und ein abgestuerzter Server meldet sich
        // nicht von selbst.
        await app.reporter?.report({ force: true });
        // Einmal nach dem Update: angemeldete Server ueber IPv4 neu anmelden,
        // damit DZPage fuer RCon die richtige Adresse hat. Nicht abwarten: Bei
        // langsamer Leitung soll der Takt des Herzschlags nicht daran haengen.
        reregisterServersOnce(app).catch((err) => log.warn(`Neuanmeldung der Server: ${err.message}`));
      } else if (result.code === "unknown_panel") {
        // DZPage kennt diese Panel-ID nicht mehr — neu anmelden statt aufgeben.
        log.warn("DZPage kennt dieses Panel nicht mehr, melde neu an.");
        const again = await client().register({ name: app.config.dzpage.panelName || "Panel" });
        if (again.ok) {
          await setSetting(app.db, KEYS.dzpagePanelId, again.panelId);
          await setSetting(app.db, KEYS.dzpageAccount, again.account ?? "");
        } else if (isRejection(again.code)) {
          await rejected(again.code, run);
          return;
        } else {
          backoffMs = Math.min(Math.max(backoffMs * 2, 60_000), MAX_BACKOFF_MS);
        }
      } else if (isRejection(result.code)) {
        await rejected(result.code, run);
        return;
      } else {
        backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), MAX_BACKOFF_MS);
        log.debug(`Herzschlag fehlgeschlagen (${result.code})`);
      }
    } catch (err) {
      backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), MAX_BACKOFF_MS);
      log.warn(`Herzschlag abgebrochen: ${err.message}`);
    }
    schedule();
  }

  /**
   * Ein widerrufener Schluessel wird nicht wieder gueltig: anhalten, bis "link"
   * einen neuen bringt. Wurde inzwischen mit einem neuen Schluessel neu
   * gestartet, laeuft der neue Durchlauf weiter.
   */
  async function rejected(code, run) {
    log.error(`DZPage lehnt den Panel-Schluessel ab (${code}). Herzschlag angehalten.`);
    try {
      await markKeyRejected(app.db, code);
    } finally {
      if (generation === run) stop();
    }
  }

  async function schedule() {
    if (stopped || timer) return;
    let seconds = DEFAULT_INTERVAL_S;
    try {
      const stored = Number(await getSetting(app.db, KEYS.dzpageHeartbeatSeconds));
      if (Number.isFinite(stored) && stored >= 10) seconds = stored;
    } catch {
      /* Datenbank noch nicht da — Standard genuegt */
    }
    const delay = backoffMs || seconds * 1000;
    timer = setTimeout(tick, delay);
    // Der HTTP-Server haelt den Prozess am Leben; dieser Zeitgeber soll das
    // Beenden nicht verzoegern.
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    /** Erster Herzschlag nach kurzer Verzoegerung, damit der Start nicht daran haengt. */
    start({ immediate = false } = {}) {
      if (!app.db || !app.config.dzpage.key) return;
      generation += 1;
      stopped = false;
      backoffMs = 0;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, immediate ? 0 : 5_000);
      timer.unref?.();
    },
    restart(options) {
      stop();
      this.start(options);
    },
    stop,
    get running() {
      return !stopped;
    },
  };
}
