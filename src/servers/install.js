import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnPty } from "../steam/pty.js";
import { ensureSteamCmd, PATTERNS as STEAM_PATTERNS } from "../steam/steamcmd.js";
import { pick, readVdfBlock } from "../steam/vdf.js";
import { STEAM_HOME } from "../paths.js";
import { rconPassword, serverDir, updateServer } from "../store/servers.js";
import { getSetting, KEYS } from "../store/settings.js";
import { runtimeFor } from "../runtime/index.js";
import { writeServerFiles } from "./config.js";
import { log } from "../log.js";

/**
 * Installation und Aktualisierung der Spieldateien.
 *
 * SteamCMD laeuft dabei nicht interaktiv: Das Sitzungstoken aus dem Assistenten
 * traegt. Fragt SteamCMD trotzdem nach einem Passwort, ist genau das die
 * Nachricht, die der Kunde braucht — dann ist die Sitzung abgelaufen und muss
 * einmal neu angelegt werden.
 */

/** DayZ Dedicated Server (Linux). */
export const DAYZ_SERVER_APP_ID = 223350;

const PATTERNS = {
  done: /Success!\s*App\s*'?\d+'?\s*(fully installed|already up to date)/i,
  failed: /(^|\n)\s*(ERROR!|Error!)[^\n]*/,
  password: STEAM_PATTERNS.passwordPrompt,
  cached: STEAM_PATTERNS.cachedCredentialsMissing,
};

const BUILD_ID = /^\d{1,20}$/;

/**
 * Feste Codes fuer das, was beim Installieren typischerweise schiefgeht. Sie
 * gehen mit dem Ergebnis eines Auftrags an dzpage.com, das sie in der Sprache
 * des Nutzers zeigt; der deutsche Text bleibt als Einzelheit dabei. Neue
 * Codes erst hier eintragen: Der Abholer gibt nur diese weiter.
 */
export const INSTALL_ERROR_CODES = Object.freeze({
  /** Kein Steam-Konto hinterlegt. */
  noAccount: "steam_no_account",
  /** SteamCMD fragt nach dem Passwort: das gemerkte Sitzungstoken traegt nicht mehr. */
  sessionExpired: "steam_session_expired",
  /** "No subscription": Das Konto besitzt DayZ nicht. */
  noLicense: "steam_no_license",
  /** DayZServer oder SteamCMD findet Systembibliotheken nicht. */
  missingLibraries: "missing_libraries",
  /** SteamCMD selbst oder die Spieldateien liessen sich nicht laden. */
  downloadFailed: "download_failed",
});

export const KNOWN_INSTALL_ERRORS = new Set(Object.values(INSTALL_ERROR_CODES));

function installError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function reason(output) {
  const match = output.match(PATTERNS.failed);
  return match ? match[0].replace(/\s+/g, " ").trim().slice(0, 200) : "SteamCMD hat den Abschluss nicht bestaetigt.";
}

/** "...: error while loading shared libraries: libstdc++.so.6: cannot open ..." */
const LOADER_ERROR = /error while loading shared libraries: ([^\s:]+)/;

