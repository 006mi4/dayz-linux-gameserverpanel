import { arch, release, type as osType } from "node:os";
import { PANEL_VERSION } from "../version.js";

/**
 * Klient fuer die Panel-API von DZPage.
 *
 * Die Richtung ist Absicht: Das Panel spricht DZPage an, nie umgekehrt. Damit
 * braucht kein Kunde eine Portfreigabe, und es funktioniert auch hinter CGNAT.
 *
 * Antworten kommen als JSON mit stabilen Fehlercodes zurueck; hier werden sie
 * in genau diese Codes uebersetzt, damit die Oberflaeche nie Text vergleichen
 * muss.
 */

export const PANEL_KEY_PREFIX = "dzp_panel_";
const TIMEOUT_MS = 10_000;

export function platformLabel() {
  return `${osType()} ${release()} (${arch()})`.slice(0, 80);
}

export class DzpageClient {
  constructor({ baseUrl, key, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.key = key || null;
    this.fetchImpl = fetchImpl;
  }

  get hasKey() {
    return typeof this.key === "string" && this.key.startsWith(PANEL_KEY_PREFIX);
  }

  /**
   * Eine Anfrage an die Panel-API. Der Long-Poll braucht eine laengere Frist
   * als der Rest — deshalb ist sie hier einstellbar statt fest.
   */
  async request(method, path, body = null, { timeoutMs = TIMEOUT_MS, signal, anonymous = false } = {}) {
    // Ohne Schluessel geht nur die Kopplung: Sie ist genau der Weg, auf dem
    // ein Panel seinen Schluessel erst bekommt.
    if (!anonymous && !this.hasKey) return { ok: false, code: "missing_key" };

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(anonymous ? {} : { authorization: `Bearer ${this.key}` }),
          ...(body === null ? {} : { "content-type": "application/json" }),
          accept: "application/json",
          "user-agent": `dzpage-panel/${PANEL_VERSION}`,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Zeitueberschreitung und Namensauflösung landen beide hier.
      return { ok: false, code: "network", message: err.name === "TimeoutError" ? "Zeitüberschreitung" : err.message };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.ok && payload?.ok) return { ok: true, ...payload };
    if (response.status === 429) return { ok: false, code: "rate_limited" };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: payload?.error === "revoked" ? "revoked" : payload?.error || "invalid_key" };
    }
    if (response.status === 400) return { ok: false, code: payload?.error || "bad_request" };
    if (response.status === 404) return { ok: false, code: payload?.error || "unknown_panel" };
    return { ok: false, code: "server", status: response.status };
  }

  post(path, body) {
    return this.request("POST", path, body);
  }

  register({ name, version = PANEL_VERSION, platform = platformLabel() }) {
    return this.post("/api/panel/v1/register", { name, version, platform });
  }

  heartbeat({ panelId, serverCount = 0, version = PANEL_VERSION }) {
    return this.post("/api/panel/v1/heartbeat", { panelId, serverCount, version });
  }
}
