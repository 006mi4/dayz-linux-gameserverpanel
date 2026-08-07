import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { log } from "../log.js";
import { pickLocale, translator, LANG_COOKIE, LOCALES } from "../i18n/index.js";
import { escapeHtml, layout } from "./html.js";
import { getSession, SESSION_COOKIE } from "../store/sessions.js";
import { findUserById } from "../store/users.js";
import { ROUTES } from "./routes.js";

/**
 * HTTP-Schicht des Panels: node:http, eine feste Routentabelle, serverseitig
 * gerendertes HTML. Kein Framework, kein Bauschritt.
 *
 * Zwei Dinge sind hier bewusst streng, weil das Panel auf einer fremden
 * Maschine Prozesse startet:
 * - Jede Formularabsendung braucht den CSRF-Wert der Sitzung; ohne das koennte
 *   eine beliebige Webseite im Browser des Angemeldeten Aktionen ausloesen.
 * - Die Inhaltsrichtlinie erlaubt kein JavaScript. Die Oberflaeche braucht
 *   keines, und damit ist eine ganze Fehlerklasse ausgeschlossen.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "..", "public");
const MAX_BODY_BYTES = 16 * 1024;

/** Einmal beim Start lesen: so gibt es keinen Pfad aus der Anfrage ins Dateisystem. */
const ASSETS = {
  "/assets/panel.css": { type: "text/css; charset=utf-8", body: readFileSync(join(PUBLIC_DIR, "panel.css")) },
  "/assets/icon.svg": {
    type: "image/svg+xml",
    body: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" rx="7" fill="#e5273a"/>' +
        '<text x="16" y="22" font-family="system-ui,sans-serif" font-size="15" font-weight="700" ' +
        'text-anchor="middle" fill="#fff">DZ</text></svg>',
      "utf8",
    ),
  },
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // "no-referrer" veranlasst Chrome, bei Formularen "Origin: null" zu senden —
  // die Herkunftspruefung stand dann vor einem Wert, der nach Angriff aussieht.
  // "same-origin" haelt die Adresse trotzdem von fremden Zielen fern.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, secure, httpOnly = true, sameSite = "Strict" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  const existing = res.getHeader("set-cookie");
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(parts.join("; "));
  res.setHeader("set-cookie", list);
}

function clientProtocol(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.encrypted ? "https" : "http";
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return (req.socket.remoteAddress || "").slice(0, 64);
}

async function readForm(req) {
  const type = String(req.headers["content-type"] || "");
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    return { ok: false, code: "content_type" };
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, code: "too_large" };

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, code: "too_large" };
    chunks.push(chunk);
  }
  return { ok: true, form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")) };
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class RequestContext {
  constructor({ req, res, app, url }) {
    this.req = req;
    this.res = res;
    this.app = app;
    this.config = app.config;
    this.url = url;
    this.path = url.pathname;
    this.method = req.method;
    this.cookies = parseCookies(req.headers.cookie);
    this.protocol = clientProtocol(req, app.config);
    this.ip = clientIp(req, app.config);
    this.form = null;
    this.session = null;
    this.user = null;

    const query = url.searchParams.get("lang");
    this.locale = pickLocale({
      query,
      cookie: this.cookies[LANG_COOKIE],
      acceptLanguage: req.headers["accept-language"],
    });
    this.t = translator(this.locale);
    if (query && LOCALES.includes(query) && this.cookies[LANG_COOKIE] !== query) {
      setCookie(res, LANG_COOKIE, query, { maxAge: 180 * 24 * 3600, httpOnly: false, sameSite: "Lax" });
    }
  }

  get secureCookies() {
    if (this.config.cookieSecure === true) return true;
    if (this.config.cookieSecure === false) return false;
    return this.protocol === "https";
  }

  /** CSRF-Wert dieser Anfrage: aus der Sitzung, oder aus dem Assistenten-Zustand. */
  get csrf() {
    return this.session?.csrf || this.app.setup.tokenFor(this);
  }

  setSessionCookie(id) {
    setCookie(this.res, SESSION_COOKIE, id, { maxAge: 14 * 24 * 3600, secure: this.secureCookies });
  }

  clearSessionCookie() {
    setCookie(this.res, SESSION_COOKIE, "", { maxAge: 0, secure: this.secureCookies });
  }

  send(status, body, headers = {}) {
    this.res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    });
    this.res.end(body);
  }

  page(status, title, body, { headers, head } = {}) {
    this.send(
      status,
      layout({
        title,
        locale: this.locale,
        t: this.t,
        user: this.user ? { ...this.user, csrf: this.csrf } : null,
        body,
        path: this.path,
        head,
      }),
      headers,
    );
  }

  redirect(location) {
    this.res.writeHead(303, {
      location,
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    });
    this.res.end();
  }

  error(status, title, text) {
    this.page(
      status,
      title,
      `<div class="card"><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(text)}</p></div>`,
    );
  }

  notFound() {
    this.error(404, this.t("error.notFound"), this.t("error.notFoundText"));
  }
}

/**
 * Zustand des Assistenten vor der ersten Anmeldung. Er liegt im
 * Arbeitsspeicher, weil es vor Schritt 1 noch keine Datenbank gibt, in die man
 * eine Sitzung schreiben koennte.
 */
export class SetupState {
  constructor() {
    this.tokens = new Map();
    this.draft = {};
  }

  tokenFor(rc) {
    const existing = rc.cookies["dzp_panel_setup"];
    if (existing && this.tokens.has(existing)) return this.tokens.get(existing);
    return this.tokens.get(this.issue(rc));
  }

