import { execFile } from "node:child_process";
import { connect } from "node:net";

/**
 * Der Weg zum privilegierten Helfer (siehe helper/dzpage-panel-helper.sh).
 *
 * Im Betrieb ein Socket, den systemd bewacht und den nur der Dienstbenutzer
 * oeffnen darf; in Tests ein Programmpfad, damit die Suite ohne Rootrechte
 * laeuft. Beides nimmt dieselbe Argumentliste — nie eine Shell-Zeichenkette.
 */

const HELPER_SOCKET = process.env.DZPAGE_PANEL_HELPER_SOCKET || "/run/dzpage-panel-helper.sock";
const HELPER_BINARY = process.env.DZPAGE_PANEL_HELPER || null;
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Der Punkt steht hier, weil eine Fassungsnummer (v0.3.0) durch dieselbe Zeile
 * muss. Er ist ungefaehrlich: keine Operation des Helfers nimmt einen Pfad
 * entgegen, jede prueft ihre Parameter noch einmal gegen ein eigenes Muster.
 */
export const HELPER_ARGUMENT = /^[A-Za-z0-9._-]+$/;

export function runHelper(args) {
  for (const arg of args) {
    if (!HELPER_ARGUMENT.test(String(arg))) throw new Error(`Unerlaubtes Argument fuer den Helfer: ${arg}`);
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
