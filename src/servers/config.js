import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverDir } from "../store/servers.js";

/**
 * Die Dateien, die ein DayZ-Server zum Starten braucht.
 *
 * Der Inhalt ist an einem laufenden Server abgeglichen, nicht aus dem
 * Gedaechtnis geschrieben — drei Punkte daraus kosten sonst Stunden:
 *
 * - BattlEye liest die Datei je nach Version klein- oder grossgeschrieben.
 *   Deshalb werden beide Schreibweisen abgelegt.
 * - Beim Start benennt BattlEye seine Konfiguration in
 *   beserver_x64_active_<hash>.cfg um und nutzt danach diese. Eine alte aktive
 *   Datei ueberlebt also eine Passwortaenderung und macht sie wirkungslos —
 *   sie muss weg.
 * - Ohne ~/.steam/sdk64/steamclient.so startet der Server nicht. Diesen
 *   Verweis legt das Startskript an.
 */

function quoteCfg(value) {
  // serverDZ.cfg kennt keine Maskierung innerhalb von Zeichenketten; was
  // stoeren koennte, wird entfernt statt maskiert.
  return String(value).replace(/["\r\n]/g, "").slice(0, 100);
}

export function serverDzCfg(server) {
  return `// Von dzpage-panel erzeugt. Aenderungen bleiben erhalten, solange das
// Panel die Datei nicht neu schreibt (Ports, Name, Spielerzahl, Mission).
hostname = "${quoteCfg(server.name)}";
password = "";
passwordAdmin = "";
maxPlayers = ${Number(server.max_players)};
verifySignatures = 2;
forceSameBuild = 1;
disableVoN = 0;
disable3rdPerson = 0;
serverTime = "SystemTime";
serverTimeAcceleration = 1;
serverTimePersistent = 0;
loginQueueConcurrentPlayers = 5;
loginQueueMaxPlayers = ${Math.max(Number(server.max_players), 50)};
respawnTime = 5;
timeStampFormat = "Full";
instanceId = 1;
storageAutoFix = 1;
steamQueryPort = ${Number(server.query_port)};
class Missions
{
    class DayZ
    {
        template = "${quoteCfg(server.mission)}";
    };
};
`;
}

export function battleyeCfg({ rconPassword, rconPort }) {
  if (/\s/.test(rconPassword)) throw new Error("Das RCon-Passwort darf keine Leerzeichen enthalten.");
  return `RConPassword ${rconPassword}\nRConPort ${Number(rconPort)}\nRestrictRCon 0\n`;
}

/** Werte fuer die systemd-Vorlage; systemd liest die Datei selbst, ohne Shell. */
export function serverEnv(server) {
  const cpuCount = Math.max(1, Math.min(16, Math.round(Number(server.cpu_quota) / 100)));
  return `DZ_PORT=${Number(server.game_port)}\nDZ_QUERY_PORT=${Number(server.query_port)}\nDZ_CPU_COUNT=${cpuCount}\n`;
}

/**
 * Alle Dateien schreiben. Wird beim Anlegen und nach jeder Aenderung
 * aufgerufen; vorhandene Spieldaten bleiben unberuehrt.
 */
export function writeServerFiles(server, rconPassword) {
  const dir = serverDir(server.id);
  const battleye = join(dir, "profiles", "battleye");
  mkdirSync(join(dir, "game"), { recursive: true, mode: 0o770 });
  mkdirSync(battleye, { recursive: true, mode: 0o770 });

  writeFileSync(join(dir, "serverDZ.cfg"), serverDzCfg(server), { mode: 0o660 });
  writeFileSync(join(dir, "server.env"), serverEnv(server), { mode: 0o660 });

  const beContent = battleyeCfg({ rconPassword, rconPort: server.rcon_port });
  for (const name of ["beserver_x64.cfg", "BEServer_x64.cfg"]) {
    writeFileSync(join(battleye, name), beContent, { mode: 0o660 });
    chmodSync(join(battleye, name), 0o660);
  }

  // Eine bereits umbenannte Konfiguration wuerde die neue ueberstimmen.
  for (const entry of readdirSync(battleye)) {
    if (/^beserver_x64_active_.*\.cfg$/i.test(entry)) rmSync(join(battleye, entry), { force: true });
  }

  return { dir, battleye };
}
