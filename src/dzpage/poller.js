import { existsSync } from "node:fs";
import { join } from "node:path";
import { DzpageClient } from "./client.js";
import { registerServerWithDzpage } from "./servers.js";
import { getSetting, KEYS } from "../store/settings.js";
import { checkServerInput, countServers, createServer, findPortConflict, getServer, serverDir } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import { isRejection, markKeyRejected } from "./keystate.js";
import { runtimeFor } from "../runtime/index.js";
import { steamProgress, updateGameFiles } from "../servers/install.js";
import { writeServerFiles } from "../servers/config.js";
import { removeServer } from "../servers/remove.js";
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
 * Zielserver gehoert zu diesem Panel, jedes Feld einer Nutzlast geht durch
 * dieselbe Pruefung wie das Formular im Panel, und alles landet im
 * Ereignisprotokoll.
 */

const WAIT_SECONDS = 25;
/** Etwas mehr als die Wartezeit der Gegenseite, damit sie normal antworten kann. */
const REQUEST_TIMEOUT_MS = (WAIT_SECONDS + 15) * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
export const JOB_KINDS = new Set(["start", "stop", "restart", "update", "create", "delete", "logs", "register"]);
const JOB_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Wie oft der Fortschritt einer Installation hinausgeht, und wann spaetestens
 * wieder. Die Tests verkuerzen den Takt, ihre Installation dauert Sekunden.
 */
const PROGRESS_INTERVAL_MS = Number(process.env.DZPAGE_PANEL_PROGRESS_MS) || 5_000;
const KEEPALIVE_MS = 60_000;
/** So lange wartet ein Auftrag hoechstens, bis ein anderer Vorgang im Panel durch ist. */
const WAIT_FOR_SLOT_MS = 4 * 60 * 60 * 1000;

/** Felder, die ein Auftrag "create" mitbringen darf, und nur diese. */
const CREATE_FIELDS = [
  "name",
  "gamePort",
  "queryPort",
  "rconPort",
  "rconPassword",
  "maxPlayers",
  "mission",
  "memoryMaxMb",
  "cpuQuota",
];
/** Mehr Server legt dzpage.com auf einer Maschine nicht an; von Hand im Panel geht es weiter. */
export const MAX_REMOTE_SERVERS = 20;

const LOG_LINES_DEFAULT = 200;
const LOG_LINES_MAX = 500;
const LOG_BYTES_MAX = 48 * 1024;

/** Ein Fehler, den dzpage.com an seinem Code erkennt und in der Sprache des Nutzers zeigt. */
class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Die Nutzlast von "create" in genau die Felder des Formulars uebersetzen.
 * Nur Zeichenketten und Zahlen: Ein Feld als Liste oder Objekt kaeme sonst
 * ueber String() und Number() verwandelt durch die Pruefung.
 */
export function createInputFrom(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobError("payload", "Der Auftrag enthält keine Serverangaben.");
  }
  const input = {};
  for (const field of CREATE_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
      throw new JobError("payload", `Das Feld ${field} hat ein ungültiges Format.`);
    }
    input[field] = String(value);
  }
  return input;
}

