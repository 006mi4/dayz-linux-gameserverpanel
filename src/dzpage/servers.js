import { DzpageClient } from "./client.js";
import { getSetting, KEYS } from "../store/settings.js";
import { rconPassword, updateServer } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import { log } from "../log.js";

/**
 * Server bei DZPage anmelden. Damit taucht er in der Serverliste des Kontos auf
 * und ist dort per RCon steuerbar — ohne dass der Kunde irgendwo Zugangsdaten
 * abtippen muss: Er vergibt sie ohnehin gerade beim Anlegen.
 *
 * Die Adresse schicken wir bewusst nicht mit. DZPage nimmt die Quelladresse der
 * Anfrage, und das ist die oeffentliche Adresse dieser Maschine — dieselbe,
 * unter der auch die Spieler den Server finden.
 */

function client(app) {
  return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
}

export async function registerServerWithDzpage(app, server) {
  const panelId = await getSetting(app.db, KEYS.dzpagePanelId);
  if (!panelId) return { ok: false, message: "Das Panel ist noch nicht mit DZPage verbunden." };

  const password = rconPassword(server, app.config.secrets.encryption);
  if (!password) return { ok: false, message: "Das RCon-Passwort laesst sich nicht entschluesseln." };

  const result = await client(app).post("/api/panel/v1/servers", {
    panelId,
    serverId: server.id,
    name: server.name,
    rconPort: server.rcon_port,
    queryPort: server.query_port,
    rconPassword: password,
  });

  if (!result.ok) {
    log.warn(`Server ${server.id} konnte nicht bei DZPage angemeldet werden (${result.code})`);
    return { ok: false, message: `DZPage hat abgelehnt: ${result.code}` };
  }

  await updateServer(app.db, server.id, { dzpage_server_id: result.serverId });
  await recordEvent(app.db, {
    kind: "server.register",
    source: "dzpage",
    message: `${server.name} bei DZPage angemeldet (${result.host})`,
  });
  log.info(`Server ${server.id} bei DZPage angemeldet: ${result.serverId}`);
  return { ok: true, serverId: result.serverId, host: result.host };
}

/** Beim Loeschen im Panel: bei DZPage abschalten, nicht loeschen. */
export async function unregisterServerWithDzpage(app, server) {
  const panelId = await getSetting(app.db, KEYS.dzpagePanelId);
  if (!panelId || !server.dzpage_server_id) return { ok: true };
  const result = await client(app).request("DELETE", "/api/panel/v1/servers", {
    panelId,
    serverId: server.id,
  });

  return result.ok ? { ok: true } : { ok: false, message: result.code };
}
