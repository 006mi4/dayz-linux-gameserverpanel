import * as setup from "../routes/setup.js";
import * as auth from "../routes/auth.js";
import * as dashboard from "../routes/dashboard.js";
import * as steam from "../routes/steam.js";
import * as dzpage from "../routes/dzpage.js";

/**
 * Feste Routentabelle. Es gibt keine dynamischen Pfade und keine Platzhalter —
 * jede Aktion des Panels ist eine benannte Operation mit geprueften Parametern,
 * und in der Oberflaeche gibt es kein Feld, in das ein beliebiger Befehl
 * eingegeben werden koennte.
 *
 * access:
 *   public — auch ohne Anmeldung erreichbar
 *   user   — Sitzung noetig
 *   setup  — nur waehrend der Einrichtung (danach 404)
 */
export const ROUTES = [
  { path: "/", methods: ["GET"], access: "public", handler: dashboard.root },
  { path: "/health", methods: ["GET"], access: "public", allowBrokenDb: true, handler: health },

  { path: "/login", methods: ["GET", "POST"], access: "public", handler: auth.login },
  { path: "/logout", methods: ["POST"], access: "user", handler: auth.logout },

  { path: "/setup", methods: ["GET"], access: "setup", handler: setup.index },
  { path: "/setup/database", methods: ["GET", "POST"], access: "setup", handler: setup.database },
  { path: "/setup/admin", methods: ["GET", "POST"], access: "setup", handler: setup.admin },
  { path: "/setup/done", methods: ["GET", "POST"], access: "user", handler: setup.done },

  // Schritt 3 und 4 brauchen eine Sitzung: der Administrator existiert an
  // dieser Stelle schon. Dieselben Masken dienen spaeter zum Nachholen.
  { path: "/steam", methods: ["GET", "POST"], access: "user", handler: steam.page },
  { path: "/steam/status", methods: ["GET", "POST"], access: "user", handler: steam.status },
  { path: "/dzpage", methods: ["GET", "POST"], access: "user", handler: dzpage.connect },
];

/** Fuer den Installer und fuer Ueberwachung: eine Zeile, keine Details. */
async function health(rc) {
  rc.send(200, "ok\n", { "content-type": "text/plain; charset=utf-8" });
}
