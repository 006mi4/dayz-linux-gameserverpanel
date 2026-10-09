#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
import { isYes, terminalLocale, terminalTranslator } from "../src/i18n/terminal.js";

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
 * und DZPage nimmt den gespeicherten Schluessel noch an), 4 an der Kontofrage
 * verneint, abgebrochen oder unbeantwortet (auf der Maschine aendert sich
 * nichts; install.sh versucht es dann nicht noch einmal mit Link und Code).
 *
 * Ausgaben in der Sprache der Installation (src/i18n/terminal); dzpage-panel
 * gibt sie in DZPAGE_PANEL_LANG mit.
 */

const t = terminalTranslator(terminalLocale());

const EXIT_DECLINED = 4;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------ Passwort */

async function resetPassword(config, wanted) {
  if (!config.database) fail(t("admin.no_database"));
  const db = await openDatabase(config.database);
  try {
    let user;
    if (wanted) {
      user = await findUserByUsername(db, wanted);
      if (!user) fail(t("admin.no_such_user", { user: wanted }));
    } else {
      const users = await db.all("SELECT id, username FROM users ORDER BY created_at ASC", []);
      if (!users.length) fail(t("admin.no_admin"));
      if (users.length > 1) fail(t("admin.many_users", { users: users.map((u) => u.username).join(", ") }));
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
    say(t("admin.new_password", { user: user.username, password }));
    say(t("admin.sessions_ended"));
  } finally {
    await db.close().catch(() => undefined);
  }
}

/* -------------------------------------------------------------- Kopplung */

const PAIR_ERRORS = {
  invalid_token: "admin.pair.invalid_token",
  expired_token: "admin.pair.expired_token",
  denied: "admin.pair.denied",
  expired: "admin.pair.expired",
  rate_limited: "admin.pair.rate_limited",
  network: "admin.pair.network",
  limit_reached: "admin.pair.limit_reached",
};

function pairError(result) {
  if (Object.hasOwn(PAIR_ERRORS, result.code)) return t(PAIR_ERRORS[result.code]);
  return t("admin.pair.failed", { code: `${result.code}${result.status ? `, ${result.status}` : ""}` });
}

/** Was von DZPage kommt, geht ohne Steuerzeichen ins Terminal. */
function plain(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

/** Strg+C, Strg+D oder ein aufgelegtes Terminal an der Rueckfrage. */
const ABORTED = Symbol("abgebrochen");
/** Niemand hat innerhalb von ANSWER_SECONDS geantwortet. */
const TIMED_OUT = Symbol("keine Antwort");
const PROMPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** So lange wartet die Rueckfrage; danach gilt sie als verneint. Die Tests kuerzen das. */
const ANSWER_SECONDS = (() => {
  const wanted = Number(process.env.DZPAGE_PANEL_ANSWER_SECONDS);
  return Number.isInteger(wanted) && wanted >= 1 && wanted <= 3600 ? wanted : 300;
})();

/**
 * Die Frage stellt eine kleine bash, Node wartet nur auf ihr Ergebnis.
 *
 * Der Grund ist "curl ... | sudo bash": Ist stdin von sudo eine Pipe, startet
 * sudo (Vorgabe use_pty auf Ubuntu und Debian) den Befehl als Hintergrund-
 * Prozessgruppe in einem eigenen Terminal und reicht Tastatureingaben erst
 * durch, wenn der Befehl das Terminal anfasst und dafuer SIGTTIN oder SIGTTOU
 * bekommt. Node wartet per epoll darauf, dass Daten da sind, und loest beides
 * nie aus; die Frage hing fuer immer. Ein "read -t" hilft allein auch nicht:
 * bash 5.2 (Ubuntu 24.04, Debian 12 und 13) wartet dabei erst per select und
 * liest nie. Deshalb setzt die bash zuerst die Terminal-Einstellungen auf
 * genau die, die schon gelten. Das aendert nichts, ist aber aus dem
 * Hintergrund heraus ein SIGTTOU, und sudo holt den Befehl in den Vordergrund.
 * Gemessen mit sudo 1.9.9/bash 5.1 und sudo 1.9.15/bash 5.2.
 *
 * Blockierend in Node zu lesen hielte dagegen Strg+C auf, bis jemand Enter
 * drueckt; so bleibt Node frei fuer Signale und das Zeitlimit.
 *
 * Was vor der Frage als ganze Zeile getippt wurde, etwa ein Enter waehrend des
 * Wartens auf die Bestaetigung, ist keine Antwort darauf und wird verworfen;
 * sudo reicht es erst nach dem Wechsel in den Vordergrund nach, deshalb die
 * kurze Schleife danach.
 *
 * Exit: 0 mit der Antwort auf stdout, 1 Strg+D oder Terminal weg, 3 kein
 * Terminal, 124 keine Antwort in der Frist.
 */
const ASK_SCRIPT = `
exec 3<>/dev/tty || exit 3
settings=$(stty -g <&3 2>/dev/null) && stty "$settings" <&3 2>/dev/null
while IFS= read -r -t 0.3 _ <&3; do :; done
printf '%s' "$1" >&3
IFS= read -r -t "$2" answer <&3
rc=$?
[ "$rc" -gt 128 ] && exit 124
[ "$rc" -eq 0 ] || exit 1
printf '%s' "$answer"
`;

/** Text direkt ins Terminal, etwa der Zeilenumbruch nach Strg+C. Ohne Terminal: nichts. */
function toTerminal(text) {
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* Terminal schon weg */
  }
}

/**
 * Eine Frage direkt an das Terminal, nicht an stdin: Bei "curl ... | sudo bash"
 * ist stdin das Skript. Ohne Terminal (Automatisierung) gibt es keine Antwort
 * (null), und dann gilt die Voreinstellung. Sonst die Antwort, ABORTED oder
 * TIMED_OUT.
 */
function askTerminal(question) {
  try {
    closeSync(openSync("/dev/tty", "r+"));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let answer = "";
    let done = false;
    let child = null;
    let safety = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      for (const signal of PROMPT_SIGNALS) process.off(signal, onSignal);
      clearTimeout(safety);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(value);
    };
    const onSignal = () => {
      toTerminal("\n");
      finish(ABORTED);
    };
    for (const signal of PROMPT_SIGNALS) process.on(signal, onSignal);
    // Ohne den eigenen Prozess bleibt die Frage sonst offen, falls bash ihre
    // Frist nicht einhaelt (angehalten, Terminal haengt).
    safety = setTimeout(() => finish(TIMED_OUT), (ANSWER_SECONDS + 30) * 1000);
    // Eigene, leere Umgebung: bash liest dann auch kein BASH_ENV.
    child = spawn("bash", ["-c", ASK_SCRIPT, "dzpage-panel-ask", question, String(ANSWER_SECONDS)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      answer += chunk;
    });
    child.on("error", () => finish(ABORTED));
    child.on("close", (code) => {
      if (code === 0) finish(answer.trim());
      else if (code === 124) finish(TIMED_OUT);
      else if (code === 3) finish(null);
      else finish(ABORTED);
    });
  });
}