/** Die letzten Zeilen, aber nie mehr als LOG_BYTES_MAX: dzpage.com nimmt nicht beliebig viel an. */
export function tailText(text, maxBytes = LOG_BYTES_MAX) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const lines = value.split("\n");
  const kept = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (size + bytes > maxBytes) break;
    kept.unshift(lines[index]);
    size += bytes;
  }
  // Schon die letzte Zeile allein ist zu lang: dann wenigstens ihr Ende,
  // statt ein leeres Protokoll zu melden.
  if (kept.length === 0) return Buffer.from(lines.at(-1) ?? "", "utf8").subarray(-maxBytes).toString("utf8");
  return kept.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createPoller(app) {
  let stopped = true;
  let timer = null;
  let backoffMs = 0;
  let inFlight = null;
  /** Zaehlt die Starts, damit ein alter Durchlauf einen neuen nicht anhaelt. */
  let generation = 0;
  /** Letzter Auftrag je Server; der naechste haengt sich dahinter. */
  const queues = new Map();

  function client() {
    return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
  }

  /**
   * Zwischenstand an DZPage: "laeuft", dazu bei Installationen die letzte
   * Zeile von SteamCMD und der Prozentwert. Unveraendertes geht nur als
   * Lebenszeichen einmal je Minute hinaus, sonst laeuft der Auftrag auf
   * dzpage.com nach einer Weile ab.
   */
  function progressFor(panelId, jobId) {
    let lastKey = null;
    let lastAt = 0;
    return async ({ text = null, percent = null } = {}) => {
      const key = `${text}|${percent}`;
      if (key === lastKey && Date.now() - lastAt < KEEPALIVE_MS) return;
      lastKey = key;
      lastAt = Date.now();
      const body = { panelId, jobId, status: "running" };
      if (text) body.progress = String(text).slice(0, 200);
      if (Number.isFinite(percent)) body.percent = percent;
      await client()
        .post("/api/panel/v1/poll", body)
        .catch(() => undefined);
    };
  }

  /**
   * Einen Vorgang starten, sobald keiner mehr laeuft. Das Panel fuehrt immer
   * nur einen zur Zeit aus (zwei SteamCMD-Laeufe kaemen sich ins Gehege); ein
   * Auftrag von dzpage.com soll dann warten, statt mit "beschaeftigt"
   * abzubrechen.
   */
  async function startWhenFree(kind, run, progress) {
    const deadline = Date.now() + WAIT_FOR_SLOT_MS;
    for (;;) {
      const started = app.jobs.start(kind, run);
      if (started.ok) return started.job;
      if (Date.now() > deadline) throw new JobError("busy", "Im Panel läuft schon zu lange ein anderer Vorgang.");
      await progress({ text: "Wartet, bis ein anderer Vorgang im Panel fertig ist." });
      await Promise.race([started.job.completion, sleep(KEEPALIVE_MS)]);
    }
  }

  async function handle(job, panelId) {
    if (typeof job?.id !== "string" || !JOB_ID.test(job.id)) {
      log.warn("Auftrag von DZPage ohne gueltige Kennung verworfen.");
      return;
    }
    const started = Date.now();
    const progress = progressFor(panelId, job.id);
    let detail = "";
    let ok = false;
    let result = null;
    let code = null;

    try {
      if (!JOB_KINDS.has(job.kind)) throw new JobError("kind", `Unbekannte Auftragsart: ${job.kind}`);
      await progress();

      if (job.kind === "create") {
        result = await runCreate(job.payload);
        detail = result.registered
          ? `Server ${result.name} angelegt`
          : `Server ${result.name} angelegt, aber nicht bei DZPage angemeldet: ${result.registerError}`;
      } else {
        const server = await getServer(app.db, job.serverId);
        if (!server) throw new JobError("unknown_server", "Der Auftrag nennt einen Server, den dieses Panel nicht kennt.");
        result = await runForServer(job, server, progress);
        detail = `${job.kind} ausgeführt (${Math.round((Date.now() - started) / 1000)} s)`;
      }
      ok = true;
    } catch (err) {
      detail = err.message.slice(0, 400);
      code = err.code ?? null;
      log.warn(`Auftrag ${job.kind} von DZPage fehlgeschlagen: ${detail}`);
    }

    await recordEvent(app.db, {
      kind: `dzpage.${JOB_KINDS.has(job.kind) ? job.kind : "unknown"}`,
      source: "dzpage",
      message: ok ? `Auftrag ${job.kind} von DZPage ausgeführt` : `Auftrag ${job.kind} von DZPage: ${detail}`,
    }).catch(() => undefined);

    const body = { panelId, jobId: job.id, status: ok ? "done" : "failed", detail };
    if (ok && result?.payload !== undefined) body.result = result.payload;
    if (!ok && code) body.code = code;
    await client()
      .post("/api/panel/v1/poll", body)
      .catch(() => undefined);
    app.reporter?.nudge();
  }

  async function runForServer(job, server, progress) {
    const runtime = runtimeFor(server);
    const launches = job.kind === "start" || job.kind === "restart";
    // Ohne Spieldateien wuerde systemd den Start annehmen und DayZ sofort
    // wieder aussteigen: DZPage bekaeme "ausgefuehrt" fuer etwas, das nie lief.
    // Gefragt wird die Platte, nicht der Vermerk: Ein Server, der aus 0.3.x
    // noch auf "fehlgeschlagen" steht, hat seine Dateien meist trotzdem.
    if (launches && server.install_state === "installing") {
      throw new JobError("installing", "Die Spieldateien werden gerade installiert. Danach erneut starten.");
    }
    if (launches && !existsSync(join(serverDir(server.id), "game", "DayZServer"))) {
      throw new JobError("not_installed", "Die Spieldateien sind nicht installiert. Erst installieren, dann starten.");
    }
    // Wie in der Oberflaeche: vor dem Starten einrichten. Ein Neustart aus
    // der Ferne ist genau der Moment, in dem niemand danebensteht und
    // nachhelfen kann.
    if (launches) await runtime.prepare(server);

    switch (job.kind) {
      case "start":
        await runtime.start(server);
        return null;
      case "stop":
        await runtime.stop(server);
        return null;
      case "restart":
        await runtime.restart(server);
        return null;
      case "update":
        await runUpdate(server, progress);
        return null;
      case "delete":
        await runDelete(server, progress);
        return null;
      case "logs":
        return { payload: await readLogs(server, job.payload) };
      case "register": {
        const registered = await registerServerWithDzpage(app, server);
        if (!registered.ok) throw new JobError("register", registered.message);
        return { payload: { rconServerId: registered.serverId } };
      }
      default:
        throw new JobError("kind", `Unbekannte Auftragsart: ${job.kind}`);
    }
  }

  /**
   * Server anlegen wie mit dem Formular im Panel, mit derselben Pruefung, und
   * gleich bei DZPage anmelden: Dort hat ihn der Mensch ja gerade bestellt.
   */
  async function runCreate(payload) {
    const checked = checkServerInput(createInputFrom(payload));
    if (!checked.ok) throw new JobError(checked.code, `Ungültige Angabe (${checked.code}).`);
    if ((await countServers(app.db)) >= MAX_REMOTE_SERVERS) {
      throw new JobError("too_many", `Von dzpage.com aus legt das Panel höchstens ${MAX_REMOTE_SERVERS} Server an.`);
    }
    const conflict = await findPortConflict(app.db, checked.value);
    if (conflict) throw new JobError("port_taken", `Ein Port ist schon vom Server ${conflict.id} belegt.`);

    const server = await createServer(app.db, checked.value, app.config.secrets.encryption);
    writeServerFiles(server, checked.value.password);
    await recordEvent(app.db, { kind: "server.create", source: "dzpage", message: `Server ${server.name} angelegt` });
    log.info(`Server ${server.id} auf Auftrag von DZPage angelegt`);

    const registered = await registerServerWithDzpage(app, server).catch((err) => ({ ok: false, message: err.message }));
    return {
      name: server.name,
      registered: registered.ok,
      registerError: registered.ok ? null : registered.message,
      payload: { serverId: server.id, rconServerId: registered.ok ? registered.serverId : null },
    };
  }

  /**
   * Aktualisierung laeuft als Vorgang, damit die Oberflaeche sie mitliest.
   * Anhalten und Wiederanlaufen eines laufenden Servers macht updateGameFiles,
   * genau wie bei der Schaltflaeche im Panel.
   */
  async function runUpdate(server, progress) {
    let gone = false;
    const appJob = await startWhenFree(
      "server-install",
      async (job) => {
        job.serverId = server.id;
        // Frisch lesen: Waehrend des Wartens kann der Server geaendert oder
        // geloescht worden sein. Fuer einen geloeschten wuerde die Installation
        // Verzeichnis und Unit eines Servers anlegen, den es nicht mehr gibt.
        const fresh = await getServer(app.db, server.id);
        if (!fresh) {
          gone = true;
          throw new Error("Der Server wurde inzwischen gelöscht.");
        }
        await updateGameFiles(app, fresh, job);
        return { serverId: server.id };
      },
      progress,
    );

    const ticker = setInterval(() => void progress(steamProgress(appJob.lines)), PROGRESS_INTERVAL_MS);
    ticker.unref?.();
    let finished;
    try {
      finished = await appJob.completion;
    } finally {
      clearInterval(ticker);
    }
    if (gone) throw new JobError("unknown_server", finished.error);
    if (finished.status !== "ok") throw new JobError("install", finished.error || "Aktualisierung fehlgeschlagen.");
  }

  /** Loeschen ebenfalls als Vorgang: So kann keine Installation gleichzeitig in das Verzeichnis schreiben. */
  async function runDelete(server, progress) {
    const appJob = await startWhenFree(
      "server-delete",
      async () => {
        const fresh = await getServer(app.db, server.id);
        if (fresh) await removeServer(app, fresh);
        return { serverId: server.id };
      },
      progress,
    );
    const finished = await appJob.completion;
    if (finished.status !== "ok") throw new JobError("delete", finished.error || "Löschen fehlgeschlagen.");
  }

  async function readLogs(server, payload) {
    const requested = payload && typeof payload === "object" ? payload.lines : undefined;
    let lines = LOG_LINES_DEFAULT;
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested < 1 || requested > LOG_LINES_MAX) {
        throw new JobError("payload", `Zeilenzahl muss zwischen 1 und ${LOG_LINES_MAX} liegen.`);
      }
      lines = requested;
    }
    const text = await runtimeFor(server).logs(server, lines);
    return tailText(text);
  }

  async function round() {
    timer = null;
    if (stopped) return;
    const run = generation;

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
      if (isRejection(result.code)) {
        log.error(`DZPage lehnt den Panel-Schluessel ab (${result.code}). Abholer angehalten.`);
        try {
          await markKeyRejected(app.db, result.code);
        } finally {
          // Mit neuem Schluessel neu gestartet: der neue Durchlauf bleibt.
          if (generation === run) stop();
        }
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
    // Neue Server haben noch keine Kennung und reihen sich gemeinsam ein, damit
    // zwei gleichzeitig bestellte nicht um dieselben Ports wetteifern.
    for (const job of jobs) {
      const key = job?.kind === "create" ? "create" : typeof job?.serverId === "string" ? job.serverId : "";
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
      generation += 1;
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
