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
    `${pageHead({
      title: t("updates.title"),
      lede: t("updates.lede"),
      actions: `<form method="post" action="/updates" class="inline">
          ${csrfInput(rc.csrf)}
          <button class="btn secondary" type="submit" name="action" value="check">${icon(
            "restart",
          )}${escapeHtml(t("updates.checkNow"))}</button>
        </form>`,
    })}
     ${message ? notice(messageKind, message) : ""}
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
