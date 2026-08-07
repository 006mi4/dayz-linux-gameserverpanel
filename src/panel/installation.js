import { readFileSync } from "node:fs";
import { INSTALL_FILE } from "../paths.js";

/**
 * Wie dieses Panel auf die Maschine gekommen ist.
 *
 * Das entscheidet, wie es sich selbst aktualisieren kann — und ob ueberhaupt:
 *
 *   git     ein Git-Arbeitsverzeichnis (Standardweg, install.sh). Neue Fassung
 *           holen und ausrollen macht der privilegierte Helfer.
 *   docker  das Panel laeuft im Container. Es aktualisiert sein eigenes
 *           Arbeitsverzeichnis und beendet sich; Docker startet es neu.
 *   manual  Dateien von Hand kopiert. Dann gibt es nichts, was das Panel
 *           gefahrlos ueberschreiben koennte — es meldet nur, was ansteht.
 *
 * install.sh und der Docker-Einstieg schreiben install.json. Fehlt sie, gilt
 * "manual": lieber gar nicht aktualisieren als am falschen Ort.
 */

export const METHODS = ["git", "docker", "manual"];
export const DEFAULT_REPOSITORY = "https://github.com/006mi4/dayz-linux-gameserverpanel.git";

const MANUAL = Object.freeze({
  method: "manual",
  checkout: null,
  repository: DEFAULT_REPOSITORY,
  args: [],
  installedAt: null,
});

let cache = null;

function read(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return MANUAL;
  }
  const method = METHODS.includes(raw?.method) ? raw.method : "manual";
  return Object.freeze({
    method,
    checkout: typeof raw?.checkout === "string" && raw.checkout ? raw.checkout : null,
    repository: typeof raw?.repository === "string" && raw.repository ? raw.repository : DEFAULT_REPOSITORY,
    args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
    installedAt: typeof raw?.installedAt === "string" ? raw.installedAt : null,
  });
}

/** Einmal lesen und merken; `reload` ist fuer die Tests und nach einer Aktualisierung. */
export function installation({ reload = false, file = INSTALL_FILE } = {}) {
  if (reload || !cache) cache = read(file);
  return cache;
}

/** Kann sich dieses Panel selbst erneuern, ohne dass jemand an der Konsole sitzt? */
export function canSelfUpdate(info = installation()) {
  return info.method === "git" || info.method === "docker";
}

/**
 * "owner/repo" fuer die GitHub-API. Beide Schreibweisen der Adresse kommen vor:
 * `https://github.com/owner/repo.git` beim Klonen, `git@github.com:owner/repo.git`
 * bei denen, die mit einem Schluessel arbeiten. Ein Fork bekommt damit seine
 * eigenen Fassungen gemeldet, ohne dass jemand etwas einstellen muss.
 */
export function repositorySlug(info = installation()) {
  const match = String(info.repository || "").match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Adresse fuer den Menschen: was er im Browser aufmachen kann. */
export function repositoryUrl(info = installation()) {
  const slug = repositorySlug(info);
  return slug ? `https://github.com/${slug}` : null;
}

/**
 * Im Container gibt es kein systemd — dort ist Docker die einzige Laufzeit, in
 * die ein Spielserver ueberhaupt gestartet werden kann.
 */
export function availableRuntimes(info = installation()) {
  return info.method === "docker" ? ["docker"] : ["systemd", "docker"];
}

export function defaultRuntime(info = installation()) {
  return availableRuntimes(info)[0];
}
