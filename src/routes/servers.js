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
import { getSetting, KEYS } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { runtimeFor, RUNTIME_IDS } from "../runtime/index.js";
import { provisionServer } from "../servers/install.js";
import { writeServerFiles } from "../servers/config.js";
import { registerServerWithDzpage } from "../dzpage/servers.js";
import { csrfInput, escapeHtml, field, notice, relativeTime } from "../http/html.js";
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

function statePill(t, state) {
  const kind = state === "running" ? "ok" : state === "failed" ? "warn" : "off";
  return `<span class="pill ${kind}">${escapeHtml(t(`servers.state.${state}`))}</span>`;
}

async function withState(rc, servers) {
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
    ? `<table class="status">
         <tr><th>${escapeHtml(t("servers.name"))}</th><th>${escapeHtml(t("servers.ports"))}</th><th>${escapeHtml(
           t("servers.state.heading"),
         )}</th></tr>
         ${rows
           .map(
             ({ server, status }) => `<tr>
               <th><a href="/server?id=${escapeHtml(server.id)}">${escapeHtml(server.name)}</a></th>
               <td>${Number(server.game_port)} · ${Number(server.query_port)} · ${Number(server.rcon_port)}</td>
               <td>${statePill(t, status.state)}</td>
             </tr>`,
           )
           .join("")}
       </table>`
    : `<p class="lede">${escapeHtml(t("servers.empty"))}</p>`;

  rc.page(
    200,
    t("servers.title"),
    `<h1>${escapeHtml(t("servers.title"))}</h1>
     <div class="card">${body}</div>
     <div class="actions"><a class="button" href="/servers/new">${escapeHtml(t("servers.new"))}</a></div>`,
  );
}

/* ------------------------------------------------------------------ Anlegen */

function createForm(rc, { values = {}, error = null } = {}) {
  const t = rc.t;
  const value = (name, fallback) => escapeHtml(values[name] ?? fallback);
  return `
    <h1>${escapeHtml(t("servers.new"))}</h1>
    <p class="lede">${escapeHtml(t("servers.newLede"))}</p>
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
        <button class="primary" type="submit">${escapeHtml(t("servers.create"))}</button>
        <a class="button secondary" href="/servers">${escapeHtml(t("common.cancel"))}</a>
      </div>
    </form>`;
}

