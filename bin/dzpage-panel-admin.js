#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ReadStream } from "node:tty";
import { loadConfig, saveConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { findUserByUsername, setPassword } from "../src/store/users.js";
import { deleteOtherSessions } from "../src/store/sessions.js";
import { getSetting, KEYS, setSetting } from "../src/store/settings.js";
import { recordEvent } from "../src/store/events.js";
import { countServers } from "../src/store/servers.js";
import { ACCOUNT_PATTERN, ensureSteamCmd, verifySession } from "../src/steam/steamcmd.js";
import { STEAM_HOME } from "../src/paths.js";
import {
  adoptKey,
  checkStoredKey,
  ensureDatabase,
  isPairToken,
  isPanelKey,
  redeemPairToken,
  revokeKey,
  startDevicePairing,
  waitForApproval,
} from "../src/dzpage/pairing.js";
import { clearKeyRejected, isRejection, markKeyRejected, readKeyRejection } from "../src/dzpage/keystate.js";

/**
 * Verwaltung von der Kommandozeile, fuer das, was ohne Browser gehen muss.
 * Aufgerufen ueber `sudo dzpage-panel ...`, das uns als Dienstbenutzer startet;
 * nur der darf Konfiguration und Datenbank lesen.
 *
 *   link [--token dzp_pair_...] [--force] [--yes]   mit dem DZPage-Konto koppeln
 *                                           (--yes: ohne Rueckfrage nach dem Konto)
 *   dzpage-status                           Verbindung zu DZPage in einer Zeile
 *   forget-key                              Schluessel bei DZPage widerrufen, bevor
 *                                           uninstall --purge die Konfiguration loescht
 *   steam-login <konto>                     SteamCMD-Anmeldung im Terminal
 *   reset-password [benutzer]               neues Passwort erzeugen
 *
 * Exit-Codes: 0 erledigt, 1 Fehler, 3 schon gekoppelt (link ohne --force,
 * und DZPage nimmt den gespeicherten Schluessel noch an).
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

/** Strg+C, Strg+D oder ein aufgelegtes Terminal an der Rueckfrage. */
const ABORTED = Symbol("abgebrochen");
const PROMPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
/** So lange wird vor der Frage verworfen, was schon im Terminal wartet. */
const DRAIN_MS = 200;

/**
 * Eine Frage direkt an das Terminal, nicht an stdin: Bei "curl ... | sudo bash"
 * ist stdin das Skript. Ohne Terminal (Automatisierung) gibt es keine Antwort
 * (null), und dann gilt die Voreinstellung.
 *
 * Gelesen wird, ohne den Prozess zu blockieren: Ein blockierendes Lesen hielte
 * auch Strg+C auf, bis jemand Enter drueckt. So kommt ein Abbruch als ABORTED
 * zurueck, und der Aufrufer kann noch aufraeumen.
 *
 * Was vor der Frage getippt wurde, etwa ein Enter waehrend des Wartens auf die
 * Bestaetigung, ist keine Antwort darauf und wird verworfen.
 */
function askTerminal(question) {
  let fd;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let input = null;
    let answer = "";
    let asking = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      for (const signal of PROMPT_SIGNALS) process.off(signal, onSignal);
      // Der Lesestrom schliesst seinen Deskriptor selbst.
      if (input) input.destroy();
      else closeSync(fd);
      resolve(value);
    };
    const onSignal = () => {
      try {
        writeSync(fd, "\n");
      } catch {
        /* Terminal schon weg */
      }
      finish(ABORTED);
    };
    for (const signal of PROMPT_SIGNALS) process.on(signal, onSignal);
    try {
      input = new ReadStream(fd);
    } catch {
      finish(ABORTED);
      return;
    }
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      if (!asking) return;
      answer += chunk;
      if (answer.includes("\n")) finish(answer.split("\n")[0].trim());
    });
    input.on("end", () => finish(ABORTED));
    input.on("error", () => finish(ABORTED));
    setTimeout(() => {
      if (done) return;
      try {
        writeSync(fd, question);
      } catch {
        finish(ABORTED);
        return;
      }
      asking = true;
    }, DRAIN_MS);
  });
}

/**
 * Wie bei AirDrop die Frage auf der empfangenden Seite: Bevor der Schluessel
 * gilt, steht im Terminal, an welches Konto der Server gebunden wird. Wer den
 * Kurzcode etwa von einem Screenshot abliest und schneller bestaetigt als der
 * Besitzer, faellt genau hier auf. Verbunden wird nur auf ein klares Ja (oder
 * Enter); wer abbricht oder etwas anderes tippt, hat nicht zugestimmt.
 */
