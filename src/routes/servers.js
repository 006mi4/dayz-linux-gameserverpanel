import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  checkServerInput,
  createServer,
  deleteServer,
  DEFAULTS,
  findPortConflict,
  getServer,
  listServers,
  rconPassword,
  serverDir,
  updateServer,
} from "../store/servers.js";
import { getSetting, getSettings, KEYS } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { runtimeFor, RUNTIME_IDS } from "../runtime/index.js";
import { provisionServer } from "../servers/install.js";
import { installedBuildId } from "../servers/updates.js";
import { writeServerFiles } from "../servers/config.js";
import { registerServerWithDzpage } from "../dzpage/servers.js";
import {
  card,
  csrfInput,
  dot,
  emptyState,
  escapeHtml,
  field,
  icon,
  meter,
  notice,
  pageHead,
  pill,
  relativeTime,
} from "../http/html.js";
import { updateState } from "./updates.js";
import { log } from "../log.js";

/**
 * Die Spielserver: anlegen, installieren, starten, stoppen, neu starten.
 *
 * Es gibt kein Feld, in das ein beliebiger Befehl eingegeben werden koennte.
 * Jede Schaltfläche ist eine benannte Operation mit geprueften Parametern —
 * das ist der Unterschied zwischen einem Panel und einer Fernsteuerung mit
 * Weboberflaeche.
 */

const ACTIONS = new Set([
  "start",
  "stop",
  "restart",
  "install",
  "autostart-on",
  "autostart-off",
  "runtime-systemd",
  "runtime-docker",
  "register",
  "delete",
  "delete-confirm",
]);

/** Zustandsfarbe: laeuft, haelt an, abgestuerzt, aus. */
function stateTone(state) {
  if (state === "running") return "ok";
  if (state === "failed") return "bad";
  if (state === "starting" || state === "stopping") return "warn";
  return "off";
}

function statePill(t, state) {
  return pill(stateTone(state), t(`servers.state.${state}`));
}

/**
 * Eine Zeile in der Serverliste. Steht auch auf der Uebersicht, damit ein
 * Server dort und hier gleich aussieht.
 */
export function serverRow(t, { server, status }) {
  return `<a class="srv" href="/server?id=${escapeHtml(server.id)}">
    <span class="id">
      ${dot(stateTone(status.state))}
      <span>
        <span class="name">${escapeHtml(server.name)}</span>
        <span class="meta">:${Number(server.game_port)} · ${escapeHtml(server.runtime)}</span>
      </span>
    </span>
    <span class="right">
      ${server.install_state === "ready" ? "" : pill("off", t(`servers.installState.${server.install_state}`))}
      ${statePill(t, status.state)}
    </span>
  </a>`;
}

export async function withState(rc, servers) {
  const out = [];
  for (const server of servers) {
    let status = { state: "unknown" };
    try {
      status = await runtimeFor(server).status(server);
    } catch (err) {
      log.debug(`Zustand von ${server.id} nicht lesbar: ${err.message}`);
    }
    out.push({ server, status });
  }
  return out;
}

/* -------------------------------------------------------------------- Liste */

export async function list(rc) {
  const t = rc.t;
  const rows = await withState(rc, await listServers(rc.app.db));

  const body = rows.length
    ? `<div class="srv-list">${rows.map((row) => serverRow(t, row)).join("")}</div>`
    : emptyState({
        iconName: "server",
        text: t("servers.empty"),
        action: `<a class="btn primary" href="/servers/new">${icon("plus")}${escapeHtml(t("servers.new"))}</a>`,
      });

  rc.page(
    200,
    t("servers.title"),
    `${pageHead({
      title: t("servers.title"),
      lede: t("servers.lede"),
      actions: `<a class="btn primary" href="/servers/new">${icon("plus")}${escapeHtml(t("servers.new"))}</a>`,
    })}
     ${card(body)}`,
  );
}

/* ------------------------------------------------------------------ Anlegen */

