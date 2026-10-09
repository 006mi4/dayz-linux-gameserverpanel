import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
/**
 * Fehler, die heissen: Von dieser Maschine geht gar nichts ueber IPv4 (keine
 * Route, keine Adresse, kein A-Eintrag). EHOSTUNREACH und Zeitlimits gehoeren
 * nicht dazu, die kommen auch bei kurzen Stoerungen.
 */
const NO_IPV4 = new Set(["ENETUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENOTFOUND"]);

export function platformLabel() {
  return `${osType()} ${release()} (${arch()})`.slice(0, 80);
}

/**
 * fetch, aber nur ueber IPv4, mit genau dem, was request() von einer Antwort
 * braucht (ok, status, json). Global fetch kennt keine Adressfamilie, und
 * prozessweit umstellen (ipv4first, autoSelectFamily aus) wuerde Long-Poll und
 * Herzschlag auf Maschinen ohne IPv4 brechen.
 *
 * Ein Fehler traegt `connected`: ob die Verbindung schon stand. Nur wenn
 * nicht, hat DZPage die Anfrage sicher nie gesehen. `lookup` gibt es nur fuer
 * die Tests (eigene Namensaufloesung, wie bei http.request).
 */
export function fetchIpv4(url, { method = "GET", headers = {}, body, signal, lookup } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    let connected = false;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Wie fetch: Ein abgelaufenes Zeitlimit heisst TimeoutError.
      const reason = signal?.aborted ? signal.reason : err;
      const error = new Error(reason?.message || String(reason));
      error.name = reason?.name || "Error";
      error.code = err?.code;
      error.connected = connected;
      reject(error);
    };

    const req = send(
      target,
      {
        method,
        headers: body === undefined ? headers : { ...headers, "content-length": Buffer.byteLength(body) },
        family: 4,
        // Eine eigene Verbindung, die danach schliesst: Die Anmeldung ist
        // selten, und so bleibt nichts offen liegen.
        agent: false,
        signal,
        ...(lookup ? { lookup } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", fail);
        res.on("close", () => {
          if (!res.complete) fail(new Error("Verbindung während der Antwort abgebrochen"));
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on("socket", (socket) => socket.once("connect", () => (connected = true)));
    req.on("error", fail);
    req.end(body);
  });
}

export class DzpageClient {
  constructor({ baseUrl, key, fetchImpl = fetch, ipv4FetchImpl = fetchIpv4 }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.key = key || null;
    this.fetchImpl = fetchImpl;
    this.ipv4FetchImpl = ipv4FetchImpl;
  }

  get hasKey() {
    return typeof this.key === "string" && this.key.startsWith(PANEL_KEY_PREFIX);
  }

  /**
   * Eine Anfrage an die Panel-API. Der Long-Poll braucht eine laengere Frist
   * als der Rest — deshalb ist sie hier einstellbar statt fest.
   */
  async request(method, path, body = null, { timeoutMs = TIMEOUT_MS, signal, anonymous = false, ipv4 = false } = {}) {
    // Ohne Schluessel geht nur die Kopplung: Sie ist genau der Weg, auf dem
    // ein Panel seinen Schluessel erst bekommt.
    if (!anonymous && !this.hasKey) return { ok: false, code: "missing_key" };

    const send = ipv4 ? this.ipv4FetchImpl : this.fetchImpl;
    let response;
    try {
      response = await send(`${this.baseUrl}${path}`, {
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
      const message = err.name === "TimeoutError" ? "Zeitüberschreitung" : err.message;
      if (ipv4) {
        return { ok: false, code: "network", message, connected: err.connected === true, errorCode: err.code ?? null };
      }
      return { ok: false, code: "network", message };
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
      // DZPage lehnt einen Schluessel mit JSON und genau diesen beiden Codes ab.
      // Alles andere kam von davor (Proxy, Cloudflare, auch als JSON) und sagt
      // nichts ueber den Schluessel: dann wie eine Stoerung warten, statt fuer
      // immer anzuhalten.
      if (payload?.error === "revoked" || payload?.error === "invalid_key") return { ok: false, code: payload.error };
      return { ok: false, code: "server", status: response.status };
    }
    if (response.status === 400) return { ok: false, code: payload?.error || "bad_request" };
    // Ohne JSON-Antwort gibt es den Endpunkt nicht (aelteres dzpage.com); das
    // ist etwas anderes als eine Panel-ID, die DZPage nicht kennt.
    if (response.status === 404) return { ok: false, code: payload?.error || "not_found" };
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

  /**
   * Server anmelden. DZPage nimmt die Quelladresse dieser Anfrage als
   * RCon-Adresse, und BattlEye-RCon spricht nur IPv4: Deshalb geht genau diese
   * Anfrage ueber IPv4, auch wenn die Maschine sonst IPv6 bevorzugt.
   *
   * Kommt ueber IPv4 keine Verbindung zustande, wie jeder andere Aufruf.
   * DZPage legt den Server dann mit `warning: "ipv6_source"` an, und RCon
   * bleibt aus. Wann das gilt, sagt `fallback`:
   * - "any": jeder Fehler vor dem Verbinden. Fuer einen neuen Server, bei dem
   *   es nichts zu verlieren gibt.
   * - "no_ipv4": nur Fehler, die heissen, dass es hier kein IPv4 gibt. Fuer
   *   einen schon angemeldeten Server: Eine kurze Stoerung (Zeitlimit, DNS)
   *   soll seine richtige IPv4-Adresse nicht durch IPv6 ersetzen.
   * Stand die Verbindung schon, gibt es nie einen zweiten Versuch: Die
   * Anmeldung kann angekommen sein, und eine zweite ueber IPv6 wuerde die
   * richtige Adresse wieder ueberschreiben.
   */
  async registerServer(body, { fallback = "any" } = {}) {
    const viaIpv4 = await this.request("POST", "/api/panel/v1/servers", body, { ipv4: true });
    const unreached = viaIpv4.code === "network" && !viaIpv4.connected;
    const fallBack = unreached && (fallback === "any" || NO_IPV4.has(viaIpv4.errorCode));
    if (!fallBack) return { ...viaIpv4, via: "ipv4" };
    const result = await this.post("/api/panel/v1/servers", body);
    return { ...result, via: "fallback", ipv4Error: viaIpv4.message };
  }
}
