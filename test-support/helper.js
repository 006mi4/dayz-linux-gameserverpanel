import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Der Einrichtungscode, den das Panel beim Start neben panel.json ablegt. */
export function readSetupCodeFile(env) {
  return readFileSync(join(env.root, "etc", "setup-code"), "utf8").trim();
}

/** Assistent mit dem Einrichtungscode freischalten, wie es der Mensch am Browser tut. */
export async function unlockSetup(client, env) {
  await client.get("/setup/unlock");
  await client.submit("/setup/unlock", { code: readSetupCodeFile(env) });
  if (client.lastStatus !== 303) throw new Error(`Freischalten fehlgeschlagen (${client.lastStatus})`);
  return client;
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
export async function startDzpageStub({ key = "dzp_panel_testkey0123456789abcdef", account = "TestKonto" } = {}) {
  const calls = {
    register: [],
    heartbeat: [],
    servers: [],
    unregister: [],
    results: [],
    progress: [],
    reports: [],
    reportMisses: 0,
    polls: 0,
    pair: [],
  };
  /**
   * failRegister: die naechsten n Anmeldungen scheitern mit 503 (DZPage kurz weg).
   * noReport: dzpage.com kennt den Zustandsbericht noch nicht (404 ohne JSON).
   */
  const state = { revoked: false, unknownPanel: false, failRegister: 0, noReport: false };
  const queue = [];
  /**
   * Kopplung wie auf DZPage: Einmal-Codes (dzp_pair_...) und Geraete-Codes.
   * Ein Geraete-Code wartet, bis der Test ihn mit approve()/deny() entscheidet.
   */
  const pairing = { tokens: new Set(["dzp_pair_gueltig_0123456789"]), devices: new Map(), issued: 0 };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // Kopplung kommt ohne Schluessel: genau dafuer ist sie da.
      const pairPath = req.url.split("?")[0];
      if (pairPath.startsWith("/api/panel/v1/pair/")) {
        const payload = body ? JSON.parse(body) : {};
        calls.pair.push({ path: pairPath, payload, authorization: req.headers.authorization ?? null });
        if (pairPath === "/api/panel/v1/pair/redeem") {
          if (!pairing.tokens.has(payload.token)) return send(400, { ok: false, error: "expired_token" });
          pairing.tokens.delete(payload.token);
          pairing.issued += 1;
          return send(200, { ok: true, key, account });
        }
        if (pairPath === "/api/panel/v1/pair/start") {
          const deviceCode = `geraet-${pairing.devices.size + 1}-${"x".repeat(40)}`;
          const userCode = `K7QF-M2X${pairing.devices.size + 1}`;
          pairing.devices.set(deviceCode, { status: "pending", userCode, request: payload });
          return send(200, {
            ok: true,
            deviceCode,
            userCode,
            verificationUrl: `https://dzpage.example/link?code=${userCode}`,
            expiresIn: 900,
            interval: 2,
          });
        }
        if (pairPath === "/api/panel/v1/pair/poll") {
          const device = pairing.devices.get(payload.deviceCode);
          if (!device) return send(200, { ok: true, status: "expired" });
          if (device.status === "approved") {
            pairing.devices.delete(payload.deviceCode);
            pairing.issued += 1;
            return send(200, { ok: true, status: "approved", key, account });
          }
          return send(200, { ok: true, status: device.status });
        }
        return send(404, { ok: false, error: "not_found" });
      }

      const auth = req.headers.authorization || "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (given !== key) return send(401, { ok: false, error: "invalid_key" });
      if (state.revoked) return send(403, { ok: false, error: "revoked" });

      const path = req.url.split("?")[0];
      const payload = body ? JSON.parse(body) : {};

      if (path === "/api/panel/v1/register") {
        if (state.failRegister > 0) {
          state.failRegister -= 1;
          return send(503, { ok: false, error: "unavailable" });
        }
        calls.register.push(payload);
        return send(200, { ok: true, panelId: "panel123456", account, heartbeatSeconds: 60 });
      }
      if (path === "/api/panel/v1/heartbeat") {
        calls.heartbeat.push(payload);
        if (state.unknownPanel) return send(404, { ok: false, error: "unknown_panel" });
        return send(200, { ok: true, heartbeatSeconds: 60 });
      }
      if (path === "/api/panel/v1/servers") {
        if (req.method === "DELETE") {
          calls.unregister.push(payload);
          return send(200, { ok: true, removed: 1 });
        }
        calls.servers.push(payload);
        return send(200, { ok: true, serverId: "rcon123456", host: "203.0.113.7" });
      }
      if (path === "/api/panel/v1/report") {
        if (state.noReport) {
          calls.reportMisses += 1;
          res.writeHead(404, { "content-type": "text/html" });
          res.end("<!doctype html><title>404</title>");
          return;
        }
        calls.reports.push(payload);
        return send(200, { ok: true });
      }
      if (path === "/api/panel/v1/poll") {
        // POST ist die Rueckmeldung, GET das Abholen. "running" ist ein
        // Zwischenstand und steht getrennt vom Ergebnis.
        if (req.method === "POST") {
          if (payload.status === "running") calls.progress.push(payload);
          else calls.results.push(payload);
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
    pairing,
    /** Den offenen Geraete-Code bestaetigen oder ablehnen, wie der Mensch auf dzpage.com. */
    decideDevice(status) {
      for (const device of pairing.devices.values()) {
        if (device.status === "pending") device.status = status;
      }
    },
    /** Auftrag einreihen, den der naechste Long-Poll abholt. */
    queueJob(job) {
      queue.push({ createdAt: new Date().toISOString(), ...job });
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