function createForm(rc, { values = {}, error = null } = {}) {
  const t = rc.t;
  const value = (name, fallback) => escapeHtml(values[name] ?? fallback);
  return `
    ${error ? notice("error", error) : ""}
    <form method="post" action="/servers/new">
      ${csrfInput(rc.csrf)}
      ${field({ name: "name", label: t("servers.name"), value: value("name", ""), required: true })}
      <div class="row">
        ${field({
          name: "gamePort",
          label: t("servers.gamePort"),
          value: value("gamePort", DEFAULTS.gamePort),
          inputmode: "numeric",
        })}
        ${field({
          name: "queryPort",
          label: t("servers.queryPort"),
          value: value("queryPort", DEFAULTS.queryPort),
          inputmode: "numeric",
        })}
        ${field({
          name: "rconPort",
          label: t("servers.rconPort"),
          value: value("rconPort", DEFAULTS.rconPort),
          inputmode: "numeric",
        })}
      </div>
      ${field({
        name: "rconPassword",
        label: t("servers.rconPassword"),
        value: value("rconPassword", randomBytes(12).toString("hex")),
        hint: t("servers.rconPasswordHint"),
        required: true,
      })}
      <div class="row">
        ${field({
          name: "maxPlayers",
          label: t("servers.maxPlayers"),
          value: value("maxPlayers", DEFAULTS.maxPlayers),
          inputmode: "numeric",
        })}
        ${field({ name: "mission", label: t("servers.mission"), value: value("mission", DEFAULTS.mission) })}
      </div>
      <details class="drawer">
        <summary>${escapeHtml(t("servers.limits"))}</summary>
        <div class="row">
          ${field({
            name: "memoryMaxMb",
            label: t("servers.memory"),
            value: value("memoryMaxMb", DEFAULTS.memoryMaxMb),
            hint: t("servers.memoryHint"),
            inputmode: "numeric",
          })}
          ${field({
            name: "cpuQuota",
            label: t("servers.cpu"),
            value: value("cpuQuota", DEFAULTS.cpuQuota),
            hint: t("servers.cpuHint"),
            inputmode: "numeric",
          })}
        </div>
      </details>
      <div class="actions">
        <button class="btn primary" type="submit">${escapeHtml(t("servers.create"))}</button>
        <a class="btn secondary" href="/servers">${escapeHtml(t("common.cancel"))}</a>
      </div>
    </form>`;
}

function createPage(rc, options) {
  return `${pageHead({ title: rc.t("servers.new"), lede: rc.t("servers.newLede") })}
    ${card(createForm(rc, options))}`;
}

export async function create(rc) {
  if (rc.method === "GET") {
    rc.page(200, rc.t("servers.new"), createPage(rc));
    return;
  }

  const values = Object.fromEntries(rc.form.entries());
  const checked = checkServerInput(values);
  if (!checked.ok) {
    rc.page(400, rc.t("servers.new"), createPage(rc, { values, error: rc.t(`servers.err.${checked.code}`) }));
    return;
  }

  const conflict = await findPortConflict(rc.app.db, checked.value);
  if (conflict) {
    rc.page(
      400,
      rc.t("servers.new"),
      createPage(rc, { values, error: rc.t("servers.err.port_taken", { name: conflict.id }) }),
    );
    return;
  }

  const server = await createServer(rc.app.db, checked.value, rc.config.secrets.encryption);
  writeServerFiles(server, checked.value.password);
  await recordEvent(rc.app.db, { kind: "server.create", message: `Server ${server.name} angelegt` });
  log.info(`Server ${server.id} angelegt`);
  rc.redirect(`/server?id=${server.id}`);
}

/* ------------------------------------------------------------------- Detail */

/** Speicherverbrauch gegen die gesetzte Grenze. */
function memoryRow(t, server, status) {
  const usedMb = Math.round(status.memoryBytes / (1024 * 1024));
  const maxMb = Number(server.memory_max_mb) || 0;
  const percent = maxMb ? (usedMb / maxMb) * 100 : 0;
  const tone = percent >= 90 ? "bad" : percent >= 75 ? "warn" : "";
  return `<div class="meter-row">
      ${meter(percent, { tone })}
      <span class="val">${usedMb} MB / ${maxMb} MB</span>
    </div>`;
}

