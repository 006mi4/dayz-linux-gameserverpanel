import { verifyPassword } from "../auth/password.js";
import { findUserByUsername, markLogin, normaliseUsername } from "../store/users.js";
import { createSession, deleteSession } from "../store/sessions.js";
import { recordEvent } from "../store/events.js";
import { csrfInput, escapeHtml, field, notice } from "../http/html.js";
import { log } from "../log.js";

/**
 * Anmeldung am Panel. Bewusst wortkarg: dieselbe Meldung fuer falschen
 * Benutzernamen und falsches Passwort, damit die Maske nicht verraet, welcher
 * Name existiert.
 */

/** Nur eigene Pfade als Ziel zulassen — sonst waere das eine offene Weiterleitung. */
function safeNext(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return /^\/[A-Za-z0-9/_.-]*$/.test(value) ? value : "/";
}

function loginForm(rc, { username = "", error = null, next = "/" } = {}) {
  const t = rc.t;
  return `
    <h1>${escapeHtml(t("login.heading"))}</h1>
    ${error ? notice("error", error) : ""}
    <form method="post" action="/login">
      ${csrfInput(rc.csrf)}
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      ${field({
        name: "username",
        label: t("setup.admin.username"),
        value: username,
        required: true,
        autocomplete: "username",
      })}
      ${field({
        name: "password",
        label: t("setup.admin.password"),
        type: "password",
        required: true,
        autocomplete: "current-password",
      })}
      <div class="actions"><button class="primary" type="submit">${escapeHtml(t("common.login"))}</button></div>
    </form>`;
}

export async function login(rc) {
  if (rc.user) {
    rc.redirect("/");
    return;
  }
  if (!rc.app.db) {
    rc.redirect("/setup");
    return;
  }

  const next = safeNext(rc.method === "GET" ? rc.url.searchParams.get("next") : rc.form.get("next"));

  if (rc.method === "GET") {
    rc.page(200, rc.t("login.heading"), `<div class="card">${loginForm(rc, { next })}</div>`);
    return;
  }

  const throttleKey = rc.ip || "unknown";
  const state = rc.app.throttle.check(throttleKey);
  if (state.locked) {
    rc.page(
      429,
      rc.t("login.heading"),
      `<div class="card">${loginForm(rc, {
        next,
        error: rc.t("login.throttled", { minutes: Math.ceil(state.retryAfterMs / 60000) }),
      })}</div>`,
    );
    return;
  }

  const username = normaliseUsername(rc.form.get("username") || "");
  const password = rc.form.get("password") || "";
  const user = await findUserByUsername(rc.app.db, username);
  const ok = user ? await verifyPassword(password, user.password_hash) : false;

  if (!ok) {
    const after = rc.app.throttle.fail(throttleKey);
    log.warn("Anmeldung fehlgeschlagen", { ip: rc.ip, locked: after.locked });
    rc.page(
      401,
      rc.t("login.heading"),
      `<div class="card">${loginForm(rc, {
        username: rc.form.get("username") || "",
        next,
        error: after.locked
          ? rc.t("login.throttled", { minutes: Math.ceil(after.retryAfterMs / 60000) })
          : rc.t("login.failed"),
      })}</div>`,
    );
    return;
  }

  rc.app.throttle.reset(throttleKey);
  const session = await createSession(rc.app.db, {
    userId: user.id,
    ip: rc.ip,
    userAgent: rc.req.headers["user-agent"],
  });
  rc.setSessionCookie(session.id);
  await markLogin(rc.app.db, user.id);
  await recordEvent(rc.app.db, { kind: "auth.login", message: `${user.username} hat sich angemeldet` });
  rc.redirect(next);
}

export async function logout(rc) {
  if (rc.session) await deleteSession(rc.app.db, rc.session.id);
  rc.clearSessionCookie();
  rc.redirect("/login");
}
