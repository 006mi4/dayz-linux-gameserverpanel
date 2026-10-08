#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { findUserByUsername, setPassword } from "../src/store/users.js";
import { deleteOtherSessions } from "../src/store/sessions.js";
import { getSetting, KEYS, setSetting } from "../src/store/settings.js";
import { recordEvent } from "../src/store/events.js";
import { ACCOUNT_PATTERN, ensureSteamCmd, verifySession } from "../src/steam/steamcmd.js";
import { STEAM_HOME } from "../src/paths.js";
import {
  adoptKey,
  ensureDatabase,
  isPairToken,
  isPanelKey,
  redeemPairToken,
  startDevicePairing,
  waitForApproval,
} from "../src/dzpage/pairing.js";

/**
 * Verwaltung von der Kommandozeile, fuer das, was ohne Browser gehen muss.
 * Aufgerufen ueber `sudo dzpage-panel ...`, das uns als Dienstbenutzer startet;
 * nur der darf Konfiguration und Datenbank lesen.
 *
 *   link [--token dzp_pair_...] [--force] [--yes]   mit dem DZPage-Konto koppeln
 *                                           (--yes: ohne Rueckfrage nach dem Konto)
 *   steam-login <konto>                     SteamCMD-Anmeldung im Terminal
 *   reset-password [benutzer]               neues Passwort erzeugen
 *
 * Exit-Codes: 0 erledigt, 1 Fehler, 3 schon gekoppelt (link ohne --force).
 */

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------ Passwort */

async function resetPassword(config, wanted) {
  if (!config.database) fail("Das Panel ist noch nicht eingerichtet: Es gibt noch keine Datenbank.");
  const db = await openDatabase(config.database);
  try {
    let user;
    if (wanted) {
      user = await findUserByUsername(db, wanted);
      if (!user) fail(`Es gibt keinen Benutzer "${wanted}".`);
    } else {
      const users = await db.all("SELECT id, username FROM users ORDER BY created_at ASC", []);
      if (!users.length) fail("Es gibt noch keinen Administrator. Der Assistent legt ihn an (sudo dzpage-panel setup-code).");
      if (users.length > 1) fail(`Mehrere Benutzer vorhanden, bitte einen nennen: ${users.map((u) => u.username).join(", ")}`);
      user = users[0];
    }

    const password = randomBytes(15).toString("base64url");
    await setPassword(db, user.id, password);
    await deleteOtherSessions(db, user.id);
    await recordEvent(db, {
      kind: "auth.password",
      source: "cli",
      message: `Passwort von ${user.username} auf der Kommandozeile neu gesetzt`,
    });
    say(`Neues Passwort für ${user.username}: ${password}`);
    say("Alle Sitzungen sind abgemeldet. Nach dem Anmelden unter Konto ein eigenes setzen.");
  } finally {
    await db.close().catch(() => undefined);
  }
}

/* -------------------------------------------------------------- Kopplung */

const PAIR_ERRORS = {
  invalid_token: "Dieser Kopplungscode ist ungültig. Auf dzpage.com einen neuen Befehl holen.",
  expired_token: "Dieser Kopplungscode ist abgelaufen oder schon benutzt. Auf dzpage.com einen neuen Befehl holen.",
  denied: "Die Kopplung wurde auf dzpage.com abgelehnt.",
  expired: "Der Code ist abgelaufen, bevor er bestätigt wurde. Neu starten: sudo dzpage-panel link",
  rate_limited: "DZPage bremst gerade zu viele Kopplungsversuche. In ein paar Minuten erneut versuchen.",
  network: "DZPage ist nicht erreichbar. Netzwerk prüfen und erneut versuchen: sudo dzpage-panel link",
  limit_reached: "Dein DZPage-Konto hat schon die höchste Zahl verbundener Server. Auf dzpage.com einen entfernen.",
};

function pairError(result) {
  return PAIR_ERRORS[result.code] || `Kopplung fehlgeschlagen (${result.code}${result.status ? `, ${result.status}` : ""}).`;
}

