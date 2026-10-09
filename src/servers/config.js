import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverDir } from "../store/servers.js";

/**
 * Die Dateien, die ein DayZ-Server zum Starten braucht.
 *
 * Der Inhalt ist an einem laufenden Server abgeglichen, nicht aus dem
 * Gedaechtnis geschrieben — drei Punkte daraus kosten sonst Stunden:
 *
 * - BattlEye liest die Datei je nach Version klein- oder grossgeschrieben.
 *   Deshalb werden beide Schreibweisen abgelegt.
 * - Beim Start benennt BattlEye seine Konfiguration in
 *   beserver_x64_active_<hash>.cfg um und nutzt danach diese. Eine alte aktive
 *   Datei ueberlebt also eine Passwortaenderung und macht sie wirkungslos —
 *   sie muss weg.
 * - Ohne ~/.steam/sdk64/steamclient.so startet der Server nicht. Diesen
 *   Verweis legt das Startskript an.
 */

/* --------------------------------------------------------- serverDZ.cfg */

/**
 * Die Konfiguration eines Servers ist eine geordnete Liste von Paaren, und sie
 * steht in der Datenbank, nicht in der Datei: Das Panel schreibt serverDZ.cfg
 * bei jeder Installation und jedem Update neu, eine Aenderung von Hand waere
 * also spaetestens beim naechsten DayZ-Update verschwunden.
 *
 * Vier Werte gehoeren dem Panel und stehen deshalb nicht in dieser Liste —
 * es braucht sie auch anderswo (Anmeldung bei DZPage, Portpruefung, Anzeige):
 * hostname, maxPlayers, steamQueryPort und die Mission.
 */
export const MANAGED_KEYS = new Set(["hostname", "maxPlayers", "steamQueryPort", "template"]);

/** Schluessel wie in der DayZ-Dokumentation; `motd[]` ist die Ausnahme mit Klammern. */
export const CFG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}(\[\])?$/;

const MAX_VALUE_LENGTH = 200;

/**
 * Der Auslieferungszustand. Er haengt am Server, weil die Warteschlange sich
 * nach der Spielerzahl richtet — alles andere sind die Werte, mit denen ein
 * DayZ-Server ueblicherweise startet.
 */
export function defaultConfig(server = {}) {
  const maxPlayers = Number(server.max_players) || 60;
  return [
    ["password", ""],
    ["passwordAdmin", ""],
    ["verifySignatures", "2"],
    ["forceSameBuild", "1"],
    ["disableVoN", "0"],
    ["disable3rdPerson", "0"],
    ["serverTime", "SystemTime"],
    ["serverTimeAcceleration", "1"],
    ["serverTimePersistent", "0"],
    ["loginQueueConcurrentPlayers", "5"],
    ["loginQueueMaxPlayers", String(Math.max(maxPlayers, 50))],
    ["respawnTime", "5"],
    ["timeStampFormat", "Full"],
    ["instanceId", "1"],
    ["storageAutoFix", "1"],
  ];
}

export function cleanCfgValue(value) {
  // Ein Eintrag ist eine Zeile. Zeilenumbrueche wuerden die Datei zerlegen,
  // deshalb werden sie zu Leerzeichen.
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_VALUE_LENGTH)
    .trim();
}

/**
 * Wie der Wert hinter dem Gleichheitszeichen aussieht.
 *
 * Die Regel ist absichtlich klein und vorhersagbar: Zahlen bleiben nackt,
 * alles andere bekommt Anfuehrungszeichen — es sei denn, es steht schon in
 * Konfigurationsschreibweise. Damit ist auch `motd[] = {"a","b"};` moeglich,
 * ohne dass jemand eine zweite Syntax lernen muss. Was am Ende in der Datei
 * steht, zeigt die Vorschau im Panel.
 */
export function formatCfgValue(value) {
  const text = cleanCfgValue(value);
  if (text === "") return '""';
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  if (text.startsWith("{") || text.startsWith('"')) return text;
  return `"${text.replace(/"/g, "")}"`;
}

/** Ein Paar pruefen. Gibt einen Code zurueck, den die Oberflaeche uebersetzt. */
export function checkCfgEntry(key, value) {
  const name = String(key ?? "").trim();
  if (!name) return { ok: false, code: "cfg_key_empty" };
  if (!CFG_KEY.test(name)) return { ok: false, code: "cfg_key_invalid" };
  if (MANAGED_KEYS.has(name)) return { ok: false, code: "cfg_key_managed" };
  return { ok: true, value: [name, cleanCfgValue(value)] };
}

/**
 * Eine vorhandene serverDZ.cfg lesen.
 *
 * Nur einfache Zeilen `schluessel = wert;` ausserhalb von Bloecken; was in
 * `class … { … }` steht, gehoert dem Panel. Der Wert wird genommen, wie er
 * dasteht — Anfuehrungszeichen inklusive. Damit kommt beim Schreiben wieder
 * genau dieselbe Zeile heraus (formatCfgValue laesst alles durch, was schon in
 * Konfigurationsschreibweise steht).
 */
