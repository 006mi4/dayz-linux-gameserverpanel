import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverDir, SERVER_ID_PATTERN } from "../store/servers.js";

/**
 * Laufzeit "docker" — die Umschaltung fuer alle, die ohnehin Docker betreiben.
 *
 * Wichtig fuer den Wechsel: Die Spieldateien bleiben, wo sie sind
 * (/var/lib/dzpage-panel/servers/<id>) und werden in den Container eingehaengt.
 * Ein Wechsel der Laufzeit kostet deshalb keinen Neu-Download der 4 GB.
 *
 * Der Container laeuft unter derselben Benutzerkennung wie das Panel, damit
 * dieselben Dateien von beiden Laufzeiten beschreibbar bleiben.
 */

const DOCKER = process.env.DZPAGE_PANEL_DOCKER || "/usr/bin/docker";
const DEFAULT_IMAGE = process.env.DZPAGE_PANEL_DOCKER_IMAGE || "debian:bookworm-slim";
const MOUNT = "/srv/dayz";
const TIMEOUT_MS = 120_000;

function containerName(id) {
  if (!SERVER_ID_PATTERN.test(id)) throw new Error("Ungueltige Server-Kennung.");
  return `dzpage-server-${id}`;
}

function docker(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(DOCKER, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFailure) {
        const detail = `${stderr || ""}${stdout || ""}`.trim().split("\n").slice(-3).join(" ");
        reject(new Error(detail || err.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export async function dockerAvailable() {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Startskript im Container. Es steht im Serververzeichnis und macht dasselbe
 * wie das Startskript der systemd-Laufzeit — nur mit den Pfaden von innen.
 */
function writeLauncher(id, server) {
  const cpuCount = Math.max(1, Math.min(16, Math.round(Number(server.cpu_quota) / 100)));
  const script = `#!/bin/sh
# Von dzpage-panel erzeugt (Docker-Laufzeit).
set -eu
DIR=${MOUNT}
GAME=$DIR/game
[ -x "$GAME/DayZServer" ] || { echo "DayZServer fehlt in $GAME, Server nicht installiert." >&2; exit 78; }
mkdir -p "$DIR/profiles/battleye"
if [ -f "$GAME/steamclient.so" ]; then
  mkdir -p "$DIR/.steam/sdk64"
  ln -sf "$GAME/steamclient.so" "$DIR/.steam/sdk64/steamclient.so"
fi
cd "$GAME"
LD_LIBRARY_PATH="$GAME:\${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH HOME="$DIR"
exec "$GAME/DayZServer" \\
  "-config=$DIR/serverDZ.cfg" \\
  "-port=${Number(server.game_port)}" \\
  "-profiles=$DIR/profiles" \\
  "-BEpath=$DIR/profiles/battleye" \\
  "-cpuCount=${cpuCount}" \\
  -dologs -adminlog -netlog -freezecheck
`;
  const path = join(serverDir(id), "docker-launch.sh");
  writeFileSync(path, script, { mode: 0o770 });
  return path;
}

async function removeContainer(id) {
  await docker(["rm", "-f", containerName(id)], { allowFailure: true });
}

export function createDockerRuntime() {
  return {
    id: "docker",

    async prepare(server) {
      if (!(await dockerAvailable())) {
        throw new Error("Docker antwortet nicht. Läuft der Dienst, und darf der Panel-Benutzer ihn benutzen?");
      }
      writeLauncher(server.id, server);
    },

    async start(server) {
      const id = server.id;
      const name = containerName(id);
      const dir = serverDir(id);
      writeLauncher(id, server);
      await removeContainer(id);

      const image = server.docker_image || DEFAULT_IMAGE;
      const cpus = (Number(server.cpu_quota) / 100).toFixed(2);
      const args = [
        "run",
        "-d",
        "--name",
        name,
        "--restart",
        "unless-stopped",
        // Wie in der systemd-Unit: DayZ speichert und geht auf SIGINT.
        "--stop-signal",
        "SIGINT",
        "--user",
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        "--cpus",
        cpus,
        "--memory",
        `${Number(server.memory_max_mb)}m`,
        "-v",
        `${dir}:${MOUNT}`,
        "-w",
        `${MOUNT}/game`,
        "-e",
        `HOME=${MOUNT}`,
        "--label",
        "dzpage-panel=server",
      ];
      for (const port of [server.game_port, server.query_port, server.rcon_port]) {
        args.push("-p", `${Number(port)}:${Number(port)}/udp`);
      }
      args.push(image, "/bin/sh", `${MOUNT}/docker-launch.sh`);
      await docker(args);
    },

    async stop(server) {
      await docker(["stop", "--time", "45", containerName(server.id)], { allowFailure: true });
    },

    async restart(server) {
      // Neu erzeugen statt neu starten: so wirken geaenderte Ports und
      // Grenzwerte sofort, ohne dass jemand daran denken muss.
      await this.start(server);
    },

    async setAutostart(server, on) {
      await docker(["update", "--restart", on ? "unless-stopped" : "no", containerName(server.id)], {
        allowFailure: true,
      });
    },

    async status(server) {
      const id = server.id;
      let text;
      try {
        text = await docker([
          "inspect",
          "--format",
          "{{.State.Status}}|{{.State.Pid}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.HostConfig.RestartPolicy.Name}}",
          containerName(id),
        ]);
      } catch {
        return { state: "stopped", pid: 0, memoryBytes: null, restarts: 0, autostart: false };
      }
      const [status, pid, restarts, since, policy] = text.trim().split("|");
      const state =
        status === "running"
          ? "running"
          : status === "restarting"
            ? "starting"
            : status === "exited" || status === "created"
              ? "stopped"
              : status === "dead"
                ? "failed"
                : "unknown";
      return {
        state,
        pid: Number(pid) || 0,
        memoryBytes: null,
        restarts: Number(restarts) || 0,
        since: since || null,
        autostart: policy === "unless-stopped" || policy === "always",
      };
    },

    async logs(server, lines = 200) {
      return docker(["logs", "--tail", String(Number(lines) || 200), containerName(server.id)], {
        allowFailure: true,
      });
    },

    async destroy(server) {
      await removeContainer(server.id);
    },

    /** Docker veroeffentlicht die Ports selbst und an ufw vorbei (eigene iptables-Regeln). */
    async firewall() {
      return { backend: "docker", open: [] };
    },

    directory(id) {
      return serverDir(id);
    },
  };
}
