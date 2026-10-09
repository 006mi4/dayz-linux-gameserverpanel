import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, SELF_UPDATE_FILE } from "../paths.js";
import { PANEL_VERSION } from "../version.js";
import { canSelfUpdate, installation, repositorySlug } from "./installation.js";
import { runHelper } from "../runtime/helper.js";
import { getSetting, KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { log } from "../log.js";

/**
 * Aktualisierung des Panels selbst.
 *
 * Der Kanal ist Git, in beiden Installationsarten derselbe: Das Panel fragt
 * GitHub nach den Fassungen (`/tags`, ohne Konto und ohne Schluessel), und
 * ausgerollt wird ein Etikett `v<x.y.z>` aus genau dem Arbeitsverzeichnis, aus
 * dem installiert wurde. Ein Fork bekommt seine eigenen Fassungen gemeldet,
 * weil die Adresse aus `install.json` kommt.
 *
 * Wer die Dateien selbst ausrollt, ist verschieden:
 * - **git**: der privilegierte Helfer startet `self-update.sh` als eigenen
 *   Dienst. Das muss so sein, weil dabei das Panel neu startet — ein Prozess,
 *   der sich selbst beendet, kann den Rest der Arbeit nicht mehr erledigen.
 * - **docker**: das Panel aktualisiert sein Arbeitsverzeichnis selbst und
 *   beendet sich; die Neustartregel des Containers bringt es mit dem neuen
 *   Stand zurueck.
 *
 * Der Ausgang landet in einer Datei (SELF_UPDATE_FILE), weil er den Neustart
 * ueberleben muss: Was in Arbeitsspeicher steht, ist danach weg.
 */

const GITHUB_API = process.env.DZPAGE_PANEL_GITHUB_API || "https://api.github.com";
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const FETCH_TIMEOUT_MS = 15_000;

/** aus = gar nicht nachsehen, notify = melden und fragen, auto = selbst einspielen. */
export const PANEL_UPDATE_MODES = ["auto", "notify", "off"];
export const DEFAULT_PANEL_UPDATE_MODE = "auto";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Nicht sofort beim Start: erst soll das Panel stehen, dann darf es sich umsehen. */
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;

/** Zaehler und letzter guter Stand fuer den Container — siehe docker/entrypoint.sh. */
const BOOT_ATTEMPTS_FILE = join(DATA_DIR, "boot-attempts");
const GOOD_REF_FILE = join(DATA_DIR, "good-ref");

/* --------------------------------------------------------------- Fassungen */

export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0, 1 — und null, wenn eine der beiden Angaben keine Fassung ist. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Die hoechste Fassung aus der Etikettenliste von GitHub.
 *
 * Nur `v1.2.3` zaehlt: Vorabfassungen (`v1.2.3-rc1`) und Zweigmarken sollen
 * niemandem ungefragt ins Haus fallen. Sortiert wird nach Zahlen, nicht nach
 * Text — sonst stuende `v0.9.0` ueber `v0.10.0`.
 */
export function latestTag(tags) {
  let best = null;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const match = TAG.exec(String(tag?.name ?? tag ?? ""));
    if (!match) continue;
    const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** Fragt GitHub nach den Etiketten. Ohne Konto, ohne Schluessel, nur lesend. */
export async function fetchLatestVersion({ slug, fetchImpl = fetch } = {}) {
  if (!slug) throw new Error("Keine GitHub-Adresse hinterlegt.");
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API}/repos/${slug}/tags?per_page=100`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `dzpage-panel/${PANEL_VERSION}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err.name === "TimeoutError" ? "GitHub hat nicht rechtzeitig geantwortet." : err.message);
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub hat die Anfrage vorerst abgewiesen (Ratenbegrenzung).");
  }
  if (response.status === 404) throw new Error(`Kein Projekt ${slug} bei GitHub gefunden.`);
  if (!response.ok) throw new Error(`GitHub antwortete mit ${response.status}.`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GitHub hat keine verwertbare Antwort geliefert.");
  }
  return latestTag(payload);
}