/**
 * Wie bei AirDrop die Frage auf der empfangenden Seite: Bevor der Schluessel
 * gilt, steht im Terminal, an welches Konto der Server gebunden wird. Wer den
 * Kurzcode etwa von einem Screenshot abliest und schneller bestaetigt als der
 * Besitzer, faellt genau hier auf. Verbunden wird nur auf ein klares Ja (oder
 * Enter); wer abbricht, etwas anderes tippt oder nicht antwortet, hat nicht
 * zugestimmt.
 */
async function confirmAccount(account, assumeYes) {
  if (assumeYes) return true;
  const answer = await askTerminal(`\n${t("admin.confirm_account", { account: plain(account) || "?" })} `);
  if (answer === null) return true;
  if (answer === ABORTED) return false;
  if (answer === TIMED_OUT) {
    toTerminal(`\n${t("admin.no_answer", { duration: answerDuration() })}\n`);
    return false;
  }
  return isYes(answer);
}

/** "5 Minuten", "2 Sekunden": Einheit und Mehrzahl je Sprache liefert Intl. */
function answerDuration() {
  const minutes = Math.round(ANSWER_SECONDS / 60);
  const [value, unit] = minutes >= 1 ? [minutes, "minute"] : [ANSWER_SECONDS, "second"];
  return new Intl.NumberFormat(t.locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
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
      say(t("admin.revoking"));
    } catch {
      /* Terminal schon weg */
    }
    revoked = await revokeKey(config, key);
  } finally {
    for (const signal of PROMPT_SIGNALS) process.off(signal, ignore);
  }
  if (revoked.ok) fail(t("admin.declined_revoked"), EXIT_DECLINED);
  fail(t("admin.declined_not_revoked", { key: `${key.slice(0, 16)}…`, code: revoked.code }), EXIT_DECLINED);
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
  return code === "revoked" ? t("admin.key_revoked") : t("admin.key_unknown");
}

