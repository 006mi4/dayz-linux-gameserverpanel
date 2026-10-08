import { rmSync } from "node:fs";
import { deleteServer, serverDir } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import { runtimeFor } from "../runtime/index.js";
import { unregisterServerWithDzpage } from "../dzpage/servers.js";
import { log } from "../log.js";

/**
 * Einen Spielserver ganz entfernen: Laufzeit abraeumen, Verzeichnis samt
 * Spielstand loeschen, bei DZPage abmelden, Eintrag loeschen. Ein Weg fuer die
 * Schaltflaeche im Panel und den Auftrag von dzpage.com.
 *
 * Der Aufrufer sorgt dafuer, dass gerade kein Vorgang in das Verzeichnis
 * schreibt; sonst legte eine laufende Installation danach Teile wieder an.
 */
export async function removeServer(app, server) {
  await runtimeFor(server).destroy(server);
  rmSync(serverDir(server.id), { recursive: true, force: true });
  // Bei DZPage abschalten, sonst stuende dort ein Server, den es nicht mehr
  // gibt, und der RCon-Arbeiter versuchte weiter, ihn zu erreichen.
  const unregistered = await unregisterServerWithDzpage(app, server).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!unregistered.ok) log.warn(`Server ${server.id} bei DZPage nicht abgemeldet: ${unregistered.message}`);
  await deleteServer(app.db, server.id);
  await recordEvent(app.db, { kind: "server.delete", message: `Server ${server.name} entfernt` });
}