/** Die Build-Nummer der installierten Spieldateien, oder null. */
export function installedBuildId(id) {
  try {
    const file = join(serverDir(id), "game", "steamapps", `appmanifest_${DAYZ_SERVER_APP_ID}.acf`);
    const state = readVdfBlock(readFileSync(file, "utf8"), "AppState");
    const value = String(pick(state, "buildid") ?? "");
    return BUILD_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Spieldateien installieren oder aktualisieren. `job` bekommt die Ausgabe und
 * zeigt sie live in der Oberflaeche.
 */
export async function installGameFiles({ config, server, account, job }) {
  if (!account) {
    throw installError(INSTALL_ERROR_CODES.noAccount, "Es ist kein Steam-Konto hinterlegt. Bitte zuerst bei Steam anmelden.");
  }
  let found;
  try {
    found = await ensureSteamCmd(config, job);
  } catch (err) {
    throw installError(INSTALL_ERROR_CODES.downloadFailed, err.message);
  }
  const target = join(serverDir(server.id), "game");

  job.append(`Installiere DayZ (App ${DAYZ_SERVER_APP_ID}) nach ${target}.`);

  const pty = spawnPty({
    command: found.path,
    args: [
      "+force_install_dir",
      target,
      "+login",
      account,
      "+app_update",
      String(DAYZ_SERVER_APP_ID),
      "validate",
      "+quit",
    ],
    env: { HOME: STEAM_HOME },
    onData: (text) => job.append(text),
  });

  try {
    let step;
    try {
      step = await pty.waitFor(
        { done: PATTERNS.done, failed: PATTERNS.failed, password: PATTERNS.password, cached: PATTERNS.cached },
        // Vier Gigabyte brauchen auf einer schwachen Leitung ihre Zeit.
        { timeoutMs: 3 * 60 * 60 * 1000 },
      );
    } catch (err) {
      throw installError(INSTALL_ERROR_CODES.downloadFailed, err.message);
    }

    if (step.name === "password" || step.name === "cached") {
      throw installError(
        INSTALL_ERROR_CODES.sessionExpired,
        "SteamCMD fragt nach einem Passwort: Die Steam-Sitzung ist abgelaufen. Bitte neu anmelden.",
      );
    }
    if (step.name === "failed") {
      const text = reason(pty.output);
      throw installError(/No subscription/i.test(text) ? INSTALL_ERROR_CODES.noLicense : INSTALL_ERROR_CODES.downloadFailed, text);
    }
    if (step.name === "exit") {
      // Ohne die 32-Bit-Bibliotheken (install.sh --no-steam-deps) startet
      // SteamCMD gar nicht erst; der Lader sagt dann, was fehlt.
      const loader = pty.output.match(LOADER_ERROR);
      if (loader) {
        throw installError(
          INSTALL_ERROR_CODES.missingLibraries,
          `SteamCMD findet die Systembibliothek ${loader[1]} nicht. Bitte die 32-Bit-Bibliotheken nachinstallieren (Debian und Ubuntu: lib32gcc-s1).`,
        );
      }
      throw installError(INSTALL_ERROR_CODES.downloadFailed, "SteamCMD hat sich beendet, ohne die Installation zu bestaetigen.");
    }
  } finally {
    pty.kill();
  }

  return { path: target };
}

/**
 * Eine Statuszeile von SteamCMD, und nur eine solche:
 * "Update state (0x61) downloading, progress: 12.34 (532123456 / 4312312312)".
 */
const STEAM_STATE_LINE = /^Update state \(0x[0-9a-f]+\) [a-z ,]+, progress: (\d{1,3}(?:\.\d+)?) \(\d+ \/ \d+\)$/i;

/**
 * Fortschritt aus der Ausgabe von SteamCMD, fuer die Anzeige auf dzpage.com:
 * die letzte Statuszeile samt Prozentwert. Andere Zeilen gehen nicht hinaus,
 * auch nicht ersatzweise: Darin stehen der Steam-Kontoname ("Logging in user
 * ...") und Pfade dieser Maschine, und beides geht DZPage nichts an.
 */
export function steamProgress(lines) {
  const tail = lines.slice(-40);
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = tail[index].trim();
    const match = line.match(STEAM_STATE_LINE);
    if (match) return { percent: Math.min(100, Math.max(0, Number(match[1]))), text: line.slice(0, 200) };
  }
  return { percent: null, text: null };
}

/**
 * Welche Systembibliotheken findet DayZServer nicht? Gefragt wird der Lader
 * selbst (ldd), mit demselben LD_LIBRARY_PATH wie beim Start. So ist die
 * Antwort fuer genau diese Maschine richtig, ganz gleich, welche Verteilung
 * darunter liegt.
 *
 * null heisst: nicht pruefbar (kein ldd, keine Binaerdatei).
 */
export function missingLibraries(gameDir) {
  const binary = join(gameDir, "DayZServer");
  if (!existsSync(binary)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "ldd",
      [binary],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { LD_LIBRARY_PATH: gameDir, PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
      (err, stdout) => {
        if (err && err.code === "ENOENT") {
          resolve(null);
          return;
        }
        resolve(parseLddOutput(stdout));
      },
    );
  });
}

/** Aus der Ausgabe von ldd die Bibliotheken, die der Lader nicht findet. */
export function parseLddOutput(text) {
  const missing = [];
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(\S+)\s+=>\s+not found/);
    if (match && !missing.includes(match[1])) missing.push(match[1]);
  }
  return missing;
}

/**
 * Kompletter Ablauf beim Anlegen oder Aktualisieren: Spieldateien holen,
 * Bibliotheken pruefen, Konfigurationsdateien schreiben, Rechte und
 * Grenzwerte setzen.
 */
