import { getSettings, KEYS, setSetting } from "../store/settings.js";
import { listServers, SERVER_ID_PATTERN, updateServer } from "../store/servers.js";
import { recordEvent } from "../store/events.js";
import {
  DEFAULT_INTERVAL_MINUTES,
  INTERVAL_CHOICES,
  UPDATE_MODES,
  installedBuildId,
  startUpdateCheck,
} from "../servers/updates.js";
import {
  applyPanelUpdate,
  checkPanelUpdate,
  compareVersions,
  DEFAULT_PANEL_UPDATE_MODE,
  PANEL_UPDATE_MODES,
  readPanelUpdateState,
} from "../panel/updates.js";
import { canSelfUpdate, repositoryUrl } from "../panel/installation.js";
import {
  card,
  csrfInput,
  escapeHtml,
  emptyState,
  icon,
  notice,
  pageHead,
  pill,
  relativeTime,
  tile,
} from "../http/html.js";
import { log } from "../log.js";

/**
 * Die Update-Pruefung einrichten: Zeitplan fuer alle, Verhalten je Server.
 *
 * Die Trennung ist Absicht. Die Frage "steht etwas Neues bereit?" gilt fuer das
 * ganze Panel — es ist eine App bei Steam. Die Antwort auf "was soll dann
 * passieren?" gehoert dagegen zum einzelnen Server: ein Testserver darf sich
 * selbst aktualisieren, der Server mit 40 Leuten drauf besser nicht.
 */

/** Wie ein Server im Vergleich zu Steam dasteht. */
export function updateState(installed, available) {
  if (!installed) return "unknown";
  if (!available) return "unchecked";
  return installed === available ? "current" : "outdated";
}

function statePill(t, state) {
  const kind = state === "current" ? "ok" : state === "outdated" ? "warn" : "off";
  return pill(kind, t(`updates.state.${state}`));
}

function modeSelect(t, server) {
  const options = UPDATE_MODES.map(
    (mode) =>
      `<option value="${mode}"${server.update_mode === mode ? " selected" : ""}>${escapeHtml(
        t(`updates.mode.${mode}`),
      )}</option>`,
  ).join("");
  return `<select class="sm" name="mode_${escapeHtml(server.id)}" aria-label="${escapeHtml(
    t("updates.mode.heading"),
  )}">${options}</select>`;
}

function intervalSelect(t, minutes) {
  const label = (choice) => {
    if (choice < 60) return t("updates.every.minutes", { value: choice });
    if (choice === 60) return t("updates.every.hour");
    return t("updates.every.hours", { value: choice / 60 });
  };
  const options = INTERVAL_CHOICES.map(
    (choice) =>
      `<option value="${choice}"${choice === minutes ? " selected" : ""}>${escapeHtml(label(choice))}</option>`,
  ).join("");
  return `<select class="sm" name="interval" id="f_interval">${options}</select>`;
}

/* ------------------------------------------------------------ Das Panel selbst */

function panelModeSelect(t, mode) {
  const options = PANEL_UPDATE_MODES.map(
    (choice) =>
      `<option value="${choice}"${choice === mode ? " selected" : ""}>${escapeHtml(
        t(`panel.mode.${choice}`),
      )}</option>`,
  ).join("");
  return `<select class="sm" name="panelMode" id="f_panel_mode">${options}</select>`;
}

/**
 * Die Karte fuer das Panel selbst. Sie steht ueber den Spielservern, weil sie
 * die naheliegendere Frage beantwortet: "Bin ich selbst aktuell?" — und weil
 * eine Aktualisierung des Panels der einzige Vorgang auf dieser Seite ist, der
 * die Oberflaeche kurz verschwinden laesst.
 */
