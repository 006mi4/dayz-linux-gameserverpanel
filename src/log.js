/**
 * Protokoll fuer journald: eine Zeile je Ereignis auf stdout, ohne eigene
 * Zeitstempel — die setzt journald selbst. Keine Anfrage-Koerper, keine
 * Kopfzeilen, keine Eingaben aus Formularen: hier darf nie ein Geheimnis
 * landen.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.DZPAGE_PANEL_LOG_LEVEL || "info").toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level, message, extra) {
  if (LEVELS[level] < threshold) return;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  const line = `[${level}] ${message}${suffix}\n`;
  if (level === "error" || level === "warn") process.stderr.write(line);
  else process.stdout.write(line);
}

export const log = {
  debug: (message, extra) => emit("debug", message, extra),
  info: (message, extra) => emit("info", message, extra),
  warn: (message, extra) => emit("warn", message, extra),
  error: (message, extra) => emit("error", message, extra),
};
