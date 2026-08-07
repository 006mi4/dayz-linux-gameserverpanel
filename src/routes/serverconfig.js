import { checkServerInput, getServer, rconPassword, updateServer } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import {
  checkCfgEntry,
  defaultConfig,
  serverConfig,
  serverDzCfg,
  writeServerFiles,
} from "../servers/config.js";
import { registerServerWithDzpage } from "../dzpage/servers.js";
import { card, csrfInput, escapeHtml, field, notice, pageHead } from "../http/html.js";
import { log } from "../log.js";

/**
 * Die serverDZ.cfg bearbeiten.
 *
 * Zwei Haelften, weil es zwei verschiedene Dinge sind:
 *
 * - **Grundwerte** (Name, Spielerzahl, Mission) stehen in der Datenbank, weil
 *   das Panel sie auch anderswo braucht — in der Uebersicht und bei der
 *   Anmeldung an DZPage. Sie erscheinen trotzdem hier, denn wer "die
 *   Konfiguration bearbeiten" sucht, sucht auch den Servernamen.
 * - **Alles Uebrige** ist eine freie Liste aus Schluessel und Wert. Damit
 *   laesst sich jeder Wert aendern, den DayZ kennt, und jeder hinzufuegen, den
 *   dieses Panel nicht kennt — ohne dass daraus ein Feld im Programm werden
 *   muss.
 *
 * Die Ports fehlen mit Absicht: Sie haengen an der Anmeldung bei DZPage, an
 * BattlEye und an der Portpruefung gegen die anderen Server. Ein Port ist
 * keine Einstellung, sondern die Identitaet des Servers.
 */

function entryRows(t, entries) {
  return entries
    .map(
      ([key, value], index) => `<tr>
        <td><input class="mono" type="text" name="k_${index}" value="${escapeHtml(key)}"
              aria-label="${escapeHtml(t("cfg.key"))}" autocapitalize="off" autocorrect="off" spellcheck="false"></td>
        <td><input class="mono" type="text" name="v_${index}" value="${escapeHtml(value)}"
              aria-label="${escapeHtml(t("cfg.value"))}" autocapitalize="off" autocorrect="off" spellcheck="false"></td>
        <td class="mid"><input type="checkbox" name="del_${index}" value="1"
              aria-label="${escapeHtml(t("cfg.remove"))}"></td>
      </tr>`,
    )
    .join("");
}

