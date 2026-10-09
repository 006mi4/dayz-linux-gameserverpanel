import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stripAnsi } from "../steam/pty.js";
import { pick, readVdfBlock } from "../steam/vdf.js";
import { ensureSteamCmd } from "../steam/steamcmd.js";
import { STEAM_INFO_HOME } from "../paths.js";
import { listServers, updateServer } from "../store/servers.js";
import { getNumber, getSetting, KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { DAYZ_SERVER_APP_ID, installedBuildId, updateGameFiles } from "./install.js";
import { log } from "../log.js";

export { installedBuildId };

/**
 * Update-Pruefung: Steht bei Steam eine neuere Fassung des DayZ-Servers als
 * die installierte?
 *
 * Zwei Zahlen werden verglichen, beide aus Steams eigenem Format:
 * - installiert: `buildid` aus `game/steamapps/appmanifest_223350.acf`, die
 *   SteamCMD beim Download selbst schreibt.
 * - verfuegbar: `depots.branches.public.buildid` aus `app_info_print`.
 *
 * Zwei Festlegungen, die den Unterschied machen:
 * - **Anonyme Anmeldung.** Fuer die Auskunft ueber eine oeffentliche App
 *   braucht Steam kein Konto (am echten Client gemessen, 2026-08-07). Damit
 *   funktioniert die Pruefung auch, bevor der Kunde sich bei Steam angemeldet
 *   hat — nur das Herunterladen braucht sein Konto.
 * - **Eigenes HOME** (STEAM_INFO_HOME). Die anonyme Anmeldung fasst damit das
 *   Sitzungstoken des Kundenkontos nicht an.
 *
 * Kein Pseudo-Terminal: Die Abfrage stellt keine Rueckfragen, also reicht ein
 * gewoehnlicher Prozess. Das macht sie unabhaengig von script(1) und vom
 * begrenzten Puffer der Pseudo-Konsole — die Ausgabe ist mehrere Kilobyte lang.
 */

/** off = nichts tun, notify = nur melden, auto = selbst aktualisieren. */
export const UPDATE_MODES = ["off", "notify", "auto"];
export const INTERVAL_CHOICES = [30, 60, 180, 360, 720, 1440];
export const DEFAULT_INTERVAL_MINUTES = 360;

export const UPDATE_JOB_KIND = "update-check";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const BUILD_ID = /^\d{1,20}$/;

/* ------------------------------------------------------------ Build-Nummern */

function asBuildId(value) {
  return BUILD_ID.test(String(value ?? "")) ? String(value) : null;
}

/** Aus der Ausgabe von `app_info_print` den oeffentlichen Zweig herausholen. */
export function publicBranchFrom(output) {
  const app = readVdfBlock(output, String(DAYZ_SERVER_APP_ID));
  const buildId = asBuildId(pick(app, "depots", "branches", "public", "buildid"));
  if (!buildId) return null;
  const seconds = Number(pick(app, "depots", "branches", "public", "timeupdated"));
  return { buildId, publishedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
}

function runSteamCmd(command, args) {
  mkdirSync(STEAM_INFO_HOME, { recursive: true, mode: 0o750 });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { HOME: STEAM_INFO_HOME, PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill("SIGTERM");
        reject(err);
      } else {
        resolve(value);
      }
    };

    const timer = setTimeout(
      () => finish(new Error("SteamCMD hat nicht rechtzeitig geantwortet.")),
      RUN_TIMEOUT_MS,
    );
    timer.unref?.();

    const take = (chunk) => {
      if (output.length >= MAX_OUTPUT_BYTES) return;
      output += stripAnsi(chunk.toString("utf8"));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => finish(err));
    child.on("close", () => finish(null, output));
  });
}

/** Letzte Zeilen mit Inhalt — damit ein Fehler erklaerbar wird. */
function tail(output, lines = 4) {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" · ")
    .slice(0, 300);
}

/** Fragt Steam nach dem Stand des oeffentlichen Zweigs. */
export async function fetchPublicBuild({ config, job = null }) {
  const found = await ensureSteamCmd(config, job);
  job?.append(`Frage Steam nach dem Stand von App ${DAYZ_SERVER_APP_ID}.`);
  const output = await runSteamCmd(found.path, [
    "+login",
    "anonymous",
    "+app_info_update",
    "1",
    "+app_info_print",
    String(DAYZ_SERVER_APP_ID),
    "+quit",
  ]);
  const branch = publicBranchFrom(output);
  if (!branch) {
    throw new Error(`SteamCMD hat keine Build-Nummer geliefert: ${tail(output)}`);
  }
  return branch;
}

/* ------------------------------------------------------------- Die Pruefung */

/**
 * Einmal pruefen. `apply` fuehrt die Aktualisierung fuer die Server aus, die
 * auf "automatisch" stehen — das macht nur der Zeitplan, nie die Schaltflaeche
 * in der Oberflaeche: eine Schaltflaeche mit der Aufschrift "prüfen" darf
 * keinen Server neu starten.
 */