async function confirmAccount(account, assumeYes) {
  if (assumeYes) return true;
  const answer = await askTerminal(
    `\nDer Server wird mit dem DZPage-Konto »${plain(account) || "?"}« verbunden. Ist das dein Konto? [J/n] `,
  );
  if (answer === null) return true;
  if (answer === ABORTED) return false;
  return /^(|j|ja|y|yes)$/i.test(answer);
}

/**
 * Verneint: Der Schluessel ist auf DZPage schon ausgestellt. Nur vergessen
 * hiesse, er bliebe dort aktiv und belegte einen der zehn Plaetze des Kontos.
 *
 * Bis der Widerruf durch ist, zaehlen Signale nicht: Ein zweites Strg+C, weil
 * es dauert, haette ihn sonst abgebrochen. Ist das Terminal schon weg, laeuft
 * er trotzdem zu Ende.
 */
async function declineKey(config, key) {
  const ignore = () => {};
  process.stdout.on("error", ignore);
  process.stderr.on("error", ignore);
  for (const signal of PROMPT_SIGNALS) process.on(signal, ignore);
  let revoked;
  try {
    try {
      say("Widerrufe den neuen Schlüssel auf dzpage.com …");
    } catch {
      /* Terminal schon weg */
    }
    revoked = await revokeKey(config, key);
  } finally {
    for (const signal of PROMPT_SIGNALS) process.off(signal, ignore);
  }
  if (revoked.ok) fail("Nicht verbunden. Der neue Schlüssel ist auf dzpage.com widerrufen; auf diesem Server ändert sich nichts.");
  fail(
    "Nicht verbunden; auf diesem Server ändert sich nichts. " +
      `Den neuen Schlüssel (${key.slice(0, 16)}…) konnte das Panel auf dzpage.com nicht widerrufen (${revoked.code}). ` +
      "Ist es dein Konto, widerrufe ihn dort unter RCon bei den Panel-Schlüsseln.",
  );
}

