import { DzpageClient } from "./client.js";
import { getSettings, KEYS } from "../store/settings.js";
import { listServers } from "../store/servers.js";
import { runtimeFor } from "../runtime/index.js";
import { installedBuildId } from "../servers/install.js";
import { PANEL_VERSION } from "../version.js";
import { log } from "../log.js";

/**
 * Zustand der Spielserver an DZPage melden, damit dzpage.com zeigt, was hier
 * laeuft: Zustand, seit wann, Speicher, Neustarts, installierte Fassung.
 *
 * Kein Abfrage-Karussell: Gemeldet wird mit jedem Herzschlag und direkt nach
 * allem, was den Zustand aendert (Auftrag, Schaltflaeche). Nur solange ein
 * Server gerade startet oder anhaelt, wird kurz nachgefasst, damit dzpage.com
 * "laeuft" nicht erst eine Minute spaeter erfaehrt.
 *
 * Jeder Bericht ist vollstaendig: Ein Server, der fehlt, ist im Panel geloescht.
 */

/** Was dieses Panel an Auftraegen versteht. DZPage blendet danach Schaltflaechen ein. */
export const CAPABILITIES = ["report", "create", "delete", "logs", "register", "progress"];

const NUDGE_DELAY_MS = 1_000;
const FOLLOW_UP_MS = 10_000;
/** Drei Minuten nachfassen genuegen fuer jeden Start; danach uebernimmt der Herzschlag. */
const MAX_FOLLOW_UPS = 18;
/** Kennt DZPage den Bericht nicht (aelteres dzpage.com), nicht bei jedem Anlass fragen. */
const PAUSE_WHEN_UNSUPPORTED_MS = 30 * 60 * 1000;
const TRANSITIONAL = new Set(["starting", "stopping"]);

/**
 * Startzeit aus systemd ("Thu 2026-10-08 20:00:00 UTC") oder Docker
 * (ISO-Zeitstempel) als Millisekunden. systemd schreibt in der Zeitzone der
 * Maschine; das Panel laeuft auf derselben Maschine, also wird eine andere
 * Zone als UTC in der Ortszeit dieses Prozesses gelesen.
 */
export function parseSince(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text || text === "n/a") return null;

  let ms = null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    ms = Date.parse(text);
  } else {
    const match = text.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: (\S+))?$/);
    if (!match) return null;
    const [, y, mo, d, h, mi, s, zone] = match;
    if (!zone || zone === "UTC" || zone === "GMT") {
      ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    } else {
      ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
    }
  }
  // Docker meldet fuer einen nie gestarteten Container 0001-01-01.
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > now + 24 * 60 * 60 * 1000) return null;
  return ms;
}

/** Der Bericht, so wie er an DZPage geht. */
export async function collectReport(app) {
  const settings = await getSettings(app.db, [KEYS.steamAccount, KEYS.steamLoggedInAt, KEYS.updateAvailableBuild]);
  const servers = [];
  for (const server of await listServers(app.db)) {
    let status = { state: "unknown" };
    try {
      status = await runtimeFor(server).status(server);
    } catch (err) {
      log.debug(`Zustand von ${server.id} fuer den Bericht nicht lesbar: ${err.message}`);
    }
    servers.push({
      id: server.id,
      name: server.name,
      gamePort: Number(server.game_port),
      queryPort: Number(server.query_port),
      rconPort: Number(server.rcon_port),
      maxPlayers: Number(server.max_players),
      mission: server.mission,
      runtime: server.runtime,
      memoryMaxMb: Number(server.memory_max_mb),
      cpuQuota: Number(server.cpu_quota),
      state: status.state || "unknown",
      since: status.state === "running" ? parseSince(status.since) : null,
      memoryBytes: Number.isFinite(status.memoryBytes) && status.memoryBytes > 0 ? status.memoryBytes : null,
      restarts: Number(status.restarts) || 0,
      autostart: Boolean(status.autostart),
      installState: server.install_state,
      installedBuild: installedBuildId(server.id) ?? server.installed_build ?? null,
      registered: Boolean(server.dzpage_server_id),
    });
  }
  return {
    version: PANEL_VERSION,
    capabilities: CAPABILITIES,
    // Nur ob, nie welches Konto: Der Kontoname geht DZPage nichts an.
    steamLogin: Boolean(settings[KEYS.steamAccount] && settings[KEYS.steamLoggedInAt]),
    availableBuild: settings[KEYS.updateAvailableBuild] || null,
    servers,
  };
}

