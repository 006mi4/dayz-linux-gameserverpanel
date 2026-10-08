import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { CONFIG_FILE, SQLITE_FILE } from "./paths.js";
import { log } from "./log.js";

/**
 * Die Panel-Konfiguration. Sie enthaelt die Geheimnisse (Sitzungsschluessel,
 * Verschluesselungsschluessel fuer RCon-Passwoerter, DZPage-Schluessel) und
 * liegt deshalb mit 0600 im Dateisystem — nicht in der Datenbank, damit ein
 * Datenbank-Backup allein nichts preisgibt.
 */

export const DEFAULT_PORT = 8410;

function defaults() {
  return {
    version: 1,
    /** Standard 127.0.0.1: wer die Oberflaeche von aussen will, setzt einen Reverse-Proxy mit TLS davor. */
    bind: "127.0.0.1",
    port: DEFAULT_PORT,
    /** "auto" setzt das Secure-Flag, sobald die Anfrage ueber HTTPS kam (Reverse-Proxy). */
    cookieSecure: "auto",
    /** Nur einschalten, wenn wirklich ein Proxy davorsteht — sonst luegt X-Forwarded-For. */
    trustProxy: false,
    database: null,
    secrets: { session: null, encryption: null },
    dzpage: { baseUrl: "https://dzpage.com", key: null, panelName: null },
    steam: { steamcmdPath: null },
  };
}

function mergeSection(base, override) {
  if (!override || typeof override !== "object") return base;
  return { ...base, ...override };
}

/** Datei lesen; fehlt sie, gilt der Standard. Andere Fehler werden nicht verschluckt. */
function readConfigFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      throw new Error(`Konfiguration ${file} ist kein gueltiges JSON: ${err.message}`);
    }
    throw err;
  }
}

export function loadConfig({ file = CONFIG_FILE, generateSecrets = true } = {}) {
  const raw = readConfigFile(file);
  const base = defaults();
  const config = {
    ...base,
    ...(raw || {}),
    secrets: mergeSection(base.secrets, raw?.secrets),
    dzpage: mergeSection(base.dzpage, raw?.dzpage),
    steam: mergeSection(base.steam, raw?.steam),
    database: raw?.database ?? null,
  };
  config.file = file;

  const portOverride = Number(process.env.DZPAGE_PANEL_PORT || "");
  if (Number.isInteger(portOverride) && portOverride > 0 && portOverride < 65536) config.port = portOverride;
  if (process.env.DZPAGE_PANEL_BIND) config.bind = process.env.DZPAGE_PANEL_BIND;
  if (process.env.DZPAGE_BASE_URL) config.dzpage.baseUrl = process.env.DZPAGE_BASE_URL;
  // Setzt die HTTPS-Einrichtung (https.sh) als Ergaenzung der systemd-Unit,
  // sobald Caddy davorsteht. Ohne das saehe das Panel jede Anfrage als
  // http von 127.0.0.1, und die Herkunftspruefung wiese jedes Formular ab.
  // Nicht aufzaehlbar, damit saveConfig es nicht in panel.json festschreibt:
  // Schaltet jemand HTTPS wieder ab, soll die Einstellung mit verschwinden.
  if (process.env.DZPAGE_PANEL_TRUST_PROXY === "1") {
    Object.defineProperty(config, "trustProxyEnv", { value: true, enumerable: false });
  }

  validate(config);

  if (raw && isWorldReadable(file)) {
    log.warn(`Konfiguration ${file} ist fuer andere Benutzer lesbar — bitte "chmod 600" setzen.`);
  }

  let changed = false;
  if (generateSecrets) {
    if (!config.secrets.session) {
      config.secrets.session = randomBytes(32).toString("base64");
      changed = true;
    }
    if (!config.secrets.encryption) {
      config.secrets.encryption = randomBytes(32).toString("base64");
      changed = true;
    }
  }
  if (changed) saveConfig(config);
  return config;
}

function validate(config) {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Ungueltiger Port in der Konfiguration: ${config.port}`);
  }
  if (typeof config.bind !== "string" || !config.bind) {
    throw new Error("Ungueltige Bindeadresse in der Konfiguration.");
  }
  if (config.database && !["sqlite", "mysql"].includes(config.database.kind)) {
    throw new Error(`Unbekannte Datenbankart: ${config.database.kind}`);
  }
  if (!/^https?:\/\//.test(config.dzpage.baseUrl)) {
    throw new Error(`Ungueltige DZPage-Adresse: ${config.dzpage.baseUrl}`);
  }
}

function isWorldReadable(file) {
  try {
    return (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/**
 * Atomar schreiben: erst eine Nebendatei mit 0600, dann umbenennen. Ein
 * abgebrochener Schreibvorgang darf keine halbe Konfiguration hinterlassen,
 * und zwischen Anlegen und chmod darf kein Zeitfenster mit 0644 liegen.
 */
export function saveConfig(config) {
  const file = config.file || CONFIG_FILE;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o750 });

  const { file: _ignored, ...persisted } = config;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* Nebendatei war nie da */
    }
    throw err;
  }
  return config;
}

/** Standard-Datenbankeinstellung fuer den bequemen Weg. */
export function sqliteDefaults() {
  return { kind: "sqlite", file: SQLITE_FILE };
}