/** " (Konto Name)" hinter einer Aussage, oder nichts (Leerzeichen je Sprache, siehe t.part). */
function accountSuffix(account) {
  return account ? t.part("admin.account_suffix", { account: plain(account) }) : "";
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
        fail(t("admin.register_failed", { code: adopted.code }));
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
    say(t("admin.linked", { account: plain(account) }));
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
    say(t("admin.register_pending"));
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
  const account = accountSuffix(state.account);
  if (state.rejection) {
    // Der Vermerk war veraltet (etwa ein von Hand ersetzter Schluessel), aber
    // Herzschlag und Abholer haben seinetwegen angehalten.
    await withDatabase(config, (db) => clearKeyRejected(db));
    say(t("admin.key_accepted_again", { account }));
    return "linked";
  }
  say(t("admin.already_linked", { account }));
  if (check.status === "unknown") say(t("admin.check_unknown", { code: check.code }));
  say(t("admin.other_account"));
  return "connected";
}

async function link(config, args) {
  const force = args.includes("--force");
  const assumeYes = args.includes("--yes");
  const tokenIndex = args.indexOf("--token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : null;
  if (tokenIndex >= 0 && !token) fail(t("admin.token_missing"));

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
    if (!isPairToken(token)) fail(t(PAIR_ERRORS.invalid_token));
    say(t("admin.redeeming"));
    const result = await redeemPairToken(config, token);
    if (!result.ok) fail(pairError(result));
    granted = { key: result.key, account: result.account ?? "" };
  } else {
    const started = await startDevicePairing(config);
    if (!started.ok) fail(pairError(started));
    say("");
    say(t("admin.device.intro"));
    say("");
    say(`    ${plain(started.verificationUrl)}`);
    say("");
    say(t("admin.device.code", { code: plain(started.userCode) }));
    say(t("admin.device.wait", { minutes: Math.round((Number(started.expiresIn) || 900) / 60) }));
    const result = await waitForApproval(config, started);
    if (!result.ok) fail(pairError(result));
    granted = result;
  }

  if (!isPanelKey(granted.key)) fail(t("admin.unexpected"));
  if (!(await confirmAccount(granted.account, assumeYes))) await declineKey(config, granted.key);
  await adoptAndRegister(config, granted.key, granted.account);
  if (previous && previous.key !== granted.key) await releaseOldKey(config, previous);
}

// Ganze Saetze je Ausgang statt eines eingesetzten Satzteils: Andere Sprachen
// beugen "der alte Schluessel" anders oder stellen ihn woanders hin.
const OLD_KEY = {
  shared: "admin.release.old.shared",
  already: "admin.release.old.already",
  revoked: "admin.release.old.revoked",
  failed: "admin.release.old.failed",
};
const OWN_KEY = {
  shared: "admin.release.own.shared",
  already: "admin.release.own.already",
  revoked: "admin.release.own.revoked",
  failed: "admin.release.own.failed",
};

/**
 * Einen Schluessel freigeben, den diese Maschine nicht mehr braucht. DZPage
 * widerruft ihn nur, wenn keine andere Maschine ihn benutzt; ein von Hand
 * angelegter kann auf mehreren stecken. Scheitert das, bleibt alles, wie es
 * war, und der Mensch erfaehrt, wo er es selbst erledigt.
 */
async function releaseOldKey(config, { key, panelId }, texts = OLD_KEY) {
  const result = await revokeKey(config, key, { panelId });
  const prefix = `${key.slice(0, 16)}…`;
  const outcome = !result.ok ? "failed" : result.shared ? "shared" : result.already ? "already" : "revoked";
  say(t(texts[outcome], { key: prefix, code: result.code }));
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
    say(t("admin.no_key"));
    return;
  }
  const { panelId } = await readPanelState(config);
  await releaseOldKey(config, { key: config.dzpage.key, panelId }, OWN_KEY);
}

/* ---------------------------------------------------------------- Zustand */

/** Datum und Uhrzeit in der Zeitzone der Maschine, Reihenfolge je Sprache. */
function formatTime(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return t("admin.datetime", {
    year: d.getFullYear(),
    month: two(d.getMonth() + 1),
    day: two(d.getDate()),
    hour: two(d.getHours()),
    minute: two(d.getMinutes()),
  });
}

/**
 * "vor 5 Minuten" in der Sprache der Installation. Die Mehrzahlformen (im
 * Russischen, Polnischen und Tschechischen drei) liefert Intl; eine Node ohne
 * diese Sprachdaten antwortet auf Englisch statt gar nicht.
 */
