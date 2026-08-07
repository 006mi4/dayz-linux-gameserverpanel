import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

/**
 * Hilfen fuer die Tests. Die Umgebungsvariablen muessen gesetzt sein, bevor
 * paths.js zum ersten Mal geladen wird — deshalb wird das Panel ueberall per
 * dynamischem import geholt, nachdem prepareEnv gelaufen ist. node --test gibt
 * jeder Testdatei einen eigenen Prozess, also stoeren sich die Dateien nicht.
 */

export function prepareEnv(name) {
  const root = mkdtempSync(join(tmpdir(), `dzpanel-${name}-`));
  process.env.DZPAGE_PANEL_CONFIG_DIR = join(root, "etc");
  process.env.DZPAGE_PANEL_DATA_DIR = join(root, "lib");
  process.env.DZPAGE_PANEL_LOG_LEVEL = "error";
  return {
    root,
    configFile: join(root, "etc", "panel.json"),
    dataDir: join(root, "lib"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function launchPanel() {
  const { startPanel } = await import("../src/main.js");
  return startPanel({ port: 0, bind: "127.0.0.1" });
}

/** Browser-Ersatz: Cookie-Behaelter, keine automatischen Weiterleitungen. */
export class Client {
  constructor(baseUrl) {
    this.base = baseUrl;
    this.cookies = new Map();
    this.lastBody = "";
    this.lastStatus = 0;
    this.lastLocation = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const cookies = this.cookieHeader();
    if (cookies) headers.cookie = cookies;
    const response = await fetch(`${this.base}${path}`, { ...options, headers, redirect: "manual" });
    this.absorb(response);
    this.lastStatus = response.status;
    this.lastLocation = response.headers.get("location");
    this.lastBody = response.headers.get("content-type")?.includes("text/") ? await response.text() : "";
    this.lastResponse = response;
    return this;
  }

  get(path, options) {
    return this.request(path, { method: "GET", ...options });
  }

  post(path, fields, options = {}) {
    const body = new URLSearchParams(fields).toString();
    // options zuerst ausbreiten: sonst ueberschreibt ein mitgegebenes
    // headers-Objekt die gerade zusammengesetzten Kopfzeilen wieder.
    return this.request(path, {
      ...options,
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", ...(options.headers || {}) },
    });
  }

  /** CSRF-Wert aus der letzten Seite ziehen. */
  get csrf() {
    const match = this.lastBody.match(/name="_csrf" value="([^"]+)"/);
    if (!match) throw new Error("Kein CSRF-Wert in der Antwort gefunden.");
    return match[1];
  }

  /** Formular abschicken und den CSRF-Wert der zuletzt geladenen Seite mitnehmen. */
  submit(path, fields) {
    return this.post(path, { ...fields, _csrf: this.csrf });
  }
}

/**
 * Standhalter fuer die Panel-API von DZPage. Antwortet wie das Original,
 * inklusive der Fehlercodes aus src/lib/panel/api.ts.
 */
export async function startDzpageStub({ key = "dzp_panel_testkey", account = "TestKonto" } = {}) {
  const calls = { register: [], heartbeat: [], servers: [], results: [], polls: 0 };
  const state = { revoked: false, unknownPanel: false };
  const queue = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const auth = req.headers.authorization || "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (given !== key) return send(401, { ok: false, error: "invalid_key" });
      if (state.revoked) return send(403, { ok: false, error: "revoked" });

      const path = req.url.split("?")[0];
      const payload = body ? JSON.parse(body) : {};

      if (path === "/api/panel/v1/register") {
        calls.register.push(payload);
        return send(200, { ok: true, panelId: "panel123456", account, heartbeatSeconds: 60 });
      }
      if (path === "/api/panel/v1/heartbeat") {
        calls.heartbeat.push(payload);
        if (state.unknownPanel) return send(404, { ok: false, error: "unknown_panel" });
        return send(200, { ok: true, heartbeatSeconds: 60 });
      }
      if (path === "/api/panel/v1/servers") {
        if (req.method === "DELETE") return send(200, { ok: true, removed: 1 });
        calls.servers.push(payload);
        return send(200, { ok: true, serverId: "rcon123456", host: "203.0.113.7" });
      }
      if (path === "/api/panel/v1/poll") {
        // POST ist die Rueckmeldung, GET das Abholen.
        if (req.method === "POST") {
          calls.results.push(payload);
          return send(200, { ok: true });
        }
        calls.polls += 1;
        const jobs = queue.splice(0, queue.length);
        // Kein echtes Warten: der Test soll nicht 25 Sekunden dauern.
        return send(200, { ok: true, jobs });
      }
      return send(404, { ok: false, error: "not_found" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    key,
    calls,
    state,
    /** Auftrag einreihen, den der naechste Long-Poll abholt. */
    queueJob(job) {
      queue.push({ createdAt: new Date().toISOString(), ...job });
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
