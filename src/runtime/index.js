import { createSystemdRuntime } from "./systemd.js";
import { createDockerRuntime } from "./docker.js";

/**
 * Zwei Laufzeiten hinter einer Schnittstelle: prepare, start, stop, restart,
 * setAutostart, status, logs, destroy.
 *
 * Standard ist systemd, weil es auf jedem Linux ohne Zusatzsoftware laeuft.
 * Docker ist eine Umschaltung im Panel, kein zweiter Installationsweg — die
 * Spieldateien liegen in beiden Faellen am selben Ort, ein Wechsel kostet
 * keinen Neu-Download.
 */

const RUNTIMES = {
  systemd: createSystemdRuntime(),
  docker: createDockerRuntime(),
};

export const RUNTIME_IDS = Object.keys(RUNTIMES);

export function runtimeFor(server) {
  const id = typeof server === "string" ? server : server?.runtime;
  return RUNTIMES[id] || RUNTIMES.systemd;
}

export function getRuntime(id) {
  return RUNTIMES[id] || null;
}
