import { execFile } from "node:child_process";
import { connect } from "node:net";
import { serverDir, SERVER_ID_PATTERN } from "../store/servers.js";

/**
 * Laufzeit "systemd" — der Standardweg, weil er auf jedem Linux ohne
 * Zusatzsoftware laeuft.
 *
 * Alles Privilegierte geht durch das Hilfsprogramm (siehe
 * helper/dzpage-panel-helper.sh): Das Panel selbst darf keine Dienste anlegen
 * und keine Benutzer erzeugen. Aufgerufen wird mit einer Argumentliste, nie
 * ueber eine Shell-Zeichenkette.
 */

/**
 * Der Weg zum Helfer: im Betrieb ein Socket, den systemd bewacht; in Tests ein
 * Programmpfad, damit die Suite ohne Rootrechte laeuft.
 */
const HELPER_SOCKET = process.env.DZPAGE_PANEL_HELPER_SOCKET || "/run/dzpage-panel-helper.sock";
const HELPER_BINARY = process.env.DZPAGE_PANEL_HELPER || null;
const TIMEOUT_MS = 15 * 60 * 1000;
const ARGUMENT = /^[A-Za-z0-9_-]+$/;

function runHelper(args) {
  for (const arg of args) {
    if (!ARGUMENT.test(String(arg))) throw new Error(`Unerlaubtes Argument fuer den Helfer: ${arg}`);
  }
  return HELPER_BINARY ? runBinary(args) : runSocket(args);
}

function runBinary(args) {
  return new Promise((resolve, reject) => {
    execFile(HELPER_BINARY, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = `${stderr || ""}${stdout || ""}`.trim().split("\n").slice(-3).join(" ");
        reject(new Error(detail || err.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * Eine Zeile hin, die Ausgabe zurueck, am Ende "#status:<code>". Ohne diesen
 * Abschluss waere nicht zu unterscheiden, ob der Helfer fertig war oder die
 * Verbindung abgerissen ist.
 */
function runSocket(args) {
  return new Promise((resolve, reject) => {
    const socket = connect(HELPER_SOCKET);
    let output = "";
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(TIMEOUT_MS, () => finish(new Error("Der Helfer hat nicht rechtzeitig geantwortet.")));
    socket.on("error", (err) =>
      finish(
        new Error(
          err.code === "ENOENT" || err.code === "ECONNREFUSED"
            ? `Der Helfer ist nicht erreichbar (${HELPER_SOCKET}). Läuft dzpage-panel-helper.socket?`
            : err.message,
        ),
      ),
    );
    socket.on("data", (chunk) => {
      output += chunk;
    });
    socket.on("end", () => {
      const match = output.match(/#status:(\d+)\s*$/);
      const body = output.replace(/#status:\d+\s*$/, "");
      if (!match) {
        finish(new Error(`Der Helfer hat abgebrochen: ${body.trim().slice(-200) || "keine Antwort"}`));
        return;
      }
      if (match[1] !== "0") {
        finish(new Error(body.trim().split("\n").slice(-2).join(" ").slice(0, 300) || `Fehlercode ${match[1]}`));
        return;
      }
      finish(null, body);
    });

    socket.write(`${args.join(" ")}\n`);
  });
}

function parseShow(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) out[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return out;
}

function normaliseState(show) {
  const active = show.ActiveState || "unknown";
  const sub = show.SubState || "";
  if (active === "active" && sub === "running") return "running";
  if (active === "activating") return "starting";
  if (active === "deactivating") return "stopping";
  if (active === "failed") return "failed";
  if (active === "inactive") return "stopped";
  return "unknown";
}

export function createSystemdRuntime() {
  return {
    id: "systemd",

    /** Benutzer, Rechte und Grenzwerte fuer diesen Server einrichten. */
    async prepare(server) {
      await runHelper(["prepare", server.id, String(server.memory_max_mb), String(server.cpu_quota)]);
    },

    async start(server) {
      await runHelper(["start", server.id]);
    },
    async stop(server) {
      await runHelper(["stop", server.id]);
    },
    async restart(server) {
      await runHelper(["restart", server.id]);
    },
    async setAutostart(server, on) {
      await runHelper([on ? "enable" : "disable", server.id]);
    },

    async status(server) {
      if (!SERVER_ID_PATTERN.test(server.id)) throw new Error("Ungueltige Server-Kennung.");
      let show;
      try {
        show = parseShow(await runHelper(["status", server.id]));
      } catch (err) {
        return { state: "unknown", error: err.message, pid: 0, memoryBytes: null, restarts: 0, autostart: false };
      }
      const memory = Number(show.MemoryCurrent);
      return {
        state: normaliseState(show),
        pid: Number(show.MainPID) || 0,
        // "[not set]" liefert systemd, solange der Dienst nie lief.
        memoryBytes: Number.isFinite(memory) && memory > 0 ? memory : null,
        restarts: Number(show.NRestarts) || 0,
        since: show.ExecMainStartTimestamp || null,
        autostart: show.UnitFileState === "enabled",
        result: show.Result || null,
      };
    },

    async logs(server, lines = 200) {
      return runHelper(["logs", server.id, String(lines)]);
    },

    async destroy(server) {
      await runHelper(["destroy", server.id]);
    },

    /** Wohin die Spieldateien gehoeren — bei beiden Laufzeiten derselbe Ort. */
    directory(id) {
      return serverDir(id);
    },
  };
}
