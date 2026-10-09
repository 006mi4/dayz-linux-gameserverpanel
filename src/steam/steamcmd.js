import { accessSync, constants, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { STEAM_HOME, STEAMCMD_DIR } from "../paths.js";
import { spawnPty } from "./pty.js";
import { log } from "../log.js";

/**
 * SteamCMD finden, notfalls installieren, und den interaktiven Login fahren.
 *
 * Ein DayZ-Linux-Server braucht ein Steam-Konto, das DayZ besitzt — anonym
 * antwortet Steam mit "No subscription". Das Passwort wird einmal durch die
 * Pseudo-Konsole geschoben und danach verworfen; was bleibt, ist das
 * Sitzungstoken, das SteamCMD selbst in seinem HOME ablegt.
 */

/** Beide Adressen liefern dasselbe Archiv (2,4 MB); die zweite ist die Reserve. */
export const STEAMCMD_URLS = [
  "https://media.steampowered.com/client/installer/steamcmd_linux.tar.gz",
  "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz",
];

export const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{2,64}$/;

/**
 * Muster in der Ausgabe von SteamCMD. Wo es um Eingabeaufforderungen geht,
 * sind sie auf das Ende des Puffers verankert — ein Prompt ist erst dann
 * einer, wenn nichts mehr dahinter kommt.
 *
 * Am echten Client gemessen (Version 1785799152, 2026-08-06). Zwei Fallen,
 * die dabei aufgefallen sind:
 * - Die Ausgabe ist eingefaerbt; ohne das Entfernen der Steuerzeichen in
 *   pty.js endet die Zeile auf "password: \x1b[0m" und kein Muster trifft.
 * - "FAILED" wird GROSS geschrieben und muss es auch bleiben: der Start
 *   enthaelt harmlose Zeilen wie "ILocalize::AddFile() failed to load file",
 *   die eine Anmeldung sonst faelschlich als gescheitert melden.
 * - Das Ergebnis haengt MITTEN in der Zeile, nicht an deren Anfang:
 *   "Logging in user 'x' [U:1:0] to Steam Public...ERROR (Invalid Password)".
 *   Ein Muster, das nur den Zeilenanfang prueft, geht daran vorbei — und weil
 *   danach wieder "Steam>" erscheint, wuerde ein unbekannter Fehlergrund als
 *   Erfolg durchgehen. Deshalb faengt "(FAILED|ERROR) (...)" jede Klammer ab,
 *   auch die, die wir noch nie gesehen haben.
 */
export const PATTERNS = {
  consolePrompt: /Steam>\s*$/,
  passwordPrompt: /password\s*:\s*$/i,
  guardPrompt: /(two-factor|steam ?guard)[^:\n]*:\s*$/i,
  loginOk: /(to Steam Public\s*\.*\s*OK|Waiting for user info\s*\.*\s*OK|Logged in OK|Login OK)/i,
  loginFailed:
    /(^|\n)FAILED[^\n]*|(FAILED|ERROR) \([^)\n]*\)|Invalid Password|Rate Limit Exceeded|Two-factor code mismatch|Account logon denied|Login Failure[^\n]*/,
  /** Sagt der neue Client, wenn das Sitzungstoken fehlt. */
  cachedCredentialsMissing: /Cached credentials not found/i,
  /** Letzte Rueckfrage-Rettung: irgendeine Zeile, die auf einen Doppelpunkt endet. */
  unknownPrompt: /(^|\n)([^\n]{1,80}):[ \t]*$/,
};

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(names) {
  for (const path of names) if (isExecutable(path)) return path;
  return null;
}

/**
 * Vorhandenes SteamCMD suchen. Der eigene Platz kommt zuerst: was das Panel
 * selbst installiert hat, kennt es am besten. Danach der Weg der Distribution,
 * damit auf einem Rechner mit "apt install steamcmd" nichts doppelt liegt.
 */