/* ----------------------------------------------------------------- Pruefung */

export async function readPanelUpdateState(db) {
  const mode = (await getSetting(db, KEYS.panelUpdateMode)) || DEFAULT_PANEL_UPDATE_MODE;
  const latest = await getSetting(db, KEYS.panelUpdateLatest);
  return {
    mode: PANEL_UPDATE_MODES.includes(mode) ? mode : DEFAULT_PANEL_UPDATE_MODE,
    current: PANEL_VERSION,
    latest,
    newer: Boolean(latest) && compareVersions(latest, PANEL_VERSION) > 0,
    checkedAt: Number(await getSetting(db, KEYS.panelUpdateCheckedAt)) || null,
    error: (await getSetting(db, KEYS.panelUpdateError)) || "",
    result: readSelfUpdateResult(),
    installation: installation(),
  };
}

/**
 * Einmal bei GitHub nachsehen. Meldet ein Ereignis genau einmal je Fassung —
 * nicht je Pruefung, sonst stuende alle sechs Stunden dieselbe Zeile im
 * Protokoll.
 */
export async function checkPanelUpdate(app, { fetchImpl = fetch } = {}) {
  const db = app.db;
  const slug = repositorySlug();
  let latest;
  try {
    latest = await fetchLatestVersion({ slug, fetchImpl });
  } catch (err) {
    await setSetting(db, KEYS.panelUpdateError, err.message.slice(0, 300));
    await setSetting(db, KEYS.panelUpdateCheckedAt, Date.now());
    throw err;
  }

  await setSetting(db, KEYS.panelUpdateLatest, latest ?? "");
  await setSetting(db, KEYS.panelUpdateCheckedAt, Date.now());
  await setSetting(db, KEYS.panelUpdateError, "");

  const newer = Boolean(latest) && compareVersions(latest, PANEL_VERSION) > 0;
  if (newer && (await getSetting(db, KEYS.panelUpdateAnnounced)) !== latest) {
    await setSetting(db, KEYS.panelUpdateAnnounced, latest);
    await recordEvent(db, {
      kind: "panel.update.available",
      message: `Panel ${latest} steht bereit (installiert: ${PANEL_VERSION})`,
    });
  }
  return { current: PANEL_VERSION, latest, newer };
}

