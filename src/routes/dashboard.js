import { getSettings, KEYS } from "../store/settings.js";
import { listEvents } from "../store/events.js";
import { listServers } from "../store/servers.js";
import { escapeHtml, relativeTime } from "../http/html.js";

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

function pill(kind, text) {
  return `<span class="pill ${kind}">${escapeHtml(text)}</span>`;
}

async function dashboard(rc) {
  const t = rc.t;
  const settings = await getSettings(rc.app.db, [
    KEYS.steamAccount,
    KEYS.steamLoggedInAt,
    KEYS.dzpageAccount,
    KEYS.dzpagePanelId,
    KEYS.dzpageLastSeenAt,
  ]);

  const steamCell = settings[KEYS.steamLoggedInAt]
    ? `${pill("ok", t("common.ready"))} <a href="/steam">${escapeHtml(settings[KEYS.steamAccount] || "")}</a>`
    : `${pill("warn", t("dash.steamPending"))} <a href="/steam">${escapeHtml(t("dash.steamConnect"))}</a>`;

  const dzpageCell = settings[KEYS.dzpagePanelId]
    ? `${pill("ok", settings[KEYS.dzpageAccount] || t("common.ready"))}
       <span class="hint">${escapeHtml(
         t("dash.dzpageLastSeen", { when: relativeTime(t, settings[KEYS.dzpageLastSeenAt]) }),
       )}</span>`
    : `${pill("off", t("common.missing"))} <a href="/dzpage">${escapeHtml(t("setup.dzpage.connect"))}</a>`;

  const rss = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const rows = [
    [t("dash.status.database"), pill("ok", rc.config.database?.kind === "mysql" ? "MySQL" : "SQLite")],
    [t("dash.status.steam"), steamCell],
    [t("dash.status.dzpage"), dzpageCell],
    [t("dash.status.runtime"), escapeHtml("systemd")],
    [t("dash.status.memory"), `${rss} MB`],
    [t("dash.status.uptime"), escapeHtml(relativeTime(t, rc.app.startedAt))],
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
    .join("");

  const servers = await listServers(rc.app.db);
  const serverBlock = servers.length
    ? `<ul class="events">${servers
        .map(
          (server) =>
            `<li><a href="/server?id=${escapeHtml(server.id)}">${escapeHtml(server.name)}</a>
             <time>${Number(server.game_port)} · ${escapeHtml(
               t(`servers.installState.${server.install_state}`),
             )}</time></li>`,
        )
        .join("")}</ul>`
    : `<p class="lede">${escapeHtml(t("dash.serversEmpty"))}</p>`;

  const events = await listEvents(rc.app.db, 12);
  const eventList = events.length
    ? `<ul class="events">${events
        .map(
          (event) =>
            `<li>${escapeHtml(event.message)}<time>${escapeHtml(
              relativeTime(t, event.at),
            )} · ${escapeHtml(event.kind)}</time></li>`,
        )
        .join("")}</ul>`
    : `<p class="lede">${escapeHtml(t("dash.eventsEmpty"))}</p>`;

  rc.page(
    200,
    t("dash.heading"),
    `<h1>${escapeHtml(t("dash.heading"))}</h1>
     <div class="card">
       <h2>${escapeHtml(t("dash.status"))}</h2>
       <table class="status">${rows}</table>
     </div>
     <div class="card">
       <h2>${escapeHtml(t("dash.servers"))}</h2>
       ${serverBlock}
       <div class="actions"><a class="button" href="/servers">${escapeHtml(t("servers.title"))}</a></div>
     </div>
     <div class="card">
       <h2>${escapeHtml(t("dash.events"))}</h2>
       ${eventList}
     </div>`,
  );
}
