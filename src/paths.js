import { join } from "node:path";

/**
 * Ablageorte nach Linux-Konvention. Die Umgebungsvariablen existieren, damit
 * Tests und Entwicklungslaeufe ohne Rootrechte moeglich sind — im Betrieb
 * bleiben die Standardpfade stehen.
 */
export const CONFIG_DIR = process.env.DZPAGE_PANEL_CONFIG_DIR || "/etc/dzpage-panel";
export const DATA_DIR = process.env.DZPAGE_PANEL_DATA_DIR || "/var/lib/dzpage-panel";

export const CONFIG_FILE = join(CONFIG_DIR, "panel.json");

/** Spieldateien je Server. Laufzeitwechsel systemd/Docker aendert den Ort nicht. */
export const SERVERS_DIR = join(DATA_DIR, "servers");

/** SteamCMD selbst (Programm) und sein HOME (Sitzungstoken, Caches). */
export const STEAMCMD_DIR = join(DATA_DIR, "steamcmd");
export const STEAM_HOME = join(DATA_DIR, "steam-home");

/** Standardablage der SQLite-Datenbank. */
export const SQLITE_FILE = join(DATA_DIR, "panel.sqlite");
