import { existsSync } from "node:fs";
import { join } from "node:path";
import { DzpageClient } from "./client.js";
import { getSetting, KEYS } from "../store/settings.js";
import { getServer, serverDir } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import { runtimeFor } from "../runtime/index.js";
import { updateGameFiles } from "../servers/install.js";
import { log } from "../log.js";

/**
 * Der Abholer: haelt eine ausgehende Verbindung zu DZPage offen und fuehrt die
 * Auftraege aus, die von dort kommen.
 *
 * Es gibt bewusst keinen Weg von aussen in diese Maschine. Start, Stopp und
 * Neustart von dzpage.com fuehlen sich trotzdem sofort an, weil die Verbindung
 * schon offen wartet, wenn der Auftrag entsteht.
 *
 * Geprueft wird jeder Auftrag, nicht nur der erste: bekannte Auftragsart,
 * Zielserver gehoert zu diesem Panel, und alles landet im Ereignisprotokoll.
 */

const WAIT_SECONDS = 25;
/** Etwas mehr als die Wartezeit der Gegenseite, damit sie normal antworten kann. */
const REQUEST_TIMEOUT_MS = (WAIT_SECONDS + 15) * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
export const JOB_KINDS = new Set(["start", "stop", "restart", "update"]);

export function createPoller(app) {
  let stopped = true;
  let timer = null;
  let backoffMs = 0;
  let inFlight = null;
  /** Letzter Auftrag je Server; der naechste haengt sich dahinter. */
  const queues = new Map();

  function client() {
    return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
  }

  async function handle(job, panelId) {
    const started = Date.now();
    let detail = "";
    let ok = false;

    try {
      if (!JOB_KINDS.has(job.kind)) throw new Error(`Unbekannte Auftragsart: ${job.kind}`);
      const server = await getServer(app.db, job.serverId);
      if (!server) throw new Error("Der Auftrag nennt einen Server, den dieses Panel nicht kennt.");

      const runtime = runtimeFor(server);
      const launches = job.kind === "start" || job.kind === "restart";
      // Ohne Spieldateien wuerde systemd den Start annehmen und DayZ sofort
      // wieder aussteigen: DZPage bekaeme "ausgefuehrt" fuer etwas, das nie lief.
      // Gefragt wird die Platte, nicht der Vermerk: Ein Server, der aus 0.3.x
      // noch auf "fehlgeschlagen" steht, hat seine Dateien meist trotzdem.
      if (launches && server.install_state === "installing") {
        throw new Error("Die Spieldateien werden gerade installiert. Danach erneut starten.");
      }
      if (launches && !existsSync(join(serverDir(server.id), "game", "DayZServer"))) {
        throw new Error("Die Spieldateien sind nicht installiert. Erst installieren, dann starten.");
      }
      // Wie in der Oberflaeche: vor dem Starten einrichten. Ein Neustart aus
      // der Ferne ist genau der Moment, in dem niemand danebensteht und
      // nachhelfen kann.
      if (launches) await runtime.prepare(server);

      if (job.kind === "start") await runtime.start(server);
      else if (job.kind === "stop") await runtime.stop(server);
      else if (job.kind === "restart") await runtime.restart(server);
      else await runUpdate(server);

      ok = true;
      detail = `${job.kind} ausgeführt (${Math.round((Date.now() - started) / 1000)} s)`;
    } catch (err) {
      detail = err.message.slice(0, 400);
      log.warn(`Auftrag ${job.kind} von DZPage fehlgeschlagen: ${detail}`);
    }

    await recordEvent(app.db, {
      kind: `dzpage.${job.kind}`,
      source: "dzpage",
      message: ok ? `Auftrag ${job.kind} von DZPage ausgeführt` : `Auftrag ${job.kind} von DZPage: ${detail}`,
    }).catch(() => undefined);

    await client()
      .post("/api/panel/v1/poll", { panelId, jobId: job.id, status: ok ? "done" : "failed", detail })
      .catch(() => undefined);
  }

  /**
   * Aktualisierung laeuft als Vorgang, damit die Oberflaeche sie mitliest.
   * Anhalten und Wiederanlaufen eines laufenden Servers macht updateGameFiles,
   * genau wie bei der Schaltflaeche im Panel.
   */
  async function runUpdate(server) {
    const started = app.jobs.start("server-install", async (job) => {
      job.serverId = server.id;
      await updateGameFiles(app, server, job);
      return { serverId: server.id };
    });

    if (!started.ok) throw new Error("Es laeuft schon ein anderer Vorgang.");
    const finished = await started.job.completion;
    if (finished.status !== "ok") throw new Error(finished.error || "Aktualisierung fehlgeschlagen.");
  }

  async function round() {
    timer = null;
    if (stopped) return;

    const panelId = await getSetting(app.db, KEYS.dzpagePanelId);
    if (!panelId || !app.config.dzpage.key) {
      schedule(30_000);
      return;
    }

    const result = await client().request(
      "GET",
      `/api/panel/v1/poll?panelId=${encodeURIComponent(panelId)}&wait=${WAIT_SECONDS}`,
      null,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    if (!result.ok) {
      if (result.code === "revoked" || result.code === "invalid_key") {
        log.error(`DZPage lehnt den Panel-Schluessel ab (${result.code}) — Abholer angehalten.`);
        stop();
        return;
      }
      backoffMs = Math.min(Math.max(backoffMs * 2, 15_000), MAX_BACKOFF_MS);
      log.debug(`Abholen fehlgeschlagen (${result.code})`);
      schedule(backoffMs);
      return;
    }

    backoffMs = 0;
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    if (jobs.length) log.info(`${jobs.length} Auftrag/Auftraege von DZPage erhalten`);
    // Nicht auf die Ausfuehrung warten: der naechste Long-Poll soll sofort
    // wieder offen sein, sonst verpasst das Panel den naechsten Auftrag.
    //
    // Je Server aber der Reihe nach: "stop" und "start" fuer denselben Server
    // gleichzeitig ausgefuehrt, ergaeben einen Zustand, den niemand bestellt hat.
    for (const job of jobs) {
      const key = typeof job?.serverId === "string" ? job.serverId : "";
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous.then(() => handle(job, panelId)).catch(() => undefined);
      queues.set(key, next);
      next.finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    }
    inFlight = Promise.all([...queues.values()]);
    schedule(jobs.length ? 250 : 1_000);
  }

  function schedule(delayMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      void round().catch((err) => {
        log.warn(`Abholer abgebrochen: ${err.message}`);
        schedule(30_000);
      });
    }, delayMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start() {
      if (!app.db || !app.config.dzpage.key) return;
      stopped = false;
      backoffMs = 0;
      schedule(1_000);
    },
    restart() {
      stop();
      this.start();
    },
    stop,
    /** Nur fuer Tests: wartet, bis die laufenden Auftraege durch sind. */
    async settled() {
      await inFlight;
    },
    get running() {
      return !stopped;
    },
  };
}
