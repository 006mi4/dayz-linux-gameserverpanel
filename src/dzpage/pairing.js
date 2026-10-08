import { hostname } from "node:os";
import { saveConfig, sqliteDefaults } from "../config.js";
import { openDatabase } from "../db/index.js";
import { KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { DzpageClient, PANEL_KEY_PREFIX, platformLabel } from "./client.js";
import { PANEL_VERSION } from "../version.js";

/**
 * Kopplung mit dem DZPage-Konto, so einfach wie moeglich und ohne einen
 * einzigen offenen Port. Zwei Wege, ein Ergebnis (ein eigener Panel-Schluessel):
 *
 * 1. Kopplungscode im Installationsbefehl. Wer auf dzpage.com "Server
 *    verbinden" klickt, bekommt einen Befehl mit einem Einmal-Code
 *    (dzp_pair_...). Das Panel tauscht ihn gegen seinen Schluessel. Der Code
 *    gilt kurz, nur einmal und kann nichts ausser koppeln.
 *
 * 2. Bestaetigung im Browser (Geraete-Verfahren wie beim Fernseher-Login,
 *    RFC 8628). Das Panel holt sich einen kurzen Code, der Mensch oeffnet
 *    dzpage.com/link?code=..., sieht Name und Adresse dieses Servers und
 *    bestaetigt. Das Panel fragt so lange nach, bis die Antwort da ist. Der
 *    lange Geraetecode bleibt auf dieser Maschine; mit dem kurzen allein
 *    bekommt niemand den Schluessel.
 *
 * Beide Anfragen gehen ohne Schluessel hinaus, weil es noch keinen gibt.
 */

export const PAIR_TOKEN_PREFIX = "dzp_pair_";
const PAIR_TOKEN_PATTERN = /^dzp_pair_[A-Za-z0-9_-]{16,128}$/;

function anonymousClient(config) {
  return new DzpageClient({ baseUrl: config.dzpage.baseUrl, key: null });
}

function describeMachine(config) {
  return {
    name: (config.dzpage.panelName || hostname()).slice(0, 60),
    platform: platformLabel(),
    version: PANEL_VERSION,
  };
}

export function isPairToken(value) {
  return PAIR_TOKEN_PATTERN.test(String(value ?? ""));
}

/** Was als Panel-Schluessel zurueckkommt, muss wie einer aussehen, bevor es gespeichert wird. */
export function isPanelKey(value) {
  return /^dzp_panel_[A-Za-z0-9]{16,128}$/.test(String(value ?? ""));
}

/** Weg 1: den Einmal-Code aus dem Installationsbefehl einloesen. */
export async function redeemPairToken(config, token) {
  if (!isPairToken(token)) return { ok: false, code: "invalid_token" };
  return anonymousClient(config).request(
    "POST",
    "/api/panel/v1/pair/redeem",
    { token, ...describeMachine(config) },
    { anonymous: true },
  );
}

/** Weg 2, Beginn: kurzen Code und Bestaetigungsadresse holen. */
export async function startDevicePairing(config) {
  return anonymousClient(config).request("POST", "/api/panel/v1/pair/start", describeMachine(config), {
    anonymous: true,
  });
}

/** Weg 2, Nachfragen: pending, approved (mit Schluessel), denied oder expired. */
export async function pollDevicePairing(config, deviceCode) {
  return anonymousClient(config).request("POST", "/api/panel/v1/pair/poll", { deviceCode }, { anonymous: true });
}

/**
 * Bis zur Antwort nachfragen. `onWait` bekommt jede Runde mit, damit ein
 * Terminal zeigen kann, dass noch gewartet wird.
 */
export async function waitForApproval(config, started, { onWait = () => {}, sleep = defaultSleep } = {}) {
  const intervalMs = Math.max(2, Number(started.interval) || 3) * 1000;
  const until = Date.now() + Math.max(60, Number(started.expiresIn) || 900) * 1000;
  let delay = intervalMs;
  while (Date.now() < until) {
    await sleep(delay);
    const result = await pollDevicePairing(config, started.deviceCode);
    if (!result.ok) {
      // Netz weg oder DZPage kurz nicht da: weiter warten, aber langsamer.
      if (result.code === "network" || result.code === "server" || result.code === "rate_limited") {
        delay = Math.min(delay * 2, 30_000);
        onWait({ status: "retry", code: result.code });
        continue;
      }
      return { ok: false, code: result.code };
    }
    delay = intervalMs;
    if (result.status === "approved") return { ok: true, key: result.key, account: result.account ?? "" };
    if (result.status === "denied") return { ok: false, code: "denied" };
    if (result.status === "expired") return { ok: false, code: "expired" };
    onWait({ status: "pending" });
  }
  return { ok: false, code: "expired" };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ohne Datenbank kein Panel-Zustand. Wer ueber dzpage.com koppelt, durchlaeuft
 * den Assistenten nicht: Dann ist SQLite die Wahl, die der Assistent ohnehin
 * vorschlaegt.
 */
export async function ensureDatabase(config) {
  if (!config.database) {
    config.database = sqliteDefaults();
    saveConfig(config);
  }
  return openDatabase(config.database);
}

/**
 * Einen Schluessel uebernehmen: bei DZPage anmelden, Schluessel und Name in
 * die Konfiguration, Panel-ID in die Datenbank. Derselbe Ablauf wie Schritt 4
 * des Assistenten, nur ohne Formular.
 */
export async function adoptKey({ config, db, key, name = null }) {
  if (typeof key !== "string" || !key.startsWith(PANEL_KEY_PREFIX)) {
    return { ok: false, code: "missing_key" };
  }
  const panelName = (name || config.dzpage.panelName || hostname()).slice(0, 60);
  const result = await new DzpageClient({ baseUrl: config.dzpage.baseUrl, key }).register({ name: panelName });
  if (!result.ok) return result;

  config.dzpage.key = key;
  config.dzpage.panelName = panelName;
  saveConfig(config);
  await setSetting(db, KEYS.dzpagePanelId, result.panelId);
  await setSetting(db, KEYS.dzpageAccount, result.account ?? "");
  await setSetting(db, KEYS.dzpageHeartbeatSeconds, result.heartbeatSeconds ?? 60);
  await setSetting(db, KEYS.dzpageLastSeenAt, Date.now());
  await recordEvent(db, {
    kind: "dzpage.register",
    source: "dzpage",
    message: `Panel bei DZPage angemeldet (${result.account || "Konto unbekannt"})`,
  });
  return { ok: true, panelId: result.panelId, account: result.account ?? "", heartbeatSeconds: result.heartbeatSeconds };
}
