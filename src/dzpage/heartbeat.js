import { DzpageClient } from "./client.js";
import { getSetting, KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { log } from "../log.js";

/**
 * Lebenszeichen an DZPage. Ein Zeitgeber, keine Warteschlange: DZPage sagt in
 * seiner Antwort, wie oft es gerufen werden will, und das Panel haelt sich
 * daran.
 *
 * Bei Netzfehlern wird der Abstand verdoppelt (bis 15 Minuten) — ein Panel auf
 * einer Leitung, die gerade weg ist, darf nicht im Sekundentakt klopfen.
 */

const DEFAULT_INTERVAL_S = 60;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export function createHeartbeat(app) {
  let timer = null;
  let stopped = true;
  let backoffMs = 0;

  function client() {
    return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    try {
      const panelId = await getSetting(app.db, KEYS.dzpagePanelId);
      if (!panelId) {
        stop();
        return;
      }
      const result = await client().heartbeat({ panelId, serverCount: 0 });

      if (result.ok) {
        backoffMs = 0;
        await setSetting(app.db, KEYS.dzpageLastSeenAt, Date.now());
        if (result.heartbeatSeconds) {
          await setSetting(app.db, KEYS.dzpageHeartbeatSeconds, result.heartbeatSeconds);
        }
      } else if (result.code === "unknown_panel") {
        // DZPage kennt diese Panel-ID nicht mehr — neu anmelden statt aufgeben.
        log.warn("DZPage kennt dieses Panel nicht mehr, melde neu an.");
        const again = await client().register({ name: app.config.dzpage.panelName || "Panel" });
        if (again.ok) {
          await setSetting(app.db, KEYS.dzpagePanelId, again.panelId);
          await setSetting(app.db, KEYS.dzpageAccount, again.account ?? "");
        } else {
          backoffMs = Math.min(Math.max(backoffMs * 2, 60_000), MAX_BACKOFF_MS);
        }
      } else if (result.code === "revoked" || result.code === "invalid_key") {
        log.error(`DZPage lehnt den Panel-Schluessel ab (${result.code}) — Herzschlag angehalten.`);
        await recordEvent(app.db, {
          kind: "dzpage.key",
          source: "dzpage",
          message: `Panel-Schlüssel abgelehnt (${result.code})`,
        });
        stop();
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