function page(rc, server, { entries, message = null, messageKind = "ok", values = {} } = {}) {
  const t = rc.t;
  const preview = serverDzCfg({ ...server, config_json: JSON.stringify(entries) });
  const value = (name, fallback) => escapeHtml(values[name] ?? fallback);

  const basics = card(
    `<form method="post" action="/server/config">
       ${csrfInput(rc.csrf)}
       <input type="hidden" name="id" value="${escapeHtml(server.id)}">
       ${field({ name: "name", label: t("servers.name"), value: value("name", server.name), required: true })}
       <div class="row">
         ${field({
           name: "maxPlayers",
           label: t("servers.maxPlayers"),
           value: value("maxPlayers", String(Number(server.max_players))),
           inputmode: "numeric",
         })}
         ${field({ name: "mission", label: t("servers.mission"), value: value("mission", server.mission) })}
       </div>
       <table class="status">
         <tr><th>${escapeHtml(t("servers.ports"))}</th>
             <td><span class="mono">${Number(server.game_port)} · ${Number(server.query_port)} · ${Number(
               server.rcon_port,
             )}</span></td></tr>
       </table>
       <p class="hint">${escapeHtml(t("cfg.portsFixed"))}</p>
       <div class="actions">
         <button class="btn primary" type="submit" name="action" value="basics">${escapeHtml(
           t("common.save"),
         )}</button>
       </div>
     </form>`,
    { title: t("cfg.basics.heading"), sub: t("cfg.basics.sub") },
  );

  const entriesCard = card(
    `<form method="post" action="/server/config">
       ${csrfInput(rc.csrf)}
       <input type="hidden" name="id" value="${escapeHtml(server.id)}">
       <div class="table-wrap">
         <table class="data cfg">
           <thead><tr>
             <th>${escapeHtml(t("cfg.key"))}</th>
             <th>${escapeHtml(t("cfg.value"))}</th>
             <th class="mid">${escapeHtml(t("cfg.remove"))}</th>
           </tr></thead>
           <tbody>
             ${entryRows(t, entries)}
             <tr>
               <td><input class="mono" type="text" name="newKey" value="${value("newKey", "")}"
                     placeholder="${escapeHtml(t("cfg.newKey"))}" aria-label="${escapeHtml(t("cfg.newKey"))}"
                     autocapitalize="off" autocorrect="off" spellcheck="false"></td>
               <td><input class="mono" type="text" name="newValue" value="${value("newValue", "")}"
                     placeholder="${escapeHtml(t("cfg.newValue"))}" aria-label="${escapeHtml(t("cfg.newValue"))}"
                     autocapitalize="off" autocorrect="off" spellcheck="false"></td>
               <td></td>
             </tr>
           </tbody>
         </table>
       </div>
       <p class="hint">${escapeHtml(t("cfg.entriesHint"))}</p>
       <div class="actions">
         <button class="btn primary" type="submit" name="action" value="entries">${escapeHtml(
           t("common.save"),
         )}</button>
         <button class="btn secondary" type="submit" name="action" value="defaults">${escapeHtml(
           t("cfg.defaults"),
         )}</button>
       </div>
     </form>`,
    { title: t("cfg.entries.heading"), sub: t("cfg.entries.sub") },
  );

  rc.page(
    200,
    `${t("cfg.title")} · ${server.name}`,
    `${pageHead({
      title: t("cfg.title"),
      lede: t("cfg.lede", { name: server.name }),
      actions: `<a class="btn secondary" href="/server?id=${escapeHtml(server.id)}">${escapeHtml(
        t("common.back"),
      )}</a>`,
    })}
     ${message ? notice(messageKind, message) : ""}
     ${basics}
     ${entriesCard}
     ${card(`<pre class="log">${escapeHtml(preview)}</pre>`, {
       title: t("cfg.preview.heading"),
       sub: t("cfg.preview.sub"),
     })}`,
  );
}

export async function index(rc) {
  const server = await getServer(rc.app.db, rc.url.searchParams.get("id"));
  if (!server) {
    rc.notFound();
    return;
  }
  page(rc, server, { entries: serverConfig(server) });
}

/** Datei neu schreiben — sonst wirkt keine Aenderung. */
function writeFiles(rc, server) {
  writeServerFiles(server, rconPassword(server, rc.config.secrets.encryption));
}