/** Was sich aendern muss, damit ausserhalb des Herzschlags gemeldet wird. Speicher zaehlt nicht. */
function signature(report) {
  return JSON.stringify([
    report.steamLogin,
    report.availableBuild,
    report.servers.map((s) => [
      s.id,
      s.name,
      s.gamePort,
      s.queryPort,
      s.rconPort,
      s.maxPlayers,
      s.mission,
      s.runtime,
      s.state,
      s.restarts,
      s.autostart,
      s.installState,
      s.installedBuild,
      s.registered,
    ]),
  ]);
}

export function createReporter(app) {
  let lastSignature = null;
  let pausedUntil = 0;
  let running = null;
  let again = null;
  let nudgeTimer = null;
  let followTimer = null;
  let followUps = 0;
  let stopped = true;

  function client() {
    return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
  }

  async function send({ force }) {
    const panelId = await getSettingSafe();
    if (!panelId || !app.config.dzpage.key) return { ok: false, code: "not_linked" };
    if (Date.now() < pausedUntil) return { ok: false, code: "paused" };

    const report = await collectReport(app);
    const sig = signature(report);
    if (!force && sig === lastSignature) return { ok: true, unchanged: true, report };

    const result = await client().post("/api/panel/v1/report", { panelId, ...report });
    if (result.ok) {
      lastSignature = sig;
      pausedUntil = 0;
    } else {
      // Schluessel und unbekannte Panel-ID behandelt der Herzschlag, Netzfehler
      // der naechste Anlass. Nur ein dzpage.com ohne diesen Endpunkt bekommt
      // eine Weile Ruhe, statt nach jedem Auftrag gefragt zu werden.
      if (result.code === "not_found") pausedUntil = Date.now() + PAUSE_WHEN_UNSUPPORTED_MS;
      log.debug(`Zustandsbericht nicht angenommen (${result.code})`);
    }
    return { ...result, report };
  }

  async function getSettingSafe() {
    if (!app.db) return null;
    const settings = await getSettings(app.db, [KEYS.dzpagePanelId]);
    return settings[KEYS.dzpagePanelId] || null;
  }

  /** Immer nur ein Bericht unterwegs; wer waehrenddessen fragt, bekommt den naechsten. */
  async function report({ force = false } = {}) {
    if (running) {
      again = { force: Boolean(again?.force) || force };
      return running;
    }
    running = send({ force })
      .catch((err) => {
        log.debug(`Zustandsbericht abgebrochen: ${err.message}`);
        return { ok: false, code: "error" };
      })
      .finally(() => {
        running = null;
      });
    const result = await running;
    if (again) {
      const next = again;
      again = null;
      return report(next);
    }
    if (result.report && result.report.servers.some((s) => TRANSITIONAL.has(s.state))) scheduleFollowUp();
    return result;
  }

  function scheduleFollowUp() {
    if (stopped || followTimer || followUps >= MAX_FOLLOW_UPS) return;
    followUps += 1;
    followTimer = setTimeout(() => {
      followTimer = null;
      void report();
    }, FOLLOW_UP_MS);
    followTimer.unref?.();
  }

  return {
    report,
    /** Etwas hat sich geaendert: gleich melden, kurz gebuendelt. */
    nudge() {
      if (stopped || nudgeTimer) return;
      followUps = 0;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        void report({ force: true });
      }, NUDGE_DELAY_MS);
      nudgeTimer.unref?.();
    },
    start() {
      stopped = false;
      lastSignature = null;
      pausedUntil = 0;
    },
    stop() {
      stopped = true;
      for (const timer of [nudgeTimer, followTimer]) if (timer) clearTimeout(timer);
      nudgeTimer = null;
      followTimer = null;
    },
    /** Nur fuer Tests: wartet den laufenden Bericht ab. */
    async settled() {
      await running;
    },
  };
}