/** Was von DZPage kommt, geht ohne Steuerzeichen ins Terminal. */
function plain(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

/**
 * Eine Frage direkt an das Terminal, nicht an stdin: Bei "curl ... | sudo bash"
 * ist stdin das Skript. Ohne Terminal (Automatisierung) gibt es keine Antwort,
 * und dann gilt die Voreinstellung.
 */
function askTerminal(question) {
  let fd;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    writeSync(fd, question);
    const buffer = Buffer.alloc(256);
    let answer = "";
    while (!answer.includes("\n")) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      answer += buffer.toString("utf8", 0, read);
    }
    return answer.split("\n")[0].trim();
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Wie bei AirDrop die Frage auf der empfangenden Seite: Bevor der Schluessel
 * gilt, steht im Terminal, an welches Konto der Server gebunden wird. Wer den
 * Kurzcode etwa von einem Screenshot abliest und schneller bestaetigt als der
 * Besitzer, faellt genau hier auf.
 */
function confirmAccount(account, assumeYes) {
  if (assumeYes) return true;
  const answer = askTerminal(
    `\nDer Server wird mit dem DZPage-Konto »${plain(account) || "?"}« verbunden. Ist das dein Konto? [J/n] `,
  );
  if (answer === null) return true;
  return !/^(n|nein|no)$/i.test(answer);
}

async function readPanelState(config) {
  if (!config.database) return { panelId: null, account: "" };
  const db = await openDatabase(config.database);
  try {
    return {
      panelId: await getSetting(db, KEYS.dzpagePanelId).catch(() => null),
      account: (await getSetting(db, KEYS.dzpageAccount).catch(() => null)) || "",
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

/**
 * Schluessel uebernehmen und bei DZPage anmelden. Scheitert nur die Anmeldung
 * (Netz, DZPage kurz weg), bleibt der Schluessel trotzdem gespeichert: DZPage
 * gibt ihn genau einmal heraus, und ein zweiter "link"-Aufruf holt die
 * Anmeldung nach, statt eine neue Kopplung zu brauchen.
 */
async function adoptAndRegister(config, key, fallbackAccount) {
  const db = await ensureDatabase(config);
  try {
    const adopted = await adoptKey({ config, db, key });
    if (!adopted.ok) {
      if (["network", "server", "rate_limited"].includes(adopted.code)) {
        config.dzpage.key = key;
        saveConfig(config);
        fail(
          `Schlüssel erhalten, aber die Anmeldung bei DZPage schlug fehl (${adopted.code}). ` +
            "Erneut versuchen, ohne neu zu koppeln: sudo dzpage-panel link",
        );
      }
      fail(pairError(adopted));
    }
    const account = adopted.account || fallbackAccount || "";
    await recordEvent(db, {
      kind: "dzpage.pair",
      source: "cli",
      message: `Mit DZPage gekoppelt (${account || "Konto unbekannt"})`,
    });
    say("");
    say(`Verbunden mit dem DZPage-Konto ${plain(account)}. Der Server erscheint jetzt auf dzpage.com unter RCon.`);
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function link(config, args) {
  const force = args.includes("--force");
  const assumeYes = args.includes("--yes");
  const tokenIndex = args.indexOf("--token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : null;
  if (tokenIndex >= 0 && !token) fail("Nach --token fehlt der Kopplungscode von dzpage.com.");

  if (config.dzpage.key && !force) {
    const state = await readPanelState(config);
    if (!state.panelId) {
      // Schluessel da, Anmeldung fehlt: die letzte Kopplung brach nach dem
      // Abholen ab. Nachholen, ohne einen neuen Code zu brauchen.
      say("Schlüssel ist vorhanden, die Anmeldung bei DZPage fehlt noch. Hole sie nach …");
      await adoptAndRegister(config, config.dzpage.key, "");
      return;
    }
    say(`Dieser Server ist schon mit DZPage verbunden${state.account ? ` (Konto ${plain(state.account)})` : ""}.`);
    say("Neu verbinden, etwa nach einem widerrufenen Schlüssel: sudo dzpage-panel link --force");
    process.exit(3);
  }

  let granted;
  if (token) {
    if (!isPairToken(token)) fail(PAIR_ERRORS.invalid_token);
    say("Löse den Kopplungscode bei DZPage ein …");
    const result = await redeemPairToken(config, token);
    if (!result.ok) fail(pairError(result));
    granted = { key: result.key, account: result.account ?? "" };
  } else {
    const started = await startDevicePairing(config);
    if (!started.ok) fail(pairError(started));
    say("");
    say("Diesen Server mit deinem DZPage-Konto verbinden:");
    say("");
    say(`    ${plain(started.verificationUrl)}`);
    say("");
    say(`Oder auf dzpage.com/link den Code ${plain(started.userCode)} eingeben.`);
    say(`Der Code gilt ${Math.round((Number(started.expiresIn) || 900) / 60)} Minuten. Warte auf Bestätigung (Strg+C bricht ab) …`);
    const result = await waitForApproval(config, started);
    if (!result.ok) fail(pairError(result));
    granted = result;
  }

  if (!isPanelKey(granted.key)) fail("DZPage hat eine unerwartete Antwort geschickt. Bitte später erneut versuchen.");
  if (!confirmAccount(granted.account, assumeYes)) {
    fail("Nicht verbunden. Der Schlüssel wird verworfen; auf diesem Server ändert sich nichts.");
  }
  await adoptAndRegister(config, granted.key, granted.account);
}

/* ------------------------------------------------------------------ Steam */

/**
 * SteamCMD-Anmeldung direkt im Terminal: Passwort und Steam-Guard-Code gehen
 * vom Menschen unmittelbar an SteamCMD, nicht durch dieses Programm und nicht
 * durch DZPage. Gespeichert wird nur, was SteamCMD selbst ablegt.
 */
async function steamLogin(config, account) {
  if (!ACCOUNT_PATTERN.test(account || "")) fail("Bitte den Steam-Kontonamen angeben: sudo dzpage-panel steam-login <konto>");
  const quietJob = { append: (text) => process.stdout.write(`${String(text).trim()}\n`) };
  const found = await ensureSteamCmd(config, quietJob);
  mkdirSync(STEAM_HOME, { recursive: true, mode: 0o750 });

  say(`Melde ${account} bei Steam an. SteamCMD fragt gleich selbst nach Passwort und gegebenenfalls Steam-Guard.`);
  say("Der erste Start lädt SteamCMD nach und dauert ein bis zwei Minuten.");
  const code = await new Promise((resolve) => {
    const child = spawn(found.path, ["+login", account, "+quit"], {
      stdio: "inherit",
      env: { HOME: STEAM_HOME, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: process.env.TERM || "xterm" },
    });
    child.on("error", () => resolve(1));
    child.on("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) say(`SteamCMD endete mit ${code}. Prüfe, ob die gemerkte Anmeldung trotzdem trägt …`);

  const check = await verifySession({ steamcmdPath: found.path, account });
  if (!check.ok) fail(`Die Anmeldung trägt nicht: ${check.message}`);

  const db = await ensureDatabase(config);
  try {
    await setSetting(db, KEYS.steamAccount, account);
    await setSetting(db, KEYS.steamLoggedInAt, Date.now());
    await recordEvent(db, { kind: "steam.login", source: "cli", message: `Bei Steam angemeldet als ${account}` });
  } finally {
    await db.close().catch(() => undefined);
  }
  say(`Angemeldet als ${account}. Downloads laufen ab jetzt ohne Passwort.`);
}

/* ---------------------------------------------------------------- Aufruf */

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig({ generateSecrets: true });

if (command === "reset-password") await resetPassword(config, rest[0]);
else if (command === "link") await link(config, rest);
else if (command === "steam-login") await steamLogin(config, rest[0]);
else fail("Aufruf: dzpage-panel-admin.js link [--token ...] [--force] | steam-login <konto> | reset-password [benutzer]");