function ago(ms) {
  const minutes = Math.round(Math.max(0, Date.now() - ms) / 60_000);
  if (minutes < 1) return t("admin.ago_now");
  const relative = new Intl.RelativeTimeFormat(t.locale, { numeric: "always" });
  if (minutes < 90) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 36) return relative.format(-hours, "hour");
  return relative.format(-Math.round(hours / 24), "day");
}

/**
 * Die Zeile "DZPage:" von "dzpage-panel status". Ein Schluessel in panel.json
 * heisst noch nicht verbunden: Massgeblich sind die Ablehnung, die Herzschlag
 * und Abholer vermerken, und der letzte gelungene Herzschlag.
 */
async function dzpageStatus(config) {
  if (!config.dzpage.key) return t("admin.status.not_linked");
  let state;
  try {
    state = await readPanelState(config);
  } catch (err) {
    return t("admin.status.unreadable", { error: plain(err.message) });
  }
  if (state.rejection) {
    const since = state.rejection.at ? t.part("admin.status.since", { time: formatTime(state.rejection.at) }) : "";
    const key = state.rejection.code === "revoked" ? "admin.status.rejected_revoked" : "admin.status.rejected_unknown";
    return t(key, { since });
  }
  if (!state.panelId) return t("admin.status.not_registered");
  const account = accountSuffix(state.account);
  if (!state.lastSeenAt) return t("admin.status.no_contact", { account });
  const contact = { account, time: formatTime(state.lastSeenAt), ago: ago(state.lastSeenAt) };
  // Drei verpasste Herzschlaege, mindestens fuenf Minuten: Ein Neustart des
  // Dienstes allein soll nicht nach Stoerung aussehen.
  const staleAfterMs = Math.max(3 * (state.heartbeatSeconds || 60), 300) * 1000;
  if (Date.now() - state.lastSeenAt > staleAfterMs) return t("admin.status.stale", contact);
  return t("admin.status.connected", contact);
}

/* ------------------------------------------------------------------ Steam */

/**
 * SteamCMD-Anmeldung direkt im Terminal: Passwort und Steam-Guard-Code gehen
 * vom Menschen unmittelbar an SteamCMD, nicht durch dieses Programm und nicht
 * durch DZPage. Gespeichert wird nur, was SteamCMD selbst ablegt.
 */
async function steamLogin(config, account) {
  if (!ACCOUNT_PATTERN.test(account || "")) fail(t("admin.steam.account_needed"));
  const steps = { download: "admin.steam.downloading", unpack: "admin.steam.unpacking" };
  const quietJob = {
    append: (text) => process.stdout.write(`${String(text).trim()}\n`),
    step: (name, vars) => say(t(steps[name] ?? name, vars)),
  };
  const found = await ensureSteamCmd(config, quietJob);
  mkdirSync(STEAM_HOME, { recursive: true, mode: 0o750 });

  say(t("admin.steam.signing_in", { account }));
  say(t("admin.steam.first_start"));
  const code = await new Promise((resolve) => {
    const child = spawn(found.path, ["+login", account, "+quit"], {
      stdio: "inherit",
      env: { HOME: STEAM_HOME, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: process.env.TERM || "xterm" },
    });
    child.on("error", () => resolve(1));
    child.on("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) say(t("admin.steam.exit", { code }));

  const check = await verifySession({ steamcmdPath: found.path, account });
  if (!check.ok) fail(t("admin.steam.not_working", { reason: steamReason(check) }));

  const db = await ensureDatabase(config);
  try {
    await setSetting(db, KEYS.steamAccount, account);
    await setSetting(db, KEYS.steamLoggedInAt, Date.now());
    await recordEvent(db, { kind: "steam.login", source: "cli", message: `Bei Steam angemeldet als ${account}` });
  } finally {
    await db.close().catch(() => undefined);
  }
  say(t("admin.steam.done", { account }));
}

/** Warum die Anmeldung nicht traegt. Den Text von Steam selbst gibt es nur auf Englisch. */
function steamReason(check) {
  if (check.code === "session") return t("admin.steam.reason_session");
  if (check.code === "unconfirmed") return t("admin.steam.reason_unconfirmed");
  if (check.code === "account") return t("admin.steam.account_needed");
  return plain(check.message);
}

/* ---------------------------------------------------------------- Aufruf */

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig({ generateSecrets: true });

if (command === "reset-password") await resetPassword(config, rest[0]);
else if (command === "link") await link(config, rest);
else if (command === "dzpage-status") say(await dzpageStatus(config));
else if (command === "forget-key") await forgetKey(config);
else if (command === "steam-login") await steamLogin(config, rest[0]);
else fail(t("admin.usage"));
