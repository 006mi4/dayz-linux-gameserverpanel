import { getSettings, KEYS } from "../store/settings.js";
import { listEvents } from "../store/events.js";
import { listServers } from "../store/servers.js";
import { installedBuildId } from "../servers/updates.js";
import {
  card,
  dot,
  escapeHtml,
  emptyState,
  icon,
  pageHead,
  pill,
  relativeTime,
  tile,
} from "../http/html.js";
import { serverRow, withState } from "./servers.js";

/**
 * Startseite. Sie entscheidet nur, wohin: in den Assistenten, zur Anmeldung
 * oder in die Uebersicht.
 */
export async function root(rc) {
  const progress = await rc.app.setupProgress();
  if (!progress.completed) {
    rc.redirect(progress.hasAdmin && rc.user ? progress.next : "/setup");
    return;
  }
  if (!rc.user) {
    rc.redirect("/login");
    return;
  }
  await dashboard(rc);
}

/** Farbe des Punkts vor einem Ereignis: nur Fehler stechen heraus. */
function eventDot(kind) {
  if (/fail|error/i.test(kind)) return "bad";
  if (/^update\.|\.ipv6$/.test(kind)) return "warn";
  return "off";
}

async function dashboard(rc) {
  const t = rc.t;
  const settings = await getSettings(rc.app.db, [
    KEYS.steamAccount,
    KEYS.steamLoggedInAt,
    KEYS.dzpageAccount,
    KEYS.dzpagePanelId,
    KEYS.dzpageLastSeenAt,
    KEYS.dzpageKeyRejected,
    KEYS.updateAvailableBuild,
    KEYS.updateCheckedAt,
  ]);

  const rows = await withState(rc, await listServers(rc.app.db));
  const running = rows.filter(({ status }) => status.state === "running").length;
  const available = settings[KEYS.updateAvailableBuild];
  const outdated = available
    ? rows.filter(({ server }) => {
        const installed = installedBuildId(server.id) ?? server.installed_build;
        return server.install_state === "ready" && installed && installed !== available;
      }).length
    : 0;

  const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const tiles = [
    tile({
      label: t("dash.tile.servers"),
      value: String(rows.length),
      sub: t("dash.tile.serversRunning", { value: running }),
      iconName: "server",
    }),
    tile({
      label: t("dash.tile.gameFiles"),
      value: available || "-",
      sub: available
        ? outdated
          ? t("dash.tile.outdated", { value: outdated })
          : t("updates.state.current")
        : t("dash.tile.neverChecked"),
      iconName: "download",
      tone: available ? (outdated ? "warn" : "ok") : "",
    }),
    tile({
      label: t("dash.tile.memory"),
      value: `${memoryMb} MB`,
      sub: t("dash.tile.panelProcess"),
      iconName: "cpu",
    }),
    tile({
      label: t("dash.status.uptime"),
      value: relativeTime(t, rc.app.startedAt),
      sub: t("dash.tile.sinceStart"),
      iconName: "clock",
    }),
  ].join("");

  const steamCell = settings[KEYS.steamLoggedInAt]
    ? `${pill("ok", t("common.ready"))} <a href="/steam">${escapeHtml(settings[KEYS.steamAccount] || "")}</a>`
    : `${pill("warn", t("dash.steamPending"))} <a href="/steam">${escapeHtml(t("dash.steamConnect"))}</a>`;

  // Herzschlag und Abholer vermerken, wenn DZPage den Schluessel ablehnt; die
  // Panel-ID bleibt dabei stehen und hiesse sonst weiter "verbunden".
  const dzpageCell = settings[KEYS.dzpageKeyRejected]
    ? `${pill("bad", t("dash.dzpageRejected"))}
       <span class="hint">${escapeHtml(t("dash.dzpageRejectedHint"))}</span>`
    : settings[KEYS.dzpagePanelId]
      ? `${pill("ok", settings[KEYS.dzpageAccount] || t("common.ready"))}
         <span class="hint">${escapeHtml(
           t("dash.dzpageLastSeen", { when: relativeTime(t, settings[KEYS.dzpageLastSeenAt]) }),
         )}</span>`
      : `${pill("off", t("common.missing"))} <a href="/dzpage">${escapeHtml(t("setup.dzpage.connect"))}</a>`;

  const statusRows = [
    [t("dash.status.database"), pill("ok", rc.config.database?.kind === "mysql" ? "MySQL" : "SQLite")],
    [t("dash.status.steam"), steamCell],
    [t("dash.status.dzpage"), dzpageCell],
    [
      t("dash.status.updates"),
      settings[KEYS.updateCheckedAt]
        ? `<a href="/updates">${escapeHtml(
            t("dash.checkedAt", { when: relativeTime(t, settings[KEYS.updateCheckedAt]) }),
          )}</a>`
        : `<a href="/updates">${escapeHtml(t("updates.setUp"))}</a>`,
    ],
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
    .join("");

  const serverBlock = rows.length
    ? `<div class="srv-list">${rows.slice(0, 6).map((row) => serverRow(t, row)).join("")}</div>`
    : emptyState({
        iconName: "server",
        text: t("dash.serversEmpty"),
        action: `<a class="btn primary" href="/servers/new">${icon("plus")}${escapeHtml(t("servers.new"))}</a>`,
      });

  const events = await listEvents(rc.app.db, 10);
  const eventList = events.length
    ? `<ul class="events">${events
        .map(
          (event) =>
            `<li>${dot(eventDot(event.kind))}<span class="txt">${escapeHtml(event.message)}<time>${escapeHtml(
              t("time.ago", { value: relativeTime(t, event.at) }),
            )} · ${escapeHtml(event.kind)}</time></span></li>`,
        )
        .join("")}</ul>`
    : `<p class="lede">${escapeHtml(t("dash.eventsEmpty"))}</p>`;

  rc.page(
    200,
    t("dash.heading"),
    `${pageHead({
      title: t("dash.heading"),
      lede: t("app.tagline"),
      actions: `<a class="btn primary" href="/servers/new">${icon("plus")}${escapeHtml(t("servers.new"))}</a>`,
    })}
     <div class="tiles">${tiles}</div>
     <div class="grid wide-left">
       <div>
         ${card(serverBlock, {
           title: t("dash.servers"),
           actions: `<a class="btn secondary sm" href="/servers">${escapeHtml(t("common.showAll"))}</a>`,
         })}
       </div>
       <div>
         ${card(`<table class="status">${statusRows}</table>`, { title: t("dash.status") })}
         ${card(eventList, { title: t("dash.events") })}
       </div>
     </div>`,
  );
}
