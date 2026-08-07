import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SERVERS_DIR } from "../paths.js";
import { decryptSecret, encryptSecret } from "../crypto/secretbox.js";

/**
 * Die DayZ-Server dieses Panels.
 *
 * Das RCon-Passwort liegt verschlüsselt in der Datenbank; der Schlüssel steht
 * in der Konfigurationsdatei. Ein gestohlenes Datenbank-Backup gibt damit
 * keine Fernsteuerung her.
 */

export const NAME_PATTERN = /^[\p{L}\p{N} .,'()_-]{3,60}$/u;
export const MISSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Wie die Kennung im systemd-Instanznamen und im Benutzernamen auftaucht. */
export const SERVER_ID_PATTERN = /^[a-f0-9]{12}$/;

export const DEFAULTS = {
  gamePort: 2302,
  queryPort: 27016,
  rconPort: 2306,
  maxPlayers: 60,
  mission: "dayzOffline.chernarusplus",
  memoryMaxMb: 6144,
  cpuQuota: 400,
};

/** Verzeichnis eines Servers — nie aus der Oberfläche, immer aus der Kennung. */
export function serverDir(id) {
  if (!SERVER_ID_PATTERN.test(id)) throw new Error(`Ungueltige Server-Kennung: ${id}`);
  return join(SERVERS_DIR, id);
}

export function checkPort(value, { min = 1024, max = 65535 } = {}) {
  const port = Number(value);
  return Number.isInteger(port) && port >= min && port <= max ? port : null;
}

/**
 * Prüft die Angaben aus dem Formular. Gibt entweder den geprüften Satz oder
 * den Fehlercode des ersten Problems zurück — die Oberfläche macht daraus
 * einen Satz in der Sprache des Nutzers.
 */
export function checkServerInput(input) {
  const name = String(input.name ?? "").trim();
  if (!NAME_PATTERN.test(name)) return { ok: false, code: "name" };

  const gamePort = checkPort(input.gamePort);
  const queryPort = checkPort(input.queryPort);
  const rconPort = checkPort(input.rconPort);
  if (!gamePort || !queryPort || !rconPort) return { ok: false, code: "port" };
  if (new Set([gamePort, queryPort, rconPort]).size !== 3) return { ok: false, code: "port_conflict" };

  const maxPlayers = Number(input.maxPlayers);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 200) return { ok: false, code: "players" };

  const mission = String(input.mission ?? DEFAULTS.mission).trim();
  if (!MISSION_PATTERN.test(mission)) return { ok: false, code: "mission" };

  const password = String(input.rconPassword ?? "");
  // BattlEye verträgt keine Leerzeichen im Passwort — es steht unquotiert in
  // seiner eigenen Konfigurationsdatei.
  if (password.length < 8 || password.length > 64 || /\s/.test(password)) {
    return { ok: false, code: "rcon_password" };
  }

  const memoryMaxMb = Number(input.memoryMaxMb ?? DEFAULTS.memoryMaxMb);
  if (!Number.isInteger(memoryMaxMb) || memoryMaxMb < 512 || memoryMaxMb > 131072) {
    return { ok: false, code: "memory" };
  }
  const cpuQuota = Number(input.cpuQuota ?? DEFAULTS.cpuQuota);
  if (!Number.isInteger(cpuQuota) || cpuQuota < 50 || cpuQuota > 3200) return { ok: false, code: "cpu" };

  return {
    ok: true,
    value: { name, gamePort, queryPort, rconPort, maxPlayers, mission, password, memoryMaxMb, cpuQuota },
  };
}

export async function listServers(db) {
  return db.all("SELECT * FROM servers ORDER BY created_at ASC", []);
}

export async function countServers(db) {
  const row = await db.get("SELECT COUNT(*) AS count FROM servers", []);
  return Number(row?.count ?? 0);
}

export async function getServer(db, id) {
  if (!SERVER_ID_PATTERN.test(String(id ?? ""))) return null;
  return db.get("SELECT * FROM servers WHERE id = ?", [id]);
}

/** Stößt eine Portbelegung mit einem anderen Server zusammen? */
export async function findPortConflict(db, { gamePort, queryPort, rconPort }, exceptId = null) {
  const rows = await db.all("SELECT id, game_port, query_port, rcon_port FROM servers", []);
  const wanted = [gamePort, queryPort, rconPort];
  for (const row of rows) {
    if (exceptId && row.id === exceptId) continue;
    const used = [Number(row.game_port), Number(row.query_port), Number(row.rcon_port)];
    if (used.some((port) => wanted.includes(port))) return row;
  }
  return null;
}

export async function createServer(db, input, encryptionKey) {
  const id = randomBytes(6).toString("hex");
  const now = Date.now();
  await db.run(
    `INSERT INTO servers
       (id, name, game_port, query_port, rcon_port, rcon_password_enc, max_players, mission,
        runtime, memory_max_mb, cpu_quota, install_state, autostart, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'systemd', ?, ?, 'new', 1, ?)`,
    [
      id,
      input.name,
      input.gamePort,
      input.queryPort,
      input.rconPort,
      encryptSecret(input.password, encryptionKey),
      input.maxPlayers,
      input.mission,
      input.memoryMaxMb,
      input.cpuQuota,
      now,
    ],
  );
  return getServer(db, id);
}

export async function updateServer(db, id, fields) {
  const columns = [];
  const values = [];
  for (const [column, value] of Object.entries(fields)) {
    if (!/^[a-z_]+$/.test(column)) throw new Error(`Unerlaubter Spaltenname: ${column}`);
    columns.push(`${column} = ?`);
    values.push(value);
  }
  if (!columns.length) return;
  values.push(id);
  await db.run(`UPDATE servers SET ${columns.join(", ")} WHERE id = ?`, values);
}

export async function deleteServer(db, id) {
  await db.run("DELETE FROM servers WHERE id = ?", [id]);
}

export function rconPassword(server, encryptionKey) {
  return decryptSecret(server.rcon_password_enc, encryptionKey);
}