/* --------------------------------------------------------------- Ausrollen */

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = `${stderr || ""}${stdout || ""}`.trim().split("\n").slice(-2).join(" ");
        reject(new Error(detail || err.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/**
 * Die neue Fassung einspielen. Danach ist dieser Prozess in beiden
 * Installationsarten dem Untergang geweiht — der Aufrufer muss die Antwort
 * schon abgeschickt haben.
 */
export async function applyPanelUpdate(app, version, { exit = () => process.exit(0) } = {}) {
  const info = installation();
  if (!canSelfUpdate(info)) {
    throw new Error("Dieses Panel wurde von Hand installiert. Bitte selbst aktualisieren (siehe README).");
  }
  if (!parseVersion(version)) throw new Error(`Keine gültige Fassung: ${version}`);
  if (compareVersions(version, PANEL_VERSION) <= 0) {
    throw new Error(`Fassung ${version} ist nicht neuer als die laufende (${PANEL_VERSION}).`);
  }

  await recordEvent(app.db, {
    kind: "panel.update.start",
    message: `Panel wird auf ${version} aktualisiert (${PANEL_VERSION} läuft)`,
  }).catch(() => undefined);

  if (info.method === "git") {
    // Der Helfer startet self-update.sh als eigenen Dienst und kommt sofort
    // zurueck. Alles Weitere — Dateien austauschen, Neustart, Ruecknahme bei
    // einem Fehlstart — passiert ausserhalb dieses Prozesses.
    const answer = await runHelper(["self-update", `v${version}`]);
    log.info(`Selbstaktualisierung auf ${version} angestossen: ${answer.trim()}`);
    return { started: true, method: "git" };
  }

  await applyInContainer(info, version, exit);
  return { started: true, method: "docker" };
}

async function applyInContainer(info, version, exit) {
  const dir = info.checkout;
  if (!dir) throw new Error("Kein Arbeitsverzeichnis in install.json hinterlegt.");
  const previous = await git(dir, ["rev-parse", "HEAD"]);

  writeSelfUpdateResult({
    state: "running",
    from: PANEL_VERSION,
    to: version,
    startedAt: new Date().toISOString(),
    message: "",
  });

  try {
    await git(dir, ["fetch", "--tags", "--prune", "origin"]);
    await git(dir, ["rev-parse", "--verify", `refs/tags/v${version}^{commit}`]);
    await git(dir, ["reset", "--hard", `refs/tags/v${version}`]);
  } catch (err) {
    writeSelfUpdateResult({
      state: "failed",
      from: PANEL_VERSION,
      to: version,
      finishedAt: new Date().toISOString(),
      message: err.message.slice(0, 300),
    });
    await git(dir, ["reset", "--hard", previous]).catch(() => undefined);
    throw err;
  }

  writeSelfUpdateResult({
    state: "ok",
    from: PANEL_VERSION,
    to: version,
    finishedAt: new Date().toISOString(),
    message: "Container startet neu.",
  });

  // Beenden ist hier der Neustart: Die Regel "unless-stopped" bringt den
  // Container zurueck, und der Einstieg nimmt dann den neuen Stand.
  setTimeout(exit, 500).unref?.();
}

/* -------------------------------------------------------- Ergebnisdatei */

export function readSelfUpdateResult(file = SELF_UPDATE_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      state: ["running", "ok", "failed"].includes(raw.state) ? raw.state : "failed",
      from: String(raw.from ?? ""),
      to: String(raw.to ?? ""),
      startedAt: String(raw.startedAt ?? ""),
      finishedAt: String(raw.finishedAt ?? ""),
      rolledBack: Boolean(raw.rolledBack),
      message: String(raw.message ?? "").slice(0, 300),
    };
  } catch {
    return null;
  }
}

function writeSelfUpdateResult(result, file = SELF_UPDATE_FILE) {
  try {
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
  } catch (err) {
    log.warn(`Ergebnis der Selbstaktualisierung nicht schreibbar: ${err.message}`);
  }
}

/**
 * Nach dem Neustart: Was ist aus der Aktualisierung geworden? Genau einmal ins
 * Ereignisprotokoll — deshalb der Zeitstempel als Merker.
 */
export async function announceSelfUpdateResult(app) {
  const result = readSelfUpdateResult();
  if (!result || result.state === "running" || !result.finishedAt) return null;
  const seen = await getSetting(app.db, KEYS.panelUpdateResultAt);
  if (seen === result.finishedAt) return null;
  await setSetting(app.db, KEYS.panelUpdateResultAt, result.finishedAt);

  if (result.state === "ok") {
    await recordEvent(app.db, {
      kind: "panel.update.applied",
      message: `Panel von ${result.from} auf ${result.to} aktualisiert`,
    });
  } else {
    await recordEvent(app.db, {
      kind: "panel.update.failed",
      message: `Aktualisierung auf ${result.to} fehlgeschlagen${
        result.rolledBack ? ", alter Stand wiederhergestellt" : ""
      }: ${result.message}`,
    });
  }
  return result;
}

/**
 * Der Start hat geklappt: Zaehler zuruecksetzen und den laufenden Stand als
 * "gut" merken. Nur im Container von Bedeutung — dort ist diese Markierung das,
 * worauf der Einstieg zurueckfaellt, wenn eine neue Fassung nicht hochkommt.
 */
