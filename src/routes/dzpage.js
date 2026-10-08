import { hostname } from "node:os";
import { PANEL_KEY_PREFIX } from "../dzpage/client.js";
import { adoptKey } from "../dzpage/pairing.js";
import { csrfInput, escapeHtml, field, notice, stepper } from "../http/html.js";
import { log } from "../log.js";

/**
 * Schritt 4: Verbindung zum DZPage-Konto. Der Panel-Schluessel muss vorher auf
 * DZPage erstellt worden sein — er ist das einzige, was der Assistent von uns
 * braucht, und er beweist gleichzeitig den Besitz des Kontos.
 */

function form(rc, { name, message = null, messageKind = "error" } = {}) {
  const t = rc.t;
  const keyUrl = `${rc.config.dzpage.baseUrl}/rcon`;
  return `
    <h1>${escapeHtml(t("setup.dzpage.heading"))}</h1>
    <p class="lede">${escapeHtml(t("setup.dzpage.lede", { url: keyUrl }))}</p>
    ${message ? notice(messageKind, message) : ""}
    <form method="post" action="/dzpage">
      ${csrfInput(rc.csrf)}
      ${field({
        name: "key",
        label: t("setup.dzpage.key"),
        // Der Schluessel wird nach einem Fehlversuch nicht zurueckgeschrieben:
        // ein Bearer-Geheimnis hat in einer Seite nichts zu suchen.
        value: "",
        hint: t("setup.dzpage.keyHint"),
        required: true,
      })}
      ${field({
        name: "name",
        label: t("setup.dzpage.name"),
        value: name,
        hint: t("setup.dzpage.nameHint"),
        required: true,
      })}
      <div class="actions">
        <button class="primary" type="submit">${escapeHtml(t("setup.dzpage.connect"))}</button>
      </div>
    </form>`;
}

function errorMessage(rc, result) {
  const key = `setup.dzpage.err.${result.code}`;
  const text = rc.t(key, { message: result.message ?? "", status: result.status ?? "" });
  return text === key ? rc.t("setup.dzpage.err.server", { status: result.status ?? result.code }) : text;
}

export async function connect(rc) {
  const progress = await rc.app.setupProgress();
  const inSetup = !progress.completed;
  const defaultName = rc.config.dzpage.panelName || hostname();

  const render = (status, body) => {
    const inner = `<div class="card">${body}</div>`;
    rc.page(status, rc.t("setup.step.dzpage"), inSetup ? `${stepper(rc.t, 4)}${inner}` : inner, {
      nav: !inSetup,
    });
  };

  if (rc.method === "GET") {
    render(200, form(rc, { name: defaultName }));
    return;
  }

  const key = (rc.form.get("key") || "").trim();
  const name = (rc.form.get("name") || "").trim().slice(0, 60) || hostname();

  if (!key.startsWith(PANEL_KEY_PREFIX)) {
    render(400, form(rc, { name, message: rc.t("setup.dzpage.err.missing_key") }));
    return;
  }

  const result = await adoptKey({ config: rc.config, db: rc.app.db, key, name });
  if (!result.ok) {
    log.warn(`Anmeldung bei DZPage fehlgeschlagen (${result.code})`);
    render(400, form(rc, { name, message: errorMessage(rc, result) }));
    return;
  }
  log.info(`Panel bei DZPage angemeldet: ${result.panelId}`);
  // Beide Schleifen brauchen den Schluessel, den es beim Start des Dienstes
  // noch nicht gab — ohne den Neustart des Abholers bliebe der erste Auftrag
  // von DZPage bis zum naechsten Dienstneustart liegen.
  rc.app.heartbeat?.restart();
  rc.app.poller?.restart();

  if (inSetup) {
    rc.redirect("/setup/done");
    return;
  }
  render(
    200,
    `${notice("ok", rc.t("setup.dzpage.connected", { account: result.account || "" }))}
     ${form(rc, { name })}`,
  );
}
