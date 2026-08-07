import { saveConfig, sqliteDefaults } from "../config.js";
import { openDatabase, testDatabase } from "../db/index.js";
import { MYSQL_INSTALL_HINT } from "../db/mysql.js";
import { SQLITE_FILE } from "../paths.js";
import { checkPassword, checkUsername, countUsers, createUser } from "../store/users.js";
import { createSession } from "../store/sessions.js";
import { getSetting, KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { MIN_PASSWORD_LENGTH } from "../auth/password.js";
import { csrfInput, escapeHtml, field, notice, stepper } from "../http/html.js";
import { log } from "../log.js";

/**
 * Der Einrichtungsassistent. Fuenf Schritte, danach ist das Panel bereit.
 *
 * Schritt 1 und 2 leben hier, weil sie noch ohne Konto auskommen muessen.
 * Schritt 3 (Steam) und 4 (DZPage-Schluessel) haben eigene Module und sind
 * auch nach dem Einrichten erreichbar — dieselbe Maske, anderer Rahmen.
 */

function page(rc, { step, title, body }) {
  // Ohne Seitenleiste: der Assistent ist ein linearer Ablauf und soll keine
  // Abzweigungen anbieten, die es an dieser Stelle noch gar nicht gibt.
  rc.page(200, title, `${stepper(rc.t, step)}<div class="card">${body}</div>`, { nav: false });
}

export async function index(rc) {
  const progress = await rc.app.setupProgress();
  rc.redirect(progress.next);
}

/* ---------------------------------------------------------------- Schritt 1 */

function databaseForm(rc, { kind = "sqlite", mysql = {}, message = null, messageKind = "error" } = {}) {
  const t = rc.t;
  const mysqlFields = [
    `<summary>${escapeHtml(t("setup.db.mysqlDetails"))}</summary>`,
    `<div class="row">`,
    field({ name: "host", label: t("setup.db.host"), value: mysql.host ?? "127.0.0.1" }),
    field({ name: "port", label: t("setup.db.port"), value: mysql.port ?? "3306", inputmode: "numeric" }),
    `</div>`,
    field({ name: "user", label: t("setup.db.user"), value: mysql.user ?? "" }),
    // Das Passwort steht wieder im Formular, damit ein fehlgeschlagener Test
    // nicht alles neu eingeben laesst. Die Seite ist "no-store", landet also
    // in keinem Cache.
    field({ name: "password", label: t("setup.db.password"), type: "password", value: mysql.password ?? "" }),
    field({ name: "database", label: t("setup.db.database"), value: mysql.database ?? "dzpage_panel" }),
  ].join("");

  return `
    <h1>${escapeHtml(t("setup.db.heading"))}</h1>
    <p class="lede">${escapeHtml(t("setup.db.lede"))}</p>
    ${message ? notice(messageKind, message) : ""}
    <form method="post" action="/setup/database">
      ${csrfInput(rc.csrf)}
      <label class="choice">
        <input type="radio" name="kind" value="sqlite" ${kind === "sqlite" ? "checked" : ""}>
        <strong>${escapeHtml(t("setup.db.sqlite"))}</strong>
        <span class="hint">${escapeHtml(t("setup.db.sqliteHint", { file: SQLITE_FILE }))}</span>
      </label>
      <label class="choice">
        <input type="radio" name="kind" value="mysql" ${kind === "mysql" ? "checked" : ""}>
        <strong>${escapeHtml(t("setup.db.mysql"))}</strong>
        <span class="hint">${escapeHtml(t("setup.db.mysqlHint"))}</span>
      </label>
      <details class="drawer" ${kind === "mysql" ? "open" : ""}>${mysqlFields}</details>
      <div class="actions">
        <button class="primary" type="submit" name="action" value="save">${escapeHtml(t("common.next"))}</button>
        <button class="secondary" type="submit" name="action" value="test">${escapeHtml(t("setup.db.test"))}</button>
      </div>
    </form>`;
}

function mysqlFromForm(form) {
  return {
    kind: "mysql",
    host: (form.get("host") || "").trim(),
    port: Number((form.get("port") || "3306").trim()) || 3306,
    user: (form.get("user") || "").trim(),
    password: form.get("password") || "",
    database: (form.get("database") || "").trim(),
  };
}

export async function database(rc) {
  if (rc.method === "GET") {
    page(rc, { step: 1, title: rc.t("setup.step.database"), body: databaseForm(rc) });
    return;
  }

  const kind = rc.form.get("kind") === "mysql" ? "mysql" : "sqlite";
  const action = rc.form.get("action") === "test" ? "test" : "save";
  const mysql = mysqlFromForm(rc.form);
  const dbConfig = kind === "mysql" ? mysql : sqliteDefaults();

  const result = await testDatabase(dbConfig);
  if (!result.ok) {
    const message = result.message.includes(MYSQL_INSTALL_HINT)
      ? rc.t("setup.db.mysqlMissing", { command: MYSQL_INSTALL_HINT })
      : rc.t("setup.db.testFailed", { message: result.message });
    page(rc, {
      step: 1,
      title: rc.t("setup.step.database"),
      body: databaseForm(rc, { kind, mysql, message }),
    });
    return;
  }

  if (action === "test") {
    page(rc, {
      step: 1,
      title: rc.t("setup.step.database"),
      body: databaseForm(rc, {
        kind,
        mysql,
        message: rc.t("setup.db.testOk", { version: result.version }),
        messageKind: "ok",
      }),
    });
    return;
  }

  rc.config.database = dbConfig;
  saveConfig(rc.config);
  rc.app.db = await openDatabase(dbConfig);
  await recordEvent(rc.app.db, { kind: "setup.database", message: `Datenbank eingerichtet: ${kind}` });
  log.info(`Datenbank eingerichtet: ${kind}`);
  rc.redirect("/setup/admin");
}

/* ---------------------------------------------------------------- Schritt 2 */

function adminForm(rc, { username = "", error = null } = {}) {
  const t = rc.t;
  return `
    <h1>${escapeHtml(t("setup.admin.heading"))}</h1>
    <p class="lede">${escapeHtml(t("setup.admin.lede"))}</p>
    ${error ? notice("error", error) : ""}
    <form method="post" action="/setup/admin">
      ${csrfInput(rc.csrf)}
      ${field({
        name: "username",
        label: t("setup.admin.username"),
        value: username,
        hint: t("setup.admin.usernameHint"),
        required: true,
        autocomplete: "username",
      })}
      ${field({
        name: "password",
        label: t("setup.admin.password"),
        type: "password",
        hint: t("setup.admin.passwordHint", { min: MIN_PASSWORD_LENGTH }),
        required: true,
        autocomplete: "new-password",
      })}
      ${field({
        name: "password2",
        label: t("setup.admin.passwordRepeat"),
        type: "password",
        required: true,
        autocomplete: "new-password",
      })}
      <div class="actions">
        <button class="primary" type="submit">${escapeHtml(t("setup.admin.create"))}</button>
      </div>
    </form>`;
}

export async function admin(rc) {
  if (!rc.app.db) {
    rc.redirect("/setup/database");
    return;
  }
  if (rc.method === "GET") {
    page(rc, { step: 2, title: rc.t("setup.step.admin"), body: adminForm(rc) });
    return;
  }

  const username = rc.form.get("username") || "";
  const password = rc.form.get("password") || "";
  const repeat = rc.form.get("password2") || "";

  const nameCheck = checkUsername(username);
  const passCheck = checkPassword(password, repeat);
  const failure = !nameCheck.ok ? nameCheck.code : !passCheck.ok ? passCheck.code : null;
  if (failure) {
    page(rc, {
      step: 2,
      title: rc.t("setup.step.admin"),
      body: adminForm(rc, {
        username,
        error: rc.t(`setup.admin.err.${failure}`, { min: MIN_PASSWORD_LENGTH }),
      }),
    });
    return;
  }

  if ((await countUsers(rc.app.db)) > 0) {
    page(rc, {
      step: 2,
      title: rc.t("setup.step.admin"),
      body: adminForm(rc, { username, error: rc.t("setup.admin.err.exists") }),
    });
    return;
  }

  const user = await createUser(rc.app.db, { username: nameCheck.username, password });
  const session = await createSession(rc.app.db, {
    userId: user.id,
    ip: rc.ip,
    userAgent: rc.req.headers["user-agent"],
  });
  rc.setSessionCookie(session.id);
  await recordEvent(rc.app.db, {
    kind: "setup.admin",
    message: `Administrator ${user.username} angelegt`,
  });
  log.info(`Administrator ${user.username} angelegt`);
  rc.redirect("/steam");
}

/* ---------------------------------------------------------------- Schritt 5 */

export async function done(rc) {
  const progress = await rc.app.setupProgress();
  if (progress.completed) {
    rc.notFound();
    return;
  }
  if (rc.method === "POST") {
    await setSetting(rc.app.db, KEYS.setupCompletedAt, Date.now());
    await recordEvent(rc.app.db, { kind: "setup.done", message: "Einrichtung abgeschlossen" });
    log.info("Einrichtung abgeschlossen");
    rc.redirect("/");
    return;
  }

  const t = rc.t;
  const steamAccount = await getSetting(rc.app.db, KEYS.steamAccount);
  const dzpageAccount = await getSetting(rc.app.db, KEYS.dzpageAccount);
  const rows = [
    [t("setup.done.database"), rc.config.database?.kind === "mysql" ? "MySQL" : "SQLite"],
    [t("setup.done.steam"), escapeHtml(progress.steamDone ? steamAccount || t("common.ready") : t("common.missing"))],
    [
      t("setup.done.dzpage"),
      escapeHtml(progress.dzpageDone ? dzpageAccount || t("common.ready") : t("common.missing")),
    ],
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
    .join("");

  page(rc, {
    step: 5,
    title: t("setup.step.done"),
    body: `
      <h1>${escapeHtml(t("setup.done.heading"))}</h1>
      <p class="lede">${escapeHtml(t("setup.done.lede"))}</p>
      <table class="status">${rows}</table>
      <form method="post" action="/setup/done">
        ${csrfInput(rc.csrf)}
        <div class="actions"><button class="primary" type="submit">${escapeHtml(t("setup.done.finish"))}</button></div>
      </form>`,
  });
}

export { page as wizardPage };
