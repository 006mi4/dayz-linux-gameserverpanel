import { en } from "./en.js";
import { de } from "./de.js";

/**
 * Sprachen der Panel-Oberflaeche. Absichtlich eine flache Zuordnung je Sprache
 * in einer Datei: eine weitere Sprache ist damit eine Datei plus ein Eintrag
 * hier, ohne Bibliothek und ohne Bauschritt.
 *
 * Standard ist Englisch — das Panel landet auf Rechnern in aller Welt.
 */

export const MESSAGES = { en, de };
export const LOCALES = Object.keys(MESSAGES);
export const DEFAULT_LOCALE = "en";
export const LANG_COOKIE = "dzp_panel_lang";

export const LOCALE_NAMES = { en: "English", de: "Deutsch" };

/** Sprache aus Abfrage, Cookie und Accept-Language — in dieser Reihenfolge. */
export function pickLocale({ query, cookie, acceptLanguage } = {}) {
  if (query && LOCALES.includes(query)) return query;
  if (cookie && LOCALES.includes(cookie)) return cookie;
  for (const part of String(acceptLanguage || "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase().slice(0, 2);
    if (LOCALES.includes(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

/**
 * Text holen. Fehlt ein Schluessel in der gewaehlten Sprache, greift Englisch;
 * fehlt er auch dort, kommt der Schluessel selbst zurueck. Ein fehlender Text
 * darf keine leere Seite ergeben.
 */
export function translate(locale, key, vars) {
  const table = MESSAGES[locale] || MESSAGES[DEFAULT_LOCALE];
  let text = table[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Gebundene Uebersetzungsfunktion fuer eine Anfrage. */
export function translator(locale) {
  return (key, vars) => translate(locale, key, vars);
}
