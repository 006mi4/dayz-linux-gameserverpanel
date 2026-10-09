import { readFileSync } from "node:fs";
import { INSTALL_FILE } from "../paths.js";

/**
 * Texte im Terminal: install.sh, dzpage-panel, Deinstallation, HTTPS und das
 * Verwaltungsprogramm. Anders als die Oberflaeche (en.js, de.js) stehen sie in
 * Textdateien, eine je Sprache unter terminal/, eine Zeile je Text:
 * schluessel=text. So liest bash (helper/i18n.sh) dieselben Dateien wie Node,
 * und beide muessen die Sprache gleich bestimmen.
 *
 * Die zehn Sprachen von dzpage.com. Ohne Angabe Englisch: Auf einem
 * gemieteten Server steht LANG meist auf C.UTF-8.
 */

export const TERMINAL_LOCALES = ["en", "de", "fr", "es", "it", "ru", "pl", "cs", "pt", "zh"];
export const TERMINAL_DIR = new URL("./terminal/", import.meta.url);

/** Eine der Sprachen oder null. Nimmt auch de_DE.UTF-8, pt-BR und DE. */
export function normalizeLocale(value) {
  const tag = String(value ?? "").split(/[_.@-]/)[0].toLowerCase();
  return TERMINAL_LOCALES.includes(tag) ? tag : null;
}

/** Wie i18n_from_env in bash: nur die erste gesetzte Variable zaehlt. */
export function localeFromEnv(env = process.env) {
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    if (env[name]) return normalizeLocale(env[name]);
  }
  return null;
}

/** Die bei der Installation gemerkte Sprache aus install.json, sonst null. */
export function storedLocale(file = INSTALL_FILE) {
  try {
    return normalizeLocale(JSON.parse(readFileSync(file, "utf8"))?.lang);
  } catch {
    return null;
  }
}

/**
 * Ausdruecklich angegeben (DZPAGE_PANEL_LANG, die setzt dzpage-panel fuer
 * uns), bei der Installation gemerkt, aus der Umgebung, sonst Englisch.
 */
export function terminalLocale({ env = process.env, installFile = INSTALL_FILE } = {}) {
  return normalizeLocale(env.DZPAGE_PANEL_LANG) || storedLocale(installFile) || localeFromEnv(env) || "en";
}

/** Wie i18n_load in bash: Kommentare und Zeilen ohne "=" zaehlen nicht. */
export function parseCatalog(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function readCatalog(locale) {
  try {
    return parseCatalog(readFileSync(new URL(`${locale}.txt`, TERMINAL_DIR), "utf8"));
  } catch {
    return {};
  }
}

/** {name} durch den Wert ersetzen, in einem Durchgang wie t in bash. */
export function fillText(text, vars = {}) {
  return text.replace(/\{([a-z_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Ja in jeder der zehn Sprachen, egal welche gerade eingestellt ist: Wer auf
 * einer englischen Installation "ja" oder "да" tippt, meint ja. Kein Wort hier
 * heisst in einer der Sprachen nein. Leer (Enter) ist die Voreinstellung.
 */
const YES_WORDS = new Set([
  "", "y", "yes", "j", "ja", "o", "oui", "s", "si", "sí", "sì", "sim",
  "t", "tak", "a", "ano", "д", "да", "是", "是的", "好", "对",
]);

export function isYes(answer) {
  return YES_WORDS.has(String(answer ?? "").trim().toLowerCase());
}

/** Sprachen ohne Leerzeichen zwischen Woertern. */
const UNSPACED = new Set(["zh"]);

/**
 * Uebersetzungsfunktion fuer eine Sprache. Fehlt ein Text dort, gilt der
 * englische; fehlt er auch da, kommt der Schluessel selbst zurueck.
 */
export function terminalTranslator(locale) {
  const texts = { ...readCatalog("en"), ...(locale === "en" ? {} : readCatalog(locale)) };
  const t = (key, vars) => fillText(texts[key] ?? key, vars);
  t.locale = locale;
  /**
   * Ein Satzteil, der in einen anderen Text eingesetzt wird (" (Konto X)").
   * Chinesisch trennt Woerter nicht durch Leerzeichen, alle anderen schon;
   * im Katalog selbst darf am Rand keins stehen.
   */
  t.part = (key, vars) => `${UNSPACED.has(locale) ? "" : " "}${t(key, vars)}`;
  return t;
}