export async function create(rc) {
  if (rc.method === "GET") {
    rc.page(200, rc.t("servers.new"), `<div class="card">${createForm(rc)}</div>`);
    return;
  }

  const values = Object.fromEntries(rc.form.entries());
  const checked = checkServerInput(values);
  if (!checked.ok) {
    rc.page(
      400,
      rc.t("servers.new"),
      `<div class="card">${createForm(rc, { values, error: rc.t(`servers.err.${checked.code}`) })}</div>`,
    );
    return;
  }

  const conflict = await findPortConflict(rc.app.db, checked.value);
  if (conflict) {
    rc.page(
      400,
      rc.t("servers.new"),
      `<div class="card">${createForm(rc, {
        values,
        error: rc.t("servers.err.port_taken", { name: conflict.id }),
      })}</div>`,
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

  const installed = server.install_state === "ready";
  const action = (name, label, kind = "secondary", disabled = false) =>
    `<button class="${kind}" type="submit" name="action" value="${escapeHtml(name)}"${
      disabled ? " disabled" : ""
    }>${escapeHtml(label)}</button>`;

  const rows = [
    [t("servers.state.heading"), statePill(t, status.state)],
    [t("servers.installState.heading"), escapeHtml(t(`servers.installState.${server.install_state}`))],
    [t("servers.ports"), `${Number(server.game_port)} · ${Number(server.query_port)} · ${Number(server.rcon_port)}`],
    [t("servers.mission"), escapeHtml(server.mission)],
    [t("servers.maxPlayers"), String(Number(server.max_players))],
    [t("dash.status.runtime"), escapeHtml(server.runtime)],
    [t("servers.limits"), `${Number(server.memory_max_mb)} MB · ${Number(server.cpu_quota)} %`],
    [
      t("servers.autostart"),
      status.autostart ? escapeHtml(t("common.yes")) : escapeHtml(t("common.no")),
    ],
    [
      t("servers.dzpage"),
      server.dzpage_server_id
        ? `<span class="pill ok">${escapeHtml(t("servers.registered"))}</span>`
        : `<span class="pill off">${escapeHtml(t("common.missing"))}</span>`,
    ],
  ];
  if (status.pid) rows.push([t("servers.pid"), String(status.pid)]);
  if (status.memoryBytes) {
    rows.push([t("dash.status.memory"), `${Math.round(status.memoryBytes / (1024 * 1024))} MB`]);
  }
  if (status.restarts) rows.push([t("servers.restarts"), String(status.restarts)]);

  rc.page(
    200,
    server.name,
    `<h1>${escapeHtml(server.name)}</h1>
     <div class="card">
       <table class="status">${rows
         .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
         .join("")}</table>
     </div>
     <div class="card">
       <h2>${escapeHtml(t("servers.controls"))}</h2>
       <form method="post" action="/server/action">
         ${csrfInput(rc.csrf)}
         <input type="hidden" name="id" value="${escapeHtml(server.id)}">
         <div class="actions">
           ${action("start", t("servers.actions.start"), "primary", !installed)}
           ${action("stop", t("servers.actions.stop"))}
           ${action("restart", t("servers.actions.restart"), "secondary", !installed)}
         </div>
         <div class="actions">
           ${action("install", installed ? t("servers.actions.update") : t("servers.actions.install"))}
           ${action(status.autostart ? "autostart-off" : "autostart-on", t("servers.actions.autostart"))}
           ${action(
             server.runtime === "docker" ? "runtime-systemd" : "runtime-docker",
             t("servers.actions.switchRuntime", {
               runtime: server.runtime === "docker" ? "systemd" : "Docker",
             }),
           )}
         </div>
         <div class="actions">
           ${action("register", t("servers.actions.register"), "secondary", Boolean(server.dzpage_server_id))}
           ${action("delete", t("servers.actions.delete"))}
         </div>
       </form>
     </div>
     <div class="card">
       <h2>${escapeHtml(t("servers.log"))}</h2>
       <pre class="log">${escapeHtml(logText || t("servers.logEmpty"))}</pre>
     </div>
     <div class="actions"><a class="button secondary" href="/servers">${escapeHtml(t("common.back"))}</a></div>`,
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
      `<div class="card">
         ${notice("error", t("servers.err.action", { message: err.message }))}
         <div class="actions"><a class="button secondary" href="${escapeHtml(back)}">${escapeHtml(
           t("common.back"),
         )}</a></div>
       </div>`,
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
    `<div class="card">
       <h1>${escapeHtml(t("servers.deleteHeading", { name: server.name }))}</h1>
       ${notice("warn", t("servers.deleteWarning"))}
       <form method="post" action="/server/action">
         ${csrfInput(rc.csrf)}
         <input type="hidden" name="id" value="${escapeHtml(server.id)}">
         <div class="actions">
           <button class="primary" type="submit" name="action" value="delete-confirm">${escapeHtml(
             t("servers.actions.deleteConfirm"),
           )}</button>
           <a class="button secondary" href="/server?id=${escapeHtml(server.id)}">${escapeHtml(
             t("common.cancel"),
           )}</a>
         </div>
       </form>
     </div>`,
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
    await updateServer(app.db, server.id, { install_state: "ready", installed_at: Date.now() });
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
    `<div class="card">
       <h1>${escapeHtml(t("job.heading"))}</h1>
       ${top}
       <p class="hint">${escapeHtml(t("job.started", { when: relativeTime(t, job.startedAt) }))}</p>
       <div class="actions"><a class="button secondary" href="${escapeHtml(back)}">${escapeHtml(
         t("common.back"),
       )}</a></div>
       <pre class="log">${escapeHtml(job.lines.join("\n") || t("job.running"))}</pre>
     </div>`,
    { head },
  );
}
