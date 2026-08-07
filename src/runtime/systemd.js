import { runHelper } from "./helper.js";
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