function panelCard(t, state, csrf) {
  const kind = state.newer ? "warn" : state.latest ? "ok" : "off";
  const stateText = state.newer
    ? t("panel.state.outdated")
    : state.latest
      ? t("panel.state.current")
      : t("panel.state.unchecked");

  const source = repositoryUrl(state.installation);
  const rows = [
    [t("panel.installed"), `<span class="mono">${escapeHtml(state.current)}</span>`],
    [
      t("panel.latest"),
      `<span class="mono">${escapeHtml(state.latest || "—")}</span> ${state.error ? "" : pill(kind, stateText)}`,
    ],
    [
      t("panel.checked"),
      escapeHtml(
        state.checkedAt ? t("time.ago", { value: relativeTime(t, state.checkedAt) }) : t("common.never"),
      ),
    ],
    [
      t("panel.source"),
      source
        ? `<a href="${escapeHtml(source)}" rel="noreferrer noopener external">${escapeHtml(source)}</a>`
        : escapeHtml(t("panel.source.manual")),
    ],
  ];

  // Ein Panel, das von Hand kopiert wurde, darf sich nicht selbst ueberschreiben
  // — es weiss nicht, was der Mensch dort sonst noch abgelegt hat.
  const selfUpdating = canSelfUpdate(state.installation);
  // Ein gescheiterter Versuch bleibt stehen, solange er etwas erklaert: Er sagt,
  // warum diese Fassung noch laeuft. Ist die betroffene Fassung inzwischen
  // ueberholt, hat die Meldung ihren Zweck erfuellt.
  const failed = state.result?.state === "failed" && compareVersions(state.result.to, state.current) > 0;
  const notices = [
    state.error ? notice("error", t("panel.err.check", { message: state.error })) : "",
    failed
      ? notice("error", t("panel.result.failed", { version: state.result.to, message: state.result.message }))
      : "",
    state.newer && !selfUpdating ? notice("warn", t("panel.manual", { version: state.latest })) : "",
  ].join("");

  return card(
    `${notices}
     <form method="post" action="/updates">
       ${csrfInput(csrf)}
       <table class="status">${rows
         .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
         .join("")}</table>
       <p class="field">
         <label for="f_panel_mode">${escapeHtml(t("panel.mode.heading"))}</label>
         ${panelModeSelect(t, state.mode)}
       </p>
       <p class="hint">${escapeHtml(t("panel.mode.hint"))}</p>
       <div class="actions">
         <button class="btn secondary" type="submit" name="action" value="panel-mode">${escapeHtml(
           t("common.save"),
         )}</button>
         <button class="btn secondary" type="submit" name="action" value="panel-check">${icon(
           "restart",
         )}${escapeHtml(t("panel.checkNow"))}</button>
         ${
           state.newer && selfUpdating
             ? `<button class="btn primary" type="submit" name="action" value="panel-install">${icon(
                 "download",
               )}${escapeHtml(t("panel.install", { version: state.latest }))}</button>`
             : ""
         }
       </div>
     </form>`,
    { title: t("panel.heading"), sub: t("panel.sub") },
  );
}

async function readState(rc) {
  const settings = await getSettings(rc.app.db, [
    KEYS.updateCheckEnabled,
    KEYS.updateCheckInterval,
    KEYS.updateCheckedAt,
    KEYS.updateAvailableBuild,
    KEYS.updatePublishedAt,
    KEYS.updateLastError,
  ]);
  const servers = (await listServers(rc.app.db)).map((server) => {
    // Direkt aus den Spieldateien lesen: dann stimmt die Anzeige auch nach
    // einer Aktualisierung von Hand, ohne auf die naechste Pruefung zu warten.
    const installed = installedBuildId(server.id) ?? server.installed_build ?? null;
    return { ...server, installed, state: updateState(installed, settings[KEYS.updateAvailableBuild]) };
  });
  return {
    enabled: settings[KEYS.updateCheckEnabled] === "1",
    interval: Number(settings[KEYS.updateCheckInterval]) || DEFAULT_INTERVAL_MINUTES,
    checkedAt: Number(settings[KEYS.updateCheckedAt]) || null,
    available: settings[KEYS.updateAvailableBuild],
    publishedAt: Number(settings[KEYS.updatePublishedAt]) || null,
    error: settings[KEYS.updateLastError] || "",
    servers,
  };
}

