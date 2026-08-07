import { join } from "node:path";
import { spawnPty } from "../steam/pty.js";
import { ensureSteamCmd, PATTERNS as STEAM_PATTERNS } from "../steam/steamcmd.js";
import { STEAM_HOME } from "../paths.js";
import { serverDir } from "../store/servers.js";
import { writeServerFiles } from "./config.js";

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

function reason(output) {
  const match = output.match(PATTERNS.failed);
  return match ? match[0].replace(/\s+/g, " ").trim().slice(0, 200) : "SteamCMD hat den Abschluss nicht bestaetigt.";
}

/**
 * Spieldateien installieren oder aktualisieren. `job` bekommt die Ausgabe und
 * zeigt sie live in der Oberflaeche.
 */
export async function installGameFiles({ config, server, account, job }) {
  if (!account) throw new Error("Es ist kein Steam-Konto hinterlegt — bitte zuerst bei Steam anmelden.");
  const found = await ensureSteamCmd(config, job);
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
    const step = await pty.waitFor(
      { done: PATTERNS.done, failed: PATTERNS.failed, password: PATTERNS.password, cached: PATTERNS.cached },
      // Vier Gigabyte brauchen auf einer schwachen Leitung ihre Zeit.
      { timeoutMs: 3 * 60 * 60 * 1000 },
    );

    if (step.name === "password" || step.name === "cached") {
      throw new Error("SteamCMD fragt nach einem Passwort — die Steam-Sitzung ist abgelaufen. Bitte neu anmelden.");
    }
    if (step.name === "failed") throw new Error(reason(pty.output));
    if (step.name === "exit") throw new Error("SteamCMD hat sich beendet, ohne die Installation zu bestaetigen.");
  } finally {
    pty.kill();
  }

  return { path: target };
}

/**
 * Kompletter Ablauf beim Anlegen oder Aktualisieren: Spieldateien holen,
 * Konfigurationsdateien schreiben, Rechte und Grenzwerte setzen.
 */
export async function provisionServer({ config, server, account, job, runtime, rconPassword }) {
  await installGameFiles({ config, server, account, job });
  job.append("Schreibe Konfigurationsdateien.");
  writeServerFiles(server, rconPassword);
  job.append("Richte Laufzeit und Rechte ein.");
  await runtime.prepare(server);
  return { ok: true };
}