  issue(rc) {
    const id = randomToken();
    const token = randomToken();
    this.tokens.set(id, token);
    // Nur ein Assistent gleichzeitig: aeltere Kennungen wegwerfen, damit die
    // Zuordnung nicht unbegrenzt waechst.
    if (this.tokens.size > 8) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== id) this.tokens.delete(oldest);
    }
    setCookie(rc.res, "dzp_panel_setup", id, { maxAge: 3600, secure: rc.secureCookies });
    rc.cookies["dzp_panel_setup"] = id;
    return id;
  }
}

function randomToken() {
  return randomBytes(18).toString("base64url");
}


/**
 * Zugangsregeln je Route.
 *
 * "setup" gilt fuer die beiden Schritte, die es noch ohne Konto geben muss
 * (Datenbank, Administrator). Sobald der Assistent durch ist, liefern sie 404
 * statt einer Anmeldemaske — sonst koennte jemand, der spaeter an den Port
 * kommt, das Panel uebernehmen. Existiert bereits ein Administrator, der
 * Assistent aber noch nicht fertig, fuehrt der Weg ueber die Anmeldung: das
 * ist keine Uebernahme, sondern die Fortsetzung durch den Eigentuemer.
 */
async function passesAccessGate(rc, route) {
  if (route.access === "public") return true;

  if (route.access === "user") {
    if (rc.user) return true;
    rc.redirect(`/login?next=${encodeURIComponent(rc.path)}`);
    return false;
  }

  if (route.access === "setup") {
    const state = await rc.app.setupProgress();
    if (state.completed) {
      rc.notFound();
      return false;
    }
    if (state.hasAdmin && !rc.user) {
      rc.redirect(`/login?next=${encodeURIComponent(rc.path)}`);
      return false;
    }
    return true;
  }

  rc.notFound();
  return false;
}

async function resolveUser(rc) {
  if (!rc.app.db) return;
  const id = rc.cookies[SESSION_COOKIE];
  if (!id) return;
  const session = await getSession(rc.app.db, id);
  if (!session) {
    if (id) rc.clearSessionCookie();
    return;
  }
  const user = await findUserById(rc.app.db, session.user_id);
  if (!user) {
    rc.clearSessionCookie();
    return;
  }
  rc.session = session;
  rc.user = { id: user.id, username: user.username };
}

export function createHttpServer(app) {
  const server = createServer(async (req, res) => {
    let rc;
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      rc = new RequestContext({ req, res, app, url });

      const asset = ASSETS[rc.path];
      if (asset) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          rc.error(405, rc.t("error.method"), rc.t("error.method"));
          return;
        }
        res.writeHead(200, {
          "content-type": asset.type,
          "cache-control": "public, max-age=300",
          ...SECURITY_HEADERS,
        });
        res.end(req.method === "HEAD" ? undefined : asset.body);
        return;
      }

      const route = ROUTES.find((entry) => entry.path === rc.path);
      if (!route) {
        rc.notFound();
        return;
      }
      if (!route.methods.includes(req.method)) {
        rc.error(405, rc.t("error.method"), rc.t("error.method"));
        return;
      }

      // Eingerichtete, aber nicht erreichbare Datenbank ist ein Betriebsfehler.
      // Auf keinen Fall zurueck in den Assistenten — der wuerde eine
      // funktionierende Konfiguration ueberschreiben.
      if (app.databaseBroken && !route.allowBrokenDb) {
        rc.error(503, rc.t("error.dbUnavailable"), rc.t("error.dbUnavailable"));
        return;
      }

      await resolveUser(rc);
      if (!(await passesAccessGate(rc, route))) return;

      if (req.method === "POST") {
        const parsed = await readForm(req);
        if (!parsed.ok) {
          rc.error(parsed.code === "too_large" ? 413 : 415, rc.t("error.server"), rc.t("error.server"));
          return;
        }
        rc.form = parsed.form;

        // Herkunft pruefen, wenn der Browser sie mitschickt. Die eigentliche
        // Absicherung ist der CSRF-Wert; das hier ist die billige zweite Hürde.
        //
        // Sec-Fetch-Site ist dafuer die verlaessliche Angabe: jeder aktuelle
        // Browser schickt sie, und sie ist eindeutig. "none" heisst: direkt
        // eingegeben oder aus einem Lesezeichen.
        const site = req.headers["sec-fetch-site"];
        if (site && site !== "same-origin" && site !== "none") {
          log.warn("POST von fremder Seite abgewiesen", { site });
          rc.error(403, rc.t("error.csrf"), rc.t("error.csrf"));
          return;
        }
        // Origin dagegen kommt als "null" an, sobald der Browser die Herkunft
        // unterdrueckt — das ist KEIN fremder Ursprung. Genau daran ist der
        // Assistent im Browser gescheitert, waehrend er per curl (ganz ohne
        // Origin) lief.
        const origin = req.headers.origin;
        if (origin && origin !== "null" && origin !== `${rc.protocol}://${req.headers.host}`) {
          log.warn("POST mit fremdem Origin abgewiesen", { origin });
          rc.error(403, rc.t("error.csrf"), rc.t("error.csrf"));
          return;
        }
        if (!route.skipCsrf && !sameToken(rc.form.get("_csrf") || "", rc.csrf)) {
          rc.error(403, rc.t("error.csrf"), rc.t("error.csrf"));
          return;
        }
      }

      await route.handler(rc);
      if (!res.writableEnded) rc.notFound();
    } catch (err) {
      log.error(`Anfrage fehlgeschlagen: ${err.stack || err.message}`);
      if (!res.headersSent) {
        if (rc) rc.error(500, rc.t("error.server"), rc.t("error.server"));
        else {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("panel error\n");
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // Ein Panel bedient einen Menschen, keine Lastspitzen. Kurze Fristen
  // verhindern, dass haengende Verbindungen Speicher binden.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export { setCookie };