export async function page(rc, { message = null, messageKind = "ok" } = {}) {
  const t = rc.t;
  const state = await readState(rc);
  const panelState = await readPanelUpdateState(rc.app.db);
  const outdated = state.servers.filter((server) => server.state === "outdated");
  const automatic = state.servers.filter((server) => server.update_mode === "auto");

  const tiles = [
    tile({
      label: t("updates.tile.public"),
      value: state.available || "—",
      sub: state.publishedAt ? t("updates.published", { when: relativeTime(t, state.publishedAt) }) : "",
      iconName: "download",
    }),
    tile({
      label: t("updates.tile.checked"),
      value: state.checkedAt ? t("time.ago", { value: relativeTime(t, state.checkedAt) }) : t("common.never"),
      sub: state.enabled
        ? t("updates.tile.scheduleOn", {
            value: state.interval < 60 ? `${state.interval} min` : `${state.interval / 60} h`,
          })
        : t("updates.tile.scheduleOff"),
      iconName: "clock",
    }),
    tile({
      label: t("updates.tile.outdated"),
      value: String(outdated.length),
      sub: t("updates.tile.ofServers", { value: state.servers.length }),
      iconName: "server",
      tone: outdated.length ? "warn" : "ok",
    }),
    tile({
      label: t("updates.tile.automatic"),
      value: String(automatic.length),
      sub: t("updates.tile.automaticSub"),
      iconName: "restart",
    }),
  ].join("");

  const scheduleCard = card(
    `<form method="post" action="/updates">
       ${csrfInput(rc.csrf)}
       <label class="switch">
         <input type="checkbox" name="enabled" value="1"${state.enabled ? " checked" : ""}>
         <span>${escapeHtml(t("updates.schedule.enable"))}</span>
       </label>
       <p class="hint">${escapeHtml(t("updates.schedule.hint"))}</p>
       <p class="field">
         <label for="f_interval">${escapeHtml(t("updates.schedule.interval"))}</label>
         ${intervalSelect(t, state.interval)}
       </p>
       <div class="actions">
         <button class="btn primary" type="submit" name="action" value="schedule">${escapeHtml(
           t("common.save"),
         )}</button>
         <button class="btn secondary" type="submit" name="action" value="check">${icon(
           "restart",
         )}${escapeHtml(t("updates.checkNow"))}</button>
       </div>
     </form>`,
    { title: t("updates.schedule.heading"), sub: t("updates.schedule.sub") },
  );

  const rows = state.servers
    .map(
      (server) => `<tr>
        <td><a href="/server?id=${escapeHtml(server.id)}">${escapeHtml(server.name)}</a></td>
        <td class="num">${escapeHtml(server.installed || "—")}</td>
        <td>${statePill(t, server.state)}</td>
        <td>${modeSelect(t, server)}</td>
      </tr>`,
    )
    .join("");

  const serverCard = state.servers.length
    ? card(
        `<form method="post" action="/updates">
           ${csrfInput(rc.csrf)}
           <div class="table-wrap">
             <table class="data">
               <thead><tr>
                 <th>${escapeHtml(t("servers.name"))}</th>
                 <th>${escapeHtml(t("updates.installed"))}</th>
                 <th>${escapeHtml(t("servers.state.heading"))}</th>
                 <th>${escapeHtml(t("updates.mode.heading"))}</th>
               </tr></thead>
               <tbody>${rows}</tbody>
             </table>
           </div>
           <div class="actions">
             <button class="btn primary" type="submit" name="action" value="modes">${escapeHtml(
               t("common.save"),
             )}</button>
           </div>
           <p class="hint">${escapeHtml(t("updates.mode.autoWarning"))}</p>
         </form>`,
        { title: t("updates.servers.heading"), sub: t("updates.servers.sub") },
      )
    : card(
        emptyState({
          iconName: "server",
          text: t("servers.empty"),
          action: `<a class="btn primary" href="/servers/new">${icon("plus")}${escapeHtml(t("servers.new"))}</a>`,
        }),
        { title: t("updates.servers.heading") },
      );

  rc.page(
    200,
    t("updates.title"),
    `${pageHead({ title: t("updates.title"), lede: t("updates.lede") })}
     ${message ? notice(messageKind, message) : ""}
     ${panelCard(t, panelState, rc.csrf)}
     ${state.error ? notice("error", t("updates.err.check", { message: state.error })) : ""}
     <div class="tiles">${tiles}</div>
     ${scheduleCard}
     ${serverCard}`,
  );
}