function updateCard(t, { server, installed, available, state }) {
  const rows = [
    [t("updates.installed"), `<span class="mono">${escapeHtml(installed || "—")}</span>`],
    [t("updates.available"), `<span class="mono">${escapeHtml(available || "—")}</span>`],
    [t("servers.state.heading"), pill(state === "current" ? "ok" : state === "outdated" ? "warn" : "off", t(`updates.state.${state}`))],
    [t("updates.mode.heading"), escapeHtml(t(`updates.mode.${server.update_mode || "off"}`))],
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
    .join("");

  return card(
    `<table class="status">${rows}</table>
     <div class="actions">
       <a class="btn secondary sm" href="/updates">${icon("download")}${escapeHtml(t("updates.setUp"))}</a>
     </div>`,
    { title: t("updates.card.heading") },
  );
}

export async function detail(rc) {
  const t = rc.t;
  const server = await getServer(rc.app.db, rc.url.searchParams.get("id"));
  if (!server) {
    rc.notFound();
    return;
  }

  const runtime = runtimeFor(server);
  let status = { state: "unknown" };
  let logText = "";
  try {
    status = await runtime.status(server);
    logText = await runtime.logs(server, 200);
  } catch (err) {
    logText = err.message;
  }

  const settings = await getSettings(rc.app.db, [KEYS.updateAvailableBuild]);
  const installed = installedBuildId(server.id) ?? server.installed_build ?? null;
  const available = settings[KEYS.updateAvailableBuild];
  const state = updateState(installed, available);

  const filesReady = server.install_state === "ready";
  const action = (name, label, kind = "secondary", { disabled = false, iconName = "" } = {}) =>
    `<button class="btn ${kind}" type="submit" name="action" value="${escapeHtml(name)}"${
      disabled ? " disabled" : ""
    }>${iconName ? icon(iconName) : ""}${escapeHtml(label)}</button>`;

  const rows = [
    [t("servers.ports"), `<span class="mono">${Number(server.game_port)} · ${Number(server.query_port)} · ${Number(server.rcon_port)}</span>`],
    [t("servers.mission"), escapeHtml(server.mission)],
    [t("servers.maxPlayers"), String(Number(server.max_players))],
    [t("servers.limits"), `${Number(server.memory_max_mb)} MB · ${Number(server.cpu_quota)} %`],
    [t("servers.autostart"), pill(status.autostart ? "ok" : "off", status.autostart ? t("common.yes") : t("common.no"))],
    [
      t("servers.dzpage"),
      server.dzpage_server_id ? pill("ok", t("servers.registered")) : pill("off", t("common.missing")),
    ],
  ];
  if (status.pid) rows.push([t("servers.pid"), `<span class="mono">${Number(status.pid)}</span>`]);
  if (status.memoryBytes) rows.push([t("servers.memoryUse"), memoryRow(t, server, status)]);
  if (status.restarts) rows.push([t("servers.restarts"), String(Number(status.restarts))]);

  const head = `<div class="srv-head">
      <div>
        <div class="title">${dot(stateTone(status.state))}<h1>${escapeHtml(server.name)}</h1></div>
        <div class="meta">
          <span class="mono">:${Number(server.game_port)}</span>
          <span>${escapeHtml(server.runtime)}</span>
          <span>${escapeHtml(t(`servers.installState.${server.install_state}`))}</span>
          ${statePill(t, status.state)}
        </div>
      </div>
      <form method="post" action="/server/action">
        ${csrfInput(rc.csrf)}
        <input type="hidden" name="id" value="${escapeHtml(server.id)}">
        <div class="btn-group">
          ${action("start", t("servers.actions.start"), "primary", { disabled: !filesReady, iconName: "play" })}
          ${action("stop", t("servers.actions.stop"), "secondary", { iconName: "stop" })}
          ${action("restart", t("servers.actions.restart"), "secondary", { disabled: !filesReady, iconName: "restart" })}
        </div>
      </form>
    </div>`;

  const manage = card(
    `<form method="post" action="/server/action">
       ${csrfInput(rc.csrf)}
       <input type="hidden" name="id" value="${escapeHtml(server.id)}">
       <div class="actions tight">
         ${action(
           "install",
           filesReady ? t("servers.actions.update") : t("servers.actions.install"),
           filesReady ? "secondary" : "primary",
           { iconName: "download" },
         )}
         ${action(status.autostart ? "autostart-off" : "autostart-on", t("servers.actions.autostart"), "secondary", {
           iconName: "power",
         })}
       </div>
       <div class="actions tight">
         ${action(
           server.runtime === "docker" ? "runtime-systemd" : "runtime-docker",
           t("servers.actions.switchRuntime", { runtime: server.runtime === "docker" ? "systemd" : "Docker" }),
           "secondary",
           { iconName: "cpu" },
         )}
         ${action("register", t("servers.actions.register"), "secondary", {
           disabled: Boolean(server.dzpage_server_id),
           iconName: "link",
         })}
       </div>
       <div class="actions tight">
         ${action("delete", t("servers.actions.delete"), "danger", { iconName: "trash" })}
       </div>
     </form>`,
    { title: t("servers.controls") },
  );

  rc.page(
    200,
    server.name,
    `${head}
     <div class="grid cols-2">
       <div>
         ${card(
           `<table class="status">${rows
             .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
             .join("")}</table>`,
           { title: t("servers.details") },
         )}
       </div>
       <div>
         ${updateCard(t, { server, installed, available, state })}
         ${manage}
       </div>
     </div>
     ${card(`<pre class="log">${escapeHtml(logText || t("servers.logEmpty"))}</pre>`, {
       title: t("servers.log"),
       sub: t("servers.logSub"),
     })}
     <div class="actions"><a class="btn secondary" href="/servers">${escapeHtml(t("common.back"))}</a></div>`,
  );
}

/* ------------------------------------------------------------------ Aktionen */

export async function act(rc) {
  const t = rc.t;
  const server = await getServer(rc.app.db, rc.form.get("id"));
  const action = rc.form.get("action");
  if (!server || !ACTIONS.has(action)) {
    rc.notFound();
    return;
  }

  const runtime = runtimeFor(server);
  const back = `/server?id=${server.id}`;

  try {
    switch (action) {
      case "start":
        await runtime.start(server);
        break;
      case "stop":
        await runtime.stop(server);
        break;
      case "restart":
        await runtime.restart(server);
        break;
      case "autostart-on":
      case "autostart-off": {
        const on = action === "autostart-on";
        await runtime.setAutostart(server, on);
        await updateServer(rc.app.db, server.id, { autostart: on ? 1 : 0 });
        break;
      }
      case "runtime-systemd":
      case "runtime-docker": {
        await switchRuntime(rc, server, action === "runtime-docker" ? "docker" : "systemd");
        break;
      }
      case "install": {
        const started = startInstall(rc, server);
        // Bei einem bereits laufenden Vorgang zeigt jobs.start() auf diesen —
        // dorthin schicken wir dann auch, statt einen falschen anzuzeigen.
        rc.redirect(`/job?id=${started.job.id}&back=${encodeURIComponent(back)}`);
        return;
      }
      case "register": {
        const result = await registerServerWithDzpage(rc.app, server);
        if (!result.ok) throw new Error(result.message);
        break;
      }
      case "delete":
        renderDeleteConfirm(rc, server);
        return;
      case "delete-confirm": {
        await runtime.destroy(server);
        rmSync(serverDir(server.id), { recursive: true, force: true });
        await deleteServer(rc.app.db, server.id);
        await recordEvent(rc.app.db, { kind: "server.delete", message: `Server ${server.name} entfernt` });
        rc.redirect("/servers");
        return;
      }
      default:
        rc.notFound();
        return;
    }
    await recordEvent(rc.app.db, { kind: `server.${action}`, message: `${server.name}: ${action}` });
  } catch (err) {
    log.warn(`Aktion ${action} auf ${server.id} fehlgeschlagen: ${err.message}`);
    rc.page(
      500,
      server.name,
      card(
        `${notice("error", t("servers.err.action", { message: err.message }))}
         <div class="actions"><a class="btn secondary" href="${escapeHtml(back)}">${escapeHtml(
           t("common.back"),
         )}</a></div>`,
      ),
    );
    return;
  }

  rc.redirect(back);
}

function renderDeleteConfirm(rc, server) {
  const t = rc.t;
  rc.page(
    200,
    t("servers.actions.delete"),
    `${pageHead({ title: t("servers.deleteHeading", { name: server.name }) })}
     ${card(
       `${notice("warn", t("servers.deleteWarning"))}
        <form method="post" action="/server/action">
          ${csrfInput(rc.csrf)}
          <input type="hidden" name="id" value="${escapeHtml(server.id)}">
          <div class="actions">
            <button class="btn danger" type="submit" name="action" value="delete-confirm">${escapeHtml(
              t("servers.actions.deleteConfirm"),
            )}</button>
            <a class="btn secondary" href="/server?id=${escapeHtml(server.id)}">${escapeHtml(t("common.cancel"))}</a>
          </div>
        </form>`,
     )}`,
  );
}

/**
 * Laufzeit wechseln. Der Server wird angehalten, die alte Laufzeit raeumt ihre
 * Spuren weg, die neue richtet sich ein — die Spieldateien bleiben liegen.
 */
async function switchRuntime(rc, server, target) {
  if (!RUNTIME_IDS.includes(target)) throw new Error("Unbekannte Laufzeit.");
  const current = runtimeFor(server);
  const next = runtimeFor(target);

  await current.stop(server).catch(() => undefined);
  await current.destroy(server).catch(() => undefined);
  const updated = { ...server, runtime: target };
  await next.prepare(updated);
  await updateServer(rc.app.db, server.id, { runtime: target });
  log.info(`Server ${server.id} laeuft jetzt unter ${target}`);
}

function startInstall(rc, server) {
  const app = rc.app;
  const config = rc.config;
  const password = rconPassword(server, config.secrets.encryption);
  const runtime = runtimeFor(server);

  return app.jobs.start("server-install", async (job) => {
    const account = await getSetting(app.db, KEYS.steamAccount);
    await updateServer(app.db, server.id, { install_state: "installing" });
    try {
      await provisionServer({ config, server, account, job, runtime, rconPassword: password });
    } catch (err) {
      await updateServer(app.db, server.id, { install_state: "failed" });
      throw err;
    }
    await updateServer(app.db, server.id, {
      install_state: "ready",
      installed_at: Date.now(),
      installed_build: installedBuildId(server.id),
    });
    await recordEvent(app.db, { kind: "server.install", message: `${server.name} installiert` });
    return { serverId: server.id };
  });
}

/* --------------------------------------------------------- Vorgangsanzeige */

/** Allgemeine Statusseite fuer laufende Vorgaenge ohne Rueckfragen. */
export async function jobPage(rc) {
  const t = rc.t;
  const id = rc.url.searchParams.get("id");
  const job = (id && rc.app.jobs.get(id)) || rc.app.jobs.current();
  const raw = rc.url.searchParams.get("back") || "/servers";
  const back = /^\/[A-Za-z0-9/?=&_.-]*$/.test(raw) && !raw.startsWith("//") ? raw : "/servers";

  if (!job) {
    rc.redirect(back);
    return;
  }

  let head = "";
  let top;
  if (job.running) {
    head = '<meta http-equiv="refresh" content="3">';
    top = notice("warn", t("job.running"));
  } else if (job.status === "ok") {
    top = notice("ok", t("job.done"));
  } else {
    top = notice("error", t("job.failed", { message: job.error || "" }));
  }

  rc.page(
    200,
    t("job.heading"),
    `${pageHead({
      title: t("job.heading"),
      lede: t("job.started", { when: relativeTime(t, job.startedAt) }),
      actions: `<a class="btn secondary" href="${escapeHtml(back)}">${escapeHtml(t("common.back"))}</a>`,
    })}
     ${card(`${top}<pre class="log">${escapeHtml(job.lines.join("\n") || t("job.running"))}</pre>`, {
       title: t("servers.log"),
     })}`,
    { head },
  );
}