export async function checkUpdates(app, { job = null, apply = false } = {}) {
  const db = app.db;
  let branch;
  try {
    branch = await fetchPublicBuild({ config: app.config, job });
  } catch (err) {
    await setSetting(db, KEYS.updateLastError, err.message.slice(0, 300));
    await setSetting(db, KEYS.updateCheckedAt, Date.now());
    throw err;
  }

  const previous = await getSetting(db, KEYS.updateAvailableBuild);
  await setSetting(db, KEYS.updateAvailableBuild, branch.buildId);
  await setSetting(db, KEYS.updatePublishedAt, branch.publishedAt ?? "");
  await setSetting(db, KEYS.updateCheckedAt, Date.now());
  await setSetting(db, KEYS.updateLastError, "");
  job?.append(`Öffentlicher Zweig: Build ${branch.buildId}.`);

  // Installierte Nummer je Server nachfuehren; sie aendert sich nur beim
  // Herunterladen, aber auch von Hand nachgeholte Aktualisierungen sollen
  // sichtbar werden.
  const servers = await listServers(db);
  const outdated = [];
  for (const server of servers) {
    const installed = installedBuildId(server.id);
    if ((installed ?? null) !== (server.installed_build ?? null)) {
      await updateServer(db, server.id, { installed_build: installed });
    }
    if (server.install_state === "ready" && installed && installed !== branch.buildId) {
      outdated.push({ ...server, installed_build: installed });
    }
  }

  // Ein Ereignis je Steam-Veroeffentlichung, nicht je Pruefung: sonst stuende
  // alle sechs Stunden dieselbe Meldung im Protokoll.
  if (previous !== branch.buildId && outdated.length) {
    await recordEvent(db, {
      kind: "update.available",
      message: `Neue DayZ-Fassung ${branch.buildId}: ${outdated.length} Server ist/sind älter`,
    });
  }

  const updated = [];
  const failed = [];
  if (apply) {
    for (const server of outdated) {
      if (server.update_mode !== "auto") continue;
      try {
        await applyUpdate(app, server, job, branch.buildId);
        updated.push(server.name);
      } catch (err) {
        failed.push(`${server.name}: ${err.message}`);
        log.warn(`Automatische Aktualisierung von ${server.id} fehlgeschlagen: ${err.message}`);
        await recordEvent(db, {
          kind: "update.failed",
          message: `${server.name}: Aktualisierung fehlgeschlagen: ${err.message}`,
        }).catch(() => undefined);
      }
    }
  }

  return { buildId: branch.buildId, outdated: outdated.map((s) => s.id), updated, failed };
}

/** Spieldateien eines Servers erneuern; Anhalten und Wiederanlaufen macht updateGameFiles. */
async function applyUpdate(app, server, job, expectedBuild) {
  job?.append(`${server.name}: aktualisiere auf Build ${expectedBuild}.`);
  const { wasRunning } = await updateGameFiles(app, server, job ?? undefined);

  await recordEvent(app.db, {
    kind: "update.applied",
    message: `${server.name} auf Build ${expectedBuild} aktualisiert${wasRunning ? " und neu gestartet" : ""}`,
  });
}

/** Als Vorgang starten, damit die Oberflaeche mitlesen kann. */
export function startUpdateCheck(app, { apply = false } = {}) {
  return app.jobs.start(UPDATE_JOB_KIND, (job) => checkUpdates(app, { job, apply }));
}

/* -------------------------------------------------------------- Zeitplan */

/**
 * Der Zeitplan. Er sieht jede Minute nach, ob die Pruefung faellig ist —
 * das ist billiger als ein langer Zeitgeber, der einen Neustart des Dienstes
 * nicht ueberlebt, und genau genug fuer Abstaende ab einer halben Stunde.
 */
export function createUpdateWatcher(app) {
  let stopped = true;
  let timer = null;
  const TICK_MS = 60_000;

  async function due() {
    if (!app.db) return false;
    if ((await getSetting(app.db, KEYS.updateCheckEnabled)) !== "1") return false;
    const minutes = (await getNumber(app.db, KEYS.updateCheckInterval)) || DEFAULT_INTERVAL_MINUTES;
    const last = await getNumber(app.db, KEYS.updateCheckedAt);
    if (!last) return true;
    return Date.now() - last >= minutes * 60_000;
  }

  async function round() {
    timer = null;
    if (stopped) return;
    try {
      // Ein laufender Vorgang hat Vorrang: SteamCMD vertraegt keine zwei
      // gleichzeitigen Laeufe, und eine Installation ist wichtiger als eine
      // Auskunft.
      if (!app.jobs.current()?.running && (await due())) {
        const started = startUpdateCheck(app, { apply: true });
        if (started.ok) {
          const finished = await started.job.completion;
          if (finished.status !== "ok") log.warn(`Update-Prüfung fehlgeschlagen: ${finished.error}`);
        }
      }
    } catch (err) {
      log.warn(`Update-Prüfung abgebrochen: ${err.message}`);
    }
    schedule(TICK_MS);
  }

  function schedule(delayMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => void round(), delayMs);
    timer.unref?.();
  }

  return {
    start() {
      if (!app.db) return;
      stopped = false;
      schedule(TICK_MS);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get running() {
      return !stopped;
    },
  };
}