export function parseCfg(text) {
  const entries = [];
  let depth = 0;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const opened = (line.match(/\{/g) || []).length;
    const closed = (line.match(/\}/g) || []).length;
    const wasInside = depth > 0;
    depth += opened - closed;
    if (wasInside || depth > 0 || /^class\b/.test(line)) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]{0,39}(?:\[\])?)\s*=\s*(.+?);?\s*$/.exec(line);
    if (!match || MANAGED_KEYS.has(match[1])) continue;
    entries.push([match[1], cleanCfgValue(match[2])]);
  }
  return entries;
}

function configFromFile(id) {
  try {
    return parseCfg(readFileSync(join(serverDir(id), "serverDZ.cfg"), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Die gespeicherte Konfiguration eines Servers.
 *
 * Die Reihenfolge der Quellen ist Absicht:
 * 1. Was im Panel eingetragen wurde. Eine leere Liste ist dabei eine Ansage
 *    und bleibt leer.
 * 2. Sonst die vorhandene Datei. Wer sie vor dieser Fassung von Hand angepasst
 *    hat, findet seine Werte im Panel wieder, statt sie beim ersten Speichern
 *    zu verlieren.
 * 3. Sonst der Auslieferungszustand.
 */
export function serverConfig(server) {
  const raw = server?.config_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => Array.isArray(entry) && checkCfgEntry(entry[0], entry[1]).ok)
          .map(([key, value]) => [String(key).trim(), cleanCfgValue(value)]);
      }
    } catch {
      // Kaputtes JSON darf keinen Server unstartbar machen.
    }
  }

  const fromFile = server?.id ? configFromFile(server.id) : [];
  return fromFile.length ? fromFile : defaultConfig(server);
}

export function serverDzCfg(server) {
  const lines = serverConfig(server).map(([key, value]) => `${key} = ${formatCfgValue(value)};`);
  // Der Kopf ist englisch, anders als die Kommentare hier: Diese Datei liegt
  // beim Kunden auf der Platte, und das Panel steht auf Rechnern in aller Welt.
  return `// Written by dzpage-panel. Edit these values in the panel under
// "Game servers -> Configuration". Changes made directly to this file are
// lost the next time the panel writes it.
hostname = ${formatCfgValue(server.name)};
maxPlayers = ${Number(server.max_players)};
steamQueryPort = ${Number(server.query_port)};
${lines.join("\n")}
class Missions
{
    class DayZ
    {
        template = ${formatCfgValue(server.mission)};
    };
};
`;
}

export function battleyeCfg({ rconPassword, rconPort }) {
  if (/\s/.test(rconPassword)) throw new Error("Das RCon-Passwort darf keine Leerzeichen enthalten.");
  return `RConPassword ${rconPassword}\nRConPort ${Number(rconPort)}\nRestrictRCon 0\n`;
}

/** Werte fuer die systemd-Vorlage; systemd liest die Datei selbst, ohne Shell. */
export function serverEnv(server) {
  const cpuCount = Math.max(1, Math.min(16, Math.round(Number(server.cpu_quota) / 100)));
  return `DZ_PORT=${Number(server.game_port)}\nDZ_QUERY_PORT=${Number(server.query_port)}\nDZ_CPU_COUNT=${cpuCount}\n`;
}

/**
 * Alle Dateien schreiben. Wird beim Anlegen und nach jeder Aenderung
 * aufgerufen; vorhandene Spieldaten bleiben unberuehrt.
 */
export function writeServerFiles(server, rconPassword) {
  const dir = serverDir(server.id);
  const battleye = join(dir, "profiles", "battleye");
  mkdirSync(join(dir, "game"), { recursive: true, mode: 0o770 });
  mkdirSync(battleye, { recursive: true, mode: 0o770 });

  writeFileSync(join(dir, "serverDZ.cfg"), serverDzCfg(server), { mode: 0o660 });
  writeFileSync(join(dir, "server.env"), serverEnv(server), { mode: 0o660 });

  const beContent = battleyeCfg({ rconPassword, rconPort: server.rcon_port });
  for (const name of ["beserver_x64.cfg", "BEServer_x64.cfg"]) {
    writeFileSync(join(battleye, name), beContent, { mode: 0o660 });
    chmodSync(join(battleye, name), 0o660);
  }

  // Eine bereits umbenannte Konfiguration wuerde die neue ueberstimmen.
  for (const entry of readdirSync(battleye)) {
    if (/^beserver_x64_active_.*\.cfg$/i.test(entry)) rmSync(join(battleye, entry), { force: true });
  }

  return { dir, battleye };
}