async function readPanelState(config) {
  const empty = { panelId: null, account: "", rejection: null, lastSeenAt: null, heartbeatSeconds: null, serverCount: 0 };
  if (!config.database) return empty;
  const db = await openDatabase(config.database);
  const read = (name) => getSetting(db, name).catch(() => null);
  try {
    return {
      panelId: await read(KEYS.dzpagePanelId),
      account: (await read(KEYS.dzpageAccount)) || "",
      rejection: await readKeyRejection(db).catch(() => null),
      lastSeenAt: Number(await read(KEYS.dzpageLastSeenAt)) || null,
      heartbeatSeconds: Number(await read(KEYS.dzpageHeartbeatSeconds)) || null,
      serverCount: await countServers(db).catch(() => 0),
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function withDatabase(config, fn) {
  const db = await ensureDatabase(config);
  try {
    return await fn(db);
  } finally {
    await db.close().catch(() => undefined);
  }
}

function rejectedNotice(code) {
  return code === "revoked"
    ? "Der gespeicherte Schlüssel wurde auf dzpage.com widerrufen. Verbinde neu …"
    : "DZPage kennt den gespeicherten Schlüssel nicht mehr. Verbinde neu …";
}

/**
 * Schluessel uebernehmen und bei DZPage anmelden. Scheitert nur die Anmeldung
 * (Netz, DZPage kurz weg), bleibt der Schluessel trotzdem gespeichert: DZPage
 * gibt ihn genau einmal heraus, und ein zweiter "link"-Aufruf holt die
 * Anmeldung nach, statt eine neue Kopplung zu brauchen.
 *
 * `stored`: der Schluessel liegt schon in der Konfiguration. Lehnt DZPage ihn
 * ab, ist das kein Fehler, sondern der Anlass fuer eine neue Kopplung.
 */
async function adoptAndRegister(config, key, fallbackAccount, { stored = false } = {}) {
  const db = await ensureDatabase(config);
  try {
    const adopted = await adoptKey({ config, db, key });
    if (!adopted.ok) {
      if (stored && isRejection(adopted.code)) {
        await markKeyRejected(db, adopted.code, { source: "cli" });
        return { rejected: adopted.code };
      }
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
    return { ok: true };
  } finally {
    await db.close().catch(() => undefined);
  }
}

/**
 * Es liegt schon ein Schluessel da. Neu gekoppelt wird nur, wenn DZPage ihn
 * ablehnt; einen gueltigen ersetzt nur --force, damit derselbe Befehl ein
 * zweites Mal keine zweite Kopplung erzeugt. Gefragt wird DZPage selbst; den
 * Vermerk von Herzschlag und Abholer (401/403) braucht es nur, wenn DZPage
 * gerade nicht antwortet.
 *
 * Ergebnis: "linked" (Anmeldung nachgeholt oder veralteten Vermerk
 * zurueckgenommen; Exit 0, damit dzpage-panel den Dienst neu startet),
 * "connected" (bleibt) oder "replace" (neu koppeln).
 */
async function storedKeyDecision(config) {
  const state = await readPanelState(config);
  if (!state.panelId) {
    // Schluessel da, Anmeldung fehlt: die letzte Kopplung brach nach dem
    // Abholen ab. Nachholen, ohne einen neuen Code zu brauchen.
    say("Schlüssel ist vorhanden, die Anmeldung bei DZPage fehlt noch. Hole sie nach …");
    const registered = await adoptAndRegister(config, config.dzpage.key, "", { stored: true });
    if (!registered.rejected) return "linked";
    say(rejectedNotice(registered.rejected));
    return "replace";
  }
  const check = await checkStoredKey(config, { panelId: state.panelId, serverCount: state.serverCount });
  if (check.status === "rejected") {
    await withDatabase(config, (db) => markKeyRejected(db, check.code, { source: "cli" }));
    say(rejectedNotice(check.code));
    return "replace";
  }
  if (check.status === "unknown" && state.rejection) {
    say(rejectedNotice(state.rejection.code));
    return "replace";
  }
  const account = state.account ? ` (Konto ${plain(state.account)})` : "";
  if (state.rejection) {
    // Der Vermerk war veraltet (etwa ein von Hand ersetzter Schluessel), aber
    // Herzschlag und Abholer haben seinetwegen angehalten.
    await withDatabase(config, (db) => clearKeyRejected(db));
    say(`DZPage nimmt den gespeicherten Schlüssel wieder an${account}. Das Panel verbindet sich neu.`);
    return "linked";
  }
  say(`Dieser Server ist schon mit DZPage verbunden${account}.`);
  if (check.status === "unknown") say(`Den Schlüssel konnte DZPage gerade nicht bestätigen (${check.code}).`);
  say("Mit einem anderen Konto verbinden: sudo dzpage-panel link --force");
  return "connected";
}

async function link(config, args) {
  const force = args.includes("--force");
  const assumeYes = args.includes("--yes");
  const tokenIndex = args.indexOf("--token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : null;
  if (tokenIndex >= 0 && !token) fail("Nach --token fehlt der Kopplungscode von dzpage.com.");

  // Mit --force ersetzt ein neuer Schluessel einen noch gueltigen. Den alten
  // gibt das Panel danach frei, sonst belegte er auf dzpage.com weiter einen
  // der zehn Plaetze, ohne dass ihn noch jemand benutzt.
  let previous = null;
  if (config.dzpage.key && force) {
    previous = { key: config.dzpage.key, panelId: (await readPanelState(config)).panelId };
  }
  if (config.dzpage.key && !force) {
    const decision = await storedKeyDecision(config);
    if (decision === "linked") return;
    if (decision === "connected") process.exit(3);
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
  if (!(await confirmAccount(granted.account, assumeYes))) await declineKey(config, granted.key);
  await adoptAndRegister(config, granted.key, granted.account);
  if (previous && previous.key !== granted.key) await releaseOldKey(config, previous);
}

const OLD_KEY = { nom: "Der alte Schlüssel", acc: "Den alten Schlüssel" };
const OWN_KEY = { nom: "Der DZPage-Schlüssel dieser Maschine", acc: "Den DZPage-Schlüssel dieser Maschine" };

/**
 * Einen Schluessel freigeben, den diese Maschine nicht mehr braucht. DZPage
 * widerruft ihn nur, wenn keine andere Maschine ihn benutzt; ein von Hand
 * angelegter kann auf mehreren stecken. Scheitert das, bleibt alles, wie es
 * war, und der Mensch erfaehrt, wo er es selbst erledigt.
 */
async function releaseOldKey(config, { key, panelId }, words = OLD_KEY) {
  const result = await revokeKey(config, key, { panelId });
  const prefix = `${key.slice(0, 16)}…`;
  if (result.ok && result.shared) {
    say(`${words.nom} (${prefix}) bleibt auf dzpage.com aktiv, weil ihn noch eine andere Maschine benutzt.`);
  } else if (result.ok && result.already) {
    say(`${words.nom} (${prefix}) war auf dzpage.com schon widerrufen.`);
  } else if (result.ok) {
    say(`${words.nom} (${prefix}) ist auf dzpage.com widerrufen.`);
  } else {
    say(
      `${words.acc} (${prefix}) konnte das Panel auf dzpage.com nicht widerrufen (${result.code}). ` +
        "Nutzt ihn keine andere Maschine, widerrufe ihn dort unter RCon bei den Panel-Schlüsseln.",
    );
  }
  return result;
}

/**
 * Vor `uninstall --purge`: Die Konfiguration mit dem Schluessel verschwindet
 * gleich. Ohne Widerruf bliebe er auf dzpage.com aktiv, und niemand kann ihn
 * mehr benutzen. Gibt immer 0 zurueck: Das Entfernen geht weiter, auch wenn
 * DZPage gerade nicht erreichbar ist.
 */
async function forgetKey(config) {
  if (!config.dzpage.key) {
    say("Kein DZPage-Schlüssel hinterlegt.");
    return;
  }
  const { panelId } = await readPanelState(config);
  await releaseOldKey(config, { key: config.dzpage.key, panelId }, OWN_KEY);
}

/* ---------------------------------------------------------------- Zustand */

/** Datum und Uhrzeit in der Zeitzone der Maschine. */
function formatTime(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function ago(ms) {
  const minutes = Math.round(Math.max(0, Date.now() - ms) / 60_000);
  if (minutes < 1) return "vor weniger als einer Minute";
  if (minutes < 90) return minutes === 1 ? "vor 1 Minute" : `vor ${minutes} Minuten`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `vor ${hours} Stunden`;
  return `vor ${Math.round(hours / 24)} Tagen`;
}

/**
 * Die Zeile "DZPage:" von "dzpage-panel status". Ein Schluessel in panel.json
 * heisst noch nicht verbunden: Massgeblich sind die Ablehnung, die Herzschlag
 * und Abholer vermerken, und der letzte gelungene Herzschlag.
 */
async function dzpageStatus(config) {
  if (!config.dzpage.key) return "nicht verbunden (sudo dzpage-panel link)";
  let state;
  try {
    state = await readPanelState(config);
  } catch (err) {
    return `Schlüssel hinterlegt, Zustand nicht lesbar (${plain(err.message)})`;
  }
  if (state.rejection) {
    const why = state.rejection.code === "revoked" ? "auf dzpage.com widerrufen" : "DZPage kennt ihn nicht";
    const since = state.rejection.at ? ` seit ${formatTime(state.rejection.at)}` : "";
    return `Schlüssel abgelehnt (${why})${since}. Neu verbinden: sudo dzpage-panel link`;
  }
  if (!state.panelId) return "Schlüssel hinterlegt, Anmeldung bei DZPage fehlt (sudo dzpage-panel link)";
  const account = state.account ? ` (Konto ${plain(state.account)})` : "";
  if (!state.lastSeenAt) return `Schlüssel hinterlegt${account}, noch kein Kontakt mit DZPage`;
  const contact = `letzter Kontakt ${formatTime(state.lastSeenAt)} (${ago(state.lastSeenAt)})`;
  // Drei verpasste Herzschlaege, mindestens fuenf Minuten: Ein Neustart des
  // Dienstes allein soll nicht nach Stoerung aussehen.
  const staleAfterMs = Math.max(3 * (state.heartbeatSeconds || 60), 300) * 1000;
  if (Date.now() - state.lastSeenAt > staleAfterMs) {
    return `Schlüssel hinterlegt${account}, aber ${contact}. Protokoll: sudo dzpage-panel logs`;
  }
  return `verbunden${account}, ${contact}`;
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
else if (command === "dzpage-status") say(await dzpageStatus(config));
else if (command === "forget-key") await forgetKey(config);
else if (command === "steam-login") await steamLogin(config, rest[0]);
else fail("Aufruf: dzpage-panel-admin.js link [--token ...] [--force] | dzpage-status | steam-login <konto> | reset-password [benutzer]");