export async function index(rc) {
  if (rc.method === "POST") {
    await save(rc);
    return;
  }
  await page(rc);
}

export async function save(rc) {
  const action = rc.form.get("action");

  /* --------------------------------------------------- Das Panel selbst */

  if (action === "panel-mode") {
    const wanted = rc.form.get("panelMode");
    const mode = PANEL_UPDATE_MODES.includes(wanted) ? wanted : DEFAULT_PANEL_UPDATE_MODE;
    await setSetting(rc.app.db, KEYS.panelUpdateMode, mode);
    await recordEvent(rc.app.db, {
      kind: "panel.update.mode",
      message: `Verhalten bei neuen Panel-Fassungen: ${mode}`,
    });
    await page(rc, { message: rc.t("updates.saved") });
    return;
  }

  if (action === "panel-check") {
    try {
      const result = await checkPanelUpdate(rc.app);
      await page(rc, {
        message: result.newer
          ? rc.t("panel.found", { version: result.latest })
          : rc.t("panel.upToDate", { version: result.current }),
        messageKind: result.newer ? "warn" : "ok",
      });
    } catch (err) {
      await page(rc, { message: rc.t("panel.err.check", { message: err.message }), messageKind: "error" });
    }
    return;
  }

  if (action === "panel-install") {
    // Die Fassung kommt aus der letzten Pruefung, nicht aus dem Formular: Was
    // ausgerollt wird, darf nicht davon abhaengen, was jemand ins Feld schreibt.
    const state = await readPanelUpdateState(rc.app.db);
    if (!state.newer) {
      await page(rc, { message: rc.t("panel.upToDate", { version: state.current }) });
      return;
    }
    try {
      await applyPanelUpdate(rc.app, state.latest);
      // Die Antwort geht noch raus, dann uebernimmt der Aktualisierungslauf und
      // das Panel verschwindet fuer ein paar Sekunden.
      await page(rc, { message: rc.t("panel.started", { version: state.latest }), messageKind: "warn" });
    } catch (err) {
      log.warn(`Selbstaktualisierung nicht gestartet: ${err.message}`);
      await page(rc, { message: rc.t("panel.err.install", { message: err.message }), messageKind: "error" });
    }
    return;
  }

  /* ------------------------------------------------------ Die Spielserver */

  if (action === "check") {
    const started = startUpdateCheck(rc.app, { apply: false });
    if (!started.ok) {
      await page(rc, { message: rc.t("setup.steam.busy"), messageKind: "warn" });
      return;
    }
    rc.redirect(`/job?id=${started.job.id}&back=${encodeURIComponent("/updates")}`);
    return;
  }

  if (action === "schedule") {
    const enabled = rc.form.get("enabled") === "1";
    const wanted = Number(rc.form.get("interval"));
    const interval = INTERVAL_CHOICES.includes(wanted) ? wanted : DEFAULT_INTERVAL_MINUTES;
    await setSetting(rc.app.db, KEYS.updateCheckEnabled, enabled ? "1" : "0");
    await setSetting(rc.app.db, KEYS.updateCheckInterval, interval);
    await recordEvent(rc.app.db, {
      kind: "update.schedule",
      message: enabled
        ? `Update-Prüfung eingeschaltet (alle ${interval} Minuten)`
        : "Update-Prüfung ausgeschaltet",
    });
    log.info(`Update-Prüfung ${enabled ? "ein" : "aus"}, Abstand ${interval} min`);
    await page(rc, { message: rc.t("updates.saved") });
    return;
  }

  if (action === "modes") {
    let changed = 0;
    for (const server of await listServers(rc.app.db)) {
      if (!SERVER_ID_PATTERN.test(server.id)) continue;
      const wanted = rc.form.get(`mode_${server.id}`);
      if (!UPDATE_MODES.includes(wanted) || wanted === server.update_mode) continue;
      await updateServer(rc.app.db, server.id, { update_mode: wanted });
      changed += 1;
    }
    if (changed) {
      await recordEvent(rc.app.db, {
        kind: "update.mode",
        message: `Update-Verhalten für ${changed} Server geändert`,
      });
    }
    await page(rc, { message: rc.t("updates.saved") });
    return;
  }

  rc.notFound();
}