export async function markBootSuccessful() {
  const info = installation();
  if (info.method !== "docker" || !info.checkout) return;
  try {
    writeFileSync(BOOT_ATTEMPTS_FILE, "0\n");
    writeFileSync(GOOD_REF_FILE, `${await git(info.checkout, ["rev-parse", "HEAD"])}\n`);
  } catch (err) {
    log.debug(`Startmarkierung nicht schreibbar: ${err.message}`);
  }
}

/* -------------------------------------------------------------- Zeitplan */

/**
 * Sieht regelmaessig nach, ob eine neue Fassung des Panels bereitsteht, und
 * spielt sie bei "auto" gleich ein.
 *
 * Waehrend der Einrichtung passiert nichts: Ein Panel, das dem Kunden mitten im
 * Assistenten unter den Haenden neu startet, waere die schlechteste erste
 * Erfahrung, die man bauen kann.
 */
export function createPanelUpdateWatcher(app, { fetchImpl = fetch } = {}) {
  let stopped = true;
  let timer = null;
  let lastCheck = 0;

  async function ready() {
    if (!app.db) return false;
    const mode = (await getSetting(app.db, KEYS.panelUpdateMode)) || DEFAULT_PANEL_UPDATE_MODE;
    if (mode === "off") return false;
    if ((await getSetting(app.db, KEYS.setupCompletedAt)) !== null) return true;
    // Wer ueber "dzpage-panel link" gekoppelt hat, durchlaeuft den Assistenten
    // nie. Ohne diese Bedingung bekaeme genau dieses Panel keine Fassung mehr.
    return Boolean(app.config.dzpage.key) && (await getSetting(app.db, KEYS.dzpagePanelId)) !== null;
  }

  async function round() {
    timer = null;
    if (stopped) return;
    try {
      // Das Ergebnis der letzten Aktualisierung steht erst fest, nachdem das
      // Panel schon wieder laeuft: install.sh startet den Dienst und wartet auf
      // /health, und erst danach schreibt self-update.sh die Datei. Beim Start
      // ist sie also noch "running" — hier ist sie fertig.
      if (app.db) await announceSelfUpdateResult(app).catch(() => undefined);

      if (await ready()) {
        lastCheck = Date.now();
        const { latest, newer } = await checkPanelUpdate(app, { fetchImpl });
        const mode = (await getSetting(app.db, KEYS.panelUpdateMode)) || DEFAULT_PANEL_UPDATE_MODE;
        // Eine Fassung, die hier schon einmal gescheitert ist, nicht von selbst
        // wieder einspielen: Sonst liefe Aktualisieren, Fehlstart, Ruecknahme
        // alle paar Stunden im Kreis. Die Schaltflaeche bleibt der Weg dafuer.
        const last = readSelfUpdateResult();
        const failedBefore = last?.state === "failed" && last.to === latest;
        if (newer && mode === "auto" && canSelfUpdate() && failedBefore) {
          log.info(`Panel ${latest} ist hier schon einmal gescheitert und wird nicht von selbst wiederholt.`);
        } else if (newer && mode === "auto" && canSelfUpdate()) {
          // Ein laufender Vorgang hat Vorrang: Wer gerade DayZ herunterlaedt,
          // soll das nicht durch einen Neustart des Panels verlieren.
          if (app.jobs.current()?.running) {
            log.info(`Panel ${latest} steht bereit, aber ein Vorgang läuft; später.`);
          } else {
            log.info(`Panel ${latest} wird automatisch eingespielt.`);
            await applyPanelUpdate(app, latest);
          }
        }
      }
    } catch (err) {
      log.warn(`Panel-Update-Prüfung: ${err.message}`);
    }
    schedule(CHECK_INTERVAL_MS);
  }

  function schedule(delayMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => void round(), delayMs);
    timer.unref?.();
  }

  return {
    start() {
      stopped = false;
      schedule(FIRST_CHECK_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get lastCheck() {
      return lastCheck;
    },
    get running() {
      return !stopped;
    },
  };
}
