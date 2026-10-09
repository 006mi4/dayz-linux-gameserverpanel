import { DzpageClient } from "./client.js";
import { getSetting, KEYS, setSetting } from "../store/settings.js";
import { getServer, listServers, rconPassword, updateServer } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import { log } from "../log.js";

/**
 * Server bei DZPage anmelden. Damit taucht er in der Serverliste des Kontos auf
 * und ist dort per RCon steuerbar — ohne dass der Kunde irgendwo Zugangsdaten
 * abtippen muss: Er vergibt sie ohnehin gerade beim Anlegen.
 *
 * Die Adresse schicken wir bewusst nicht mit. DZPage nimmt die Quelladresse der
 * Anfrage, und das ist die oeffentliche Adresse dieser Maschine — dieselbe,
 * unter der auch die Spieler den Server finden. Die Anfrage geht deshalb ueber
 * IPv4 (DzpageClient.registerServer): RCon spricht nur IPv4.
 */

function client(app) {
  return new DzpageClient({ baseUrl: app.config.dzpage.baseUrl, key: app.config.dzpage.key });
}

export async function registerServerWithDzpage(app, server) {
  const panelId = await getSetting(app.db, KEYS.dzpagePanelId);
  if (!panelId) return { ok: false, code: "not_linked", message: "Das Panel ist noch nicht mit DZPage verbunden." };

  const password = rconPassword(server, app.config.secrets.encryption);
  if (!password) return { ok: false, code: "rcon_password", message: "Das RCon-Passwort laesst sich nicht entschluesseln." };

  const result = await client(app).registerServer({
    panelId,
    serverId: server.id,
    name: server.name,
    rconPort: server.rcon_port,
    queryPort: server.query_port,
    rconPassword: password,
  });

  if (!result.ok) {
    log.warn(`Server ${server.id} konnte nicht bei DZPage angemeldet werden (${result.code})`);
    return { ok: false, code: result.code, message: `DZPage hat abgelehnt: ${result.code}` };
  }

  await updateServer(app.db, server.id, { dzpage_server_id: result.serverId });
  (app.dzpageRegistered ??= new Set()).add(server.id);

  // DZPage hat nur eine IPv6-Adresse gesehen: Der Server steht dort, aber RCon
  // von dzpage.com aus geht nicht. Ohne IPv4 finden ihn auch die Spieler nicht.
  const rcon = !(result.warning === "ipv6_source" || result.rcon === false);
  if (rcon) {
    await recordEvent(app.db, {
      kind: "server.register",
      source: "dzpage",
      message: `${server.name} bei DZPage angemeldet (${result.host})`,
    });
    log.info(`Server ${server.id} bei DZPage angemeldet: ${result.serverId} (${result.host})`);
  } else {
    const why = result.via === "fallback" ? ` Über IPv4 kam keine Verbindung zustande (${result.ipv4Error}).` : "";
    await recordEvent(app.db, {
      kind: "server.register.ipv6",
      source: "dzpage",
      message: `${server.name} bei DZPage angemeldet, aber nur mit der IPv6-Adresse ${result.host}. RCon von dzpage.com aus braucht IPv4 und bleibt aus.${why}`,
    });
    log.warn(`Server ${server.id} bei DZPage nur über IPv6 angemeldet (${result.host}), RCon bleibt aus.${why}`);
  }
  return { ok: true, serverId: result.serverId, host: result.host, rcon, warning: result.warning ?? null };
}

/**
 * Was beim naechsten Herzschlag wieder klappen kann. Alles andere (DZPage lehnt
 * die Angaben ab, Passwort nicht lesbar) wird durch Wiederholen nicht besser.
 */
const RETRY_CODES = new Set([
  "network",
  "server",
  "rate_limited",
  "not_found",
  "unknown_panel",
  "revoked",
  "invalid_key",
  "missing_key",
  "not_linked",
]);

/**
 * Einmal nach dem Update auf die Fassung mit IPv4-Anmeldung: alle schon
 * angemeldeten Server neu anmelden. Bis dahin ging die Anmeldung auf Maschinen
 * mit IPv6 ueber IPv6, und DZPage hat diese Adresse als RCon-Host gespeichert.
 * Die Route ist dafuer gebaut: gleiche Panel- und Server-ID ergibt dieselbe
 * Zeile, die Adresse wird berichtigt, Zeitplaene bleiben.
 *
 * Laeuft nach jedem gelungenen Herzschlag, bis alles durch ist. Server, die in
 * diesem Lauf schon angemeldet wurden, kommen nicht noch einmal dran.
 */
export function reregisterServersOnce(app) {
  app.dzpageReregistering ??= reregister(app).finally(() => {
    app.dzpageReregistering = null;
  });
  return app.dzpageReregistering;
}

async function reregister(app) {
  if (await getSetting(app.db, KEYS.dzpageServersIpv4At)) return { done: true, registered: 0 };

  const servers = (await listServers(app.db)).filter(
    (server) => server.dzpage_server_id && !app.dzpageRegistered?.has(server.id),
  );
  let registered = 0;
  let retry = false;
  for (const listed of servers) {
    // Frisch lesen: Ein Server, der gerade geloescht wird, soll bei DZPage
    // nicht wieder auftauchen.
    const server = await getServer(app.db, listed.id);
    if (!server?.dzpage_server_id) continue;
    const result = await registerServerWithDzpage(app, server).catch((err) => ({
      ok: false,
      code: "network",
      message: err.message,
    }));
    if (result.ok) registered += 1;
    else if (RETRY_CODES.has(result.code)) retry = true;
  }
  if (retry) {
    log.warn("Neuanmeldung der Server bei DZPage noch nicht vollständig, nächster Versuch beim nächsten Herzschlag.");
    return { done: false, registered };
  }

  await setSetting(app.db, KEYS.dzpageServersIpv4At, Date.now());
  if (servers.length) log.info(`${registered} von ${servers.length} Servern bei DZPage neu angemeldet.`);
  return { done: true, registered };
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