export async function provisionServer({ config, server, account, job, runtime, rconPassword: password }) {
  const { path: gameDir } = await installGameFiles({ config, server, account, job });

  // Ab hier liegen die neuen Dateien schon da. Ein Fehler danach heisst nicht
  // mehr "alte Dateien noch intakt", und updateGameFiles muss das wissen.
  try {
    // ldd fragt den Lader dieser Maschine. Ein Docker-Server laeuft aber im
    // Abbild des Containers, mit dessen Bibliotheken: Dort waere die Antwort
    // in beide Richtungen falsch.
    const missing = runtime.id === "docker" ? null : await missingLibraries(gameDir);
    if (missing === null) {
      job.append(
        runtime.id === "docker"
          ? "Bibliotheken nicht geprüft: Der Server läuft im Container mit dessen eigenen Bibliotheken."
          : "Bibliotheken von DayZServer nicht geprüft (ldd oder DayZServer fehlt).",
      );
    } else if (missing.length) {
      throw installError(
        INSTALL_ERROR_CODES.missingLibraries,
        `DayZServer findet diese Systembibliotheken nicht: ${missing.join(", ")}. ` +
          "Bitte über den Paketmanager nachinstallieren und die Installation wiederholen.",
      );
    } else {
      job.append("Alle Bibliotheken von DayZServer gefunden.");
    }

    job.append("Schreibe Konfigurationsdateien.");
    writeServerFiles(server, password);
    job.append("Richte Laufzeit und Rechte ein.");
    await runtime.prepare(server);
  } catch (err) {
    err.filesReplaced = true;
    throw err;
  }
  return { ok: true };
}

const QUIET_JOB = { append() {} };

/**
 * Spieldateien eines Servers installieren oder erneuern, von wo auch immer der
 * Anstoss kommt: Schaltflaeche im Panel, Auftrag von DZPage, automatische
 * Aktualisierung. Ein Weg fuer alle drei, damit sich keiner anders verhaelt.
 *
 * Laeuft der Server, wird er angehalten und danach wieder gestartet: DayZ kann
 * seine eigenen Dateien nicht austauschen, waehrend es sie geoeffnet hat. Das
 * gilt auch fuer einen, der gerade neu startet ("starting"): Das ist der
 * typische Zustand eines abstuerzenden Servers, den man aktualisieren will,
 * und systemd oder Docker starteten ihn sonst mitten im Download.
 *
 * Scheitert SteamCMD selbst, bleibt ein vorher fertiger Server fertig: SteamCMD
 * laedt in ein Zwischenverzeichnis und tauscht erst am Ende, die alten Dateien
 * sind also noch da. Scheitert ein Schritt NACH dem Download (etwa fehlende
 * Bibliotheken fuer die neue Fassung), liegen die neuen Dateien schon da; dann
 * steht der Server auf "fehlgeschlagen" und wird nicht wieder gestartet.
 */
export async function updateGameFiles(app, server, job = QUIET_JOB) {
  try {
    return await replaceGameFiles(app, server, job);
  } finally {
    // Installiert, fehlgeschlagen, wieder gestartet: dzpage.com soll es
    // gleich sehen und nicht erst mit dem naechsten Herzschlag.
    app.reporter?.nudge();
  }
}

async function replaceGameFiles(app, server, job) {
  const runtime = runtimeFor(server);
  const firstInstall = server.install_state !== "ready";

  let wasRunning = false;
  try {
    wasRunning = ["running", "starting"].includes((await runtime.status(server)).state);
  } catch (err) {
    log.debug(`Zustand von ${server.id} vor der Installation nicht lesbar: ${err.message}`);
  }
  if (wasRunning) {
    job.append(`${server.name} läuft und wird für die Aktualisierung angehalten.`);
    await runtime.stop(server);
  }

  const account = await getSetting(app.db, KEYS.steamAccount);
  await updateServer(app.db, server.id, { install_state: "installing" });
  app.reporter?.nudge();
  try {
    await provisionServer({
      config: app.config,
      server,
      account,
      job,
      runtime,
      rconPassword: rconPassword(server, app.config.secrets.encryption),
    });
  } catch (err) {
    const oldFilesIntact = !firstInstall && !err.filesReplaced;
    await updateServer(app.db, server.id, { install_state: oldFilesIntact ? "ready" : "failed" });
    if (wasRunning && oldFilesIntact) {
      job.append(`${server.name} wird mit den bisherigen Dateien wieder gestartet.`);
      await runtime.start(server).catch((startErr) => job.append(`Start fehlgeschlagen: ${startErr.message}`));
    } else if (wasRunning) {
      job.append(`${server.name} bleibt angehalten, bis die Installation gelingt.`);
    }
    throw err;
  }

  await updateServer(app.db, server.id, {
    install_state: "ready",
    installed_at: Date.now(),
    installed_build: installedBuildId(server.id),
  });

  // Ein neuer Server steht in der Datenbank auf "startet mit der Maschine",
  // die Unit war aber noch nicht eingeschaltet: vor der ersten Installation
  // gibt es nichts zu starten. Jetzt gibt es etwas.
  if (firstInstall && Number(server.autostart) === 1) {
    await runtime.setAutostart(server, true).catch((err) => job.append(`Autostart nicht gesetzt: ${err.message}`));
  }

  if (wasRunning) {
    job.append(`Starte ${server.name} wieder.`);
    await runtime.start(server);
  }
  return { wasRunning, firstInstall, build: installedBuildId(server.id) };
}
