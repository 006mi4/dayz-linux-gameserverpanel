import { join } from "node:path";

/**
 * Ablageorte nach Linux-Konvention. Die Umgebungsvariablen existieren, damit
 * Tests und Entwicklungslaeufe ohne Rootrechte moeglich sind — im Betrieb
 * bleiben die Standardpfade stehen.
 */
export const CONFIG_DIR = process.env.DZPAGE_PANEL_CONFIG_DIR || "/etc/dzpage-panel";
export const DATA_DIR = process.env.DZPAGE_PANEL_DATA_DIR || "/var/lib/dzpage-panel";

export const CONFIG_FILE = join(CONFIG_DIR, "panel.json");

/**
 * Einmaliger Einrichtungscode. Solange es keinen Administrator gibt, oeffnet
 * nur er den Assistenten; install.sh gibt ihn am Ende aus.
 */
export const SETUP_CODE_FILE = join(CONFIG_DIR, "setup-code");

/** Spieldateien je Server. Laufzeitwechsel systemd/Docker aendert den Ort nicht. */
export const SERVERS_DIR = join(DATA_DIR, "servers");

/** SteamCMD selbst (Programm) und sein HOME (Sitzungstoken, Caches). */
export const STEAMCMD_DIR = join(DATA_DIR, "steamcmd");
export const STEAM_HOME = join(DATA_DIR, "steam-home");

/**
 * Eigenes HOME fuer die Update-Pruefung. Sie meldet sich anonym an, und eine
 * anonyme Anmeldung hat im selben Verzeichnis nichts verloren wie das
 * Sitzungstoken des Kundenkontos — das ist der einzige Wert, den das Panel
 * nicht wiederherstellen kann.
 */
export const STEAM_INFO_HOME = join(DATA_DIR, "steam-info-home");

/** Standardablage der SQLite-Datenbank. */
export const SQLITE_FILE = join(DATA_DIR, "panel.sqlite");

/**
 * Wie dieses Panel installiert wurde (install.sh oder Docker-Einstieg legen die
 * Datei an). Ohne sie kann sich das Panel nicht selbst aktualisieren.
 */
export const INSTALL_FILE = join(CONFIG_DIR, "install.json");

/**
 * Ergebnis der letzten Selbstaktualisierung. Sie laeuft als eigener Prozess
 * weiter, waehrend das Panel neu startet — eine Datei ist der einzige Weg, auf
 * dem das Ergebnis den Neustart ueberlebt.
 */
export const SELF_UPDATE_FILE = join(DATA_DIR, "self-update.json");