export function findSteamCmd(config = {}) {
  const configured = config.steam?.steamcmdPath;
  if (configured && isExecutable(configured)) return { path: configured, source: "config" };

  const own = join(STEAMCMD_DIR, "steamcmd.sh");
  if (isExecutable(own)) return { path: own, source: "panel" };

  const distro = findBinary([
    "/usr/games/steamcmd",
    "/usr/lib/games/steam/steamcmd.sh",
    join(homedir(), "steamcmd", "steamcmd.sh"),
  ]);
  if (distro) return { path: distro, source: "system" };
  return null;
}

async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} von ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 0o600 }));
}

function runQuiet(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} endete mit ${code}: ${output.trim().slice(0, 300)}`)),
    );
  });
}

/**
 * SteamCMD in das Datenverzeichnis installieren. Das braucht keine Rootrechte:
 * heruntergeladen und entpackt wird als Dienstbenutzer. Die 32-Bit-Bibliotheken,
 * die SteamCMD braucht, kann nur der Installer setzen — fehlen sie, sagt der
 * erste Lauf es im Klartext.
 */
export async function installSteamCmd(job) {
  const tar = findBinary(["/bin/tar", "/usr/bin/tar"]);
  if (!tar) throw new Error("tar fehlt. Ohne Entpacker kann SteamCMD nicht installiert werden.");

  mkdirSync(STEAMCMD_DIR, { recursive: true, mode: 0o750 });
  const archive = join(STEAMCMD_DIR, "steamcmd_linux.tar.gz");

  let lastError = null;
  for (const url of STEAMCMD_URLS) {
    try {
      job?.append(`Lade SteamCMD von ${url}`);
      await download(url, archive);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      log.warn(`SteamCMD-Download fehlgeschlagen: ${err.message}`);
    }
  }
  if (lastError) throw new Error(`SteamCMD konnte nicht geladen werden: ${lastError.message}`);

  job?.append("Entpacke SteamCMD");
  await runQuiet(tar, ["-xzf", archive, "-C", STEAMCMD_DIR]);
  rmSync(archive, { force: true });

  const path = join(STEAMCMD_DIR, "steamcmd.sh");
  if (!isExecutable(path)) throw new Error("Nach dem Entpacken fehlt steamcmd.sh.");
  return path;
}

export async function ensureSteamCmd(config, job) {
  const found = findSteamCmd(config);
  if (found) return { ...found, installed: false };
  const path = await installSteamCmd(job);
  return { path, source: "panel", installed: true };
}

function steamEnv() {
  mkdirSync(STEAM_HOME, { recursive: true, mode: 0o750 });
  // Eigenes HOME: das Sitzungstoken von SteamCMD landet darin und gehoert dem
  // Dienstbenutzer — nicht dem Konto, mit dem gerade jemand angemeldet ist.
  return { HOME: STEAM_HOME };
}

function failureReason(output) {
  const match = output.match(PATTERNS.loginFailed);
  if (!match) return "SteamCMD hat die Anmeldung nicht bestaetigt.";
  return match[0].replace(/\s+/g, " ").trim().slice(0, 200);
}

function lastPromptLine(output) {
  const match = output.match(PATTERNS.unknownPrompt);
  return match ? match[2].trim().slice(0, 80) : "?";
}

/**
 * Interaktive Anmeldung. `job` liefert die Rueckfragen an die Oberflaeche und
 * haelt Passwort und Code von jedem Protokoll fern.
 */
export async function steamLogin({ steamcmdPath, account, password, job }) {
  if (!ACCOUNT_PATTERN.test(account || "")) {
    return { ok: false, message: "Der Kontoname enthaelt unerlaubte Zeichen." };
  }
  job.redact(password);

  const pty = spawnPty({
    command: steamcmdPath,
    env: steamEnv(),
    onData: (text) => job.append(text),
  });

  try {
    // Der erste Start laedt sich selbst nach und startet sich neu — das dauert
    // auf einer frischen Maschine ein bis zwei Minuten. Auf Fehlermuster wird
    // hier bewusst nicht geachtet: die Startmeldungen enthalten harmlose
    // Zeilen mit "failed".
    const first = await pty.waitFor({ console: PATTERNS.consolePrompt }, { timeoutMs: 300_000 });
    if (first.name !== "console") {
      return { ok: false, message: "SteamCMD hat sich beendet, bevor es bereit war." };
    }

    pty.clear();
    pty.write(`login ${account}`);
    let passwordSent = false;

    for (let round = 0; round < 12; round += 1) {
      const step = await pty.waitFor(
        {
          ok: PATTERNS.loginOk,
          failed: PATTERNS.loginFailed,
          password: PATTERNS.passwordPrompt,
          guard: PATTERNS.guardPrompt,
          // Kehrt die Eingabeaufforderung zurueck, ist der Befehl durch. Ohne
          // Fehlerzeile davor heisst das: die Anmeldung hat geklappt. Das ist
          // die verlaesslichste Erfolgsmeldung, weil die Bestaetigungstexte
          // sich zwischen den Client-Versionen unterscheiden.
          prompt: PATTERNS.consolePrompt,
          unknown: PATTERNS.unknownPrompt,
        },
        { timeoutMs: 180_000 },
      );

      if (step.name === "prompt" && !passwordSent) {
        // Verspaetete Eingabeaufforderung von vorher — weiter warten.
        pty.clear();
        continue;
      }

      if (step.name === "ok" || step.name === "prompt") {
        pty.clear();
        pty.write("quit");
        await Promise.race([pty.exited, new Promise((resolve) => setTimeout(resolve, 15_000).unref?.())]);
        pty.kill();
        return { ok: true, account };
      }
      if (step.name === "failed") {
        const message = failureReason(pty.output);
        pty.kill();
        return { ok: false, message };
      }
      if (step.name === "exit") {
        return { ok: false, message: "SteamCMD hat sich beendet, ohne die Anmeldung zu bestaetigen." };
      }

      const output = pty.output;
      pty.clear();
      if (step.name === "password") {
        passwordSent = true;
        pty.write(password);
        continue;
      }
      // Steam-Guard oder eine Frage, die wir nicht kennen: beides geht als
      // Rueckfrage an den Menschen. Die Antwort wird sofort auf die
      // Streichliste gesetzt, damit sie nirgends auftaucht.
      const answer = await job.ask(
        step.name === "guard"
          ? { kind: "guard", text: "" }
          : { kind: "prompt", text: lastPromptLine(output) },
      );
      job.redact(answer);
      pty.write(answer);
    }

    pty.kill();
    return { ok: false, message: "SteamCMD hat zu viele Rueckfragen gestellt." };
  } finally {
    pty.kill();
  }
}

/**
 * Prueft, ob das gemerkte Sitzungstoken noch traegt: Anmeldung ohne Passwort.
 * Sobald SteamCMD nach einem Passwort fragt, ist die Antwort nein.
 */
export async function verifySession({ steamcmdPath, account }) {
  if (!ACCOUNT_PATTERN.test(account || "")) return { ok: false, message: "Ungueltiger Kontoname." };

  const pty = spawnPty({
    command: steamcmdPath,
    args: ["+login", account, "+quit"],
    env: steamEnv(),
  });
  try {
    const step = await pty.waitFor(
      {
        ok: PATTERNS.loginOk,
        failed: PATTERNS.loginFailed,
        cached: PATTERNS.cachedCredentialsMissing,
        password: PATTERNS.passwordPrompt,
        guard: PATTERNS.guardPrompt,
      },
      { timeoutMs: 180_000 },
    );
    if (step.name === "ok") return { ok: true };
    if (step.name === "password" || step.name === "guard" || step.name === "cached") {
      return { ok: false, message: "Das Sitzungstoken traegt nicht mehr. Bitte neu anmelden." };
    }
    return { ok: false, message: failureReason(pty.output) };
  } finally {
    pty.kill();
  }
}