export async function save(rc) {
  const server = await getServer(rc.app.db, rc.form.get("id"));
  const action = rc.form.get("action");
  if (!server) {
    rc.notFound();
    return;
  }

  if (action === "defaults") {
    const entries = defaultConfig(server);
    await updateServer(rc.app.db, server.id, { config_json: JSON.stringify(entries) });
    const fresh = await getServer(rc.app.db, server.id);
    writeFiles(rc, fresh);
    await recordEvent(rc.app.db, {
      kind: "server.config",
      message: `${server.name}: Konfiguration auf den Auslieferungszustand zurückgesetzt`,
    });
    page(rc, fresh, { entries, message: rc.t("cfg.saved") });
    return;
  }

  if (action === "basics") {
    // Dieselbe Pruefung wie beim Anlegen, damit hier nichts durchkommt, was
    // dort abgewiesen wuerde. Ports und RCon-Passwort bleiben, wie sie sind.
    const checked = checkServerInput({
      name: rc.form.get("name"),
      gamePort: String(server.game_port),
      queryPort: String(server.query_port),
      rconPort: String(server.rcon_port),
      rconPassword: rconPassword(server, rc.config.secrets.encryption) || "platzhalter",
      maxPlayers: rc.form.get("maxPlayers"),
      mission: rc.form.get("mission"),
      memoryMaxMb: String(server.memory_max_mb),
      cpuQuota: String(server.cpu_quota),
    });
    const values = {
      name: rc.form.get("name"),
      maxPlayers: rc.form.get("maxPlayers"),
      mission: rc.form.get("mission"),
    };
    if (!checked.ok) {
      page(rc, server, {
        entries: serverConfig(server),
        values,
        message: rc.t(`servers.err.${checked.code}`),
        messageKind: "error",
      });
      return;
    }

    await updateServer(rc.app.db, server.id, {
      name: checked.value.name,
      max_players: checked.value.maxPlayers,
      mission: checked.value.mission,
    });
    const fresh = await getServer(rc.app.db, server.id);
    writeFiles(rc, fresh);
    await recordEvent(rc.app.db, {
      kind: "server.config",
      message: `${fresh.name}: Grundwerte geändert`,
    });

    // Steht der Server schon bei DZPage, gehoert der neue Name auch dorthin —
    // sonst heisst er dort weiter, wie er einmal hiess. Ein Fehlschlag darf die
    // Aenderung aber nicht zurueckdrehen.
    let message = rc.t("cfg.savedRestart");
    if (fresh.dzpage_server_id) {
      const result = await registerServerWithDzpage(rc.app, fresh).catch((err) => ({
        ok: false,
        message: err.message,
      }));
      if (!result.ok) {
        log.warn(`Name bei DZPage nicht nachgezogen: ${result.message}`);
        message = `${message} ${rc.t("cfg.dzpageStale")}`;
      }
    }
    page(rc, fresh, { entries: serverConfig(fresh), message });
    return;
  }

  if (action !== "entries") {
    rc.notFound();
    return;
  }

  /* ------------------------------------------------- Die Liste der Werte */

  const current = serverConfig(server);
  const entries = [];
  const values = {};
  let error = null;

  for (let index = 0; index < current.length; index += 1) {
    if (rc.form.get(`del_${index}`) === "1") continue;
    const key = rc.form.get(`k_${index}`);
    // Feld gar nicht dabei? Dann bleibt der gespeicherte Wert stehen. Ein
    // Formular, das nur einen Teil mitschickt, darf nichts loeschen — geloescht
    // wird ueber das Kaestchen.
    if (key === null) {
      entries.push(current[index]);
      continue;
    }
    const checked = checkCfgEntry(key, rc.form.get(`v_${index}`));
    if (!checked.ok) {
      error = rc.t(`cfg.err.${checked.code}`, { key });
      break;
    }
    entries.push(checked.value);
  }

  const newKey = String(rc.form.get("newKey") || "").trim();
  if (!error && newKey) {
    const checked = checkCfgEntry(newKey, rc.form.get("newValue"));
    if (!checked.ok) {
      error = rc.t(`cfg.err.${checked.code}`, { key: newKey });
      values.newKey = newKey;
      values.newValue = rc.form.get("newValue") || "";
    } else {
      entries.push(checked.value);
    }
  }

  // Zwei gleiche Schluessel ergeben zwei Zeilen in der Datei, und welche davon
  // gilt, entscheidet DayZ — nicht der Mensch, der sie eingetragen hat.
  if (!error) {
    const seen = new Set();
    for (const [key] of entries) {
      if (seen.has(key)) {
        error = rc.t("cfg.err.cfg_key_twice", { key });
        break;
      }
      seen.add(key);
    }
  }

  if (error) {
    page(rc, server, { entries: current, values, message: error, messageKind: "error" });
    return;
  }

  await updateServer(rc.app.db, server.id, { config_json: JSON.stringify(entries) });
  const fresh = await getServer(rc.app.db, server.id);
  writeFiles(rc, fresh);
  await recordEvent(rc.app.db, {
    kind: "server.config",
    message: `${fresh.name}: ${entries.length} Werte in serverDZ.cfg`,
  });
  log.info(`Konfiguration von ${server.id} gespeichert (${entries.length} Werte)`);
  page(rc, fresh, { entries, message: rc.t("cfg.savedRestart") });
}

export async function route(rc) {
  if (rc.method === "POST") {
    await save(rc);
    return;
  }
  await index(rc);
}
