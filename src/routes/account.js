import { MIN_PASSWORD_LENGTH, verifyPassword } from "../auth/password.js";
import { checkPassword, findUserById, setPassword } from "../store/users.js";
import { deleteOtherSessions } from "../store/sessions.js";
import { recordEvent } from "../store/events.js";
import { card, csrfInput, escapeHtml, field, notice, pageHead } from "../http/html.js";
import { log } from "../log.js";

/**
 * Das eigene Konto: Passwort aendern. Das alte Passwort wird verlangt, damit
 * eine liegengebliebene Sitzung allein nicht reicht, das Konto zu uebernehmen.
 * Danach sind alle anderen Sitzungen beendet.
 *
 * Wer sein Passwort vergessen hat, kommt hier nicht weiter; dafuer gibt es auf
 * der Maschine `sudo dzpage-panel reset-password`.
 */

function form(rc, { message = null, kind = "error" } = {}) {
  const t = rc.t;
  return `
    ${message ? notice(kind, message) : ""}
    <form method="post" action="/account">
      ${csrfInput(rc.csrf)}
      ${field({
        name: "current",
        label: t("account.current"),
        type: "password",
        required: true,
        autocomplete: "current-password",
      })}
      ${field({
        name: "password",
        label: t("account.new"),
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
      <div class="actions"><button class="btn primary" type="submit">${escapeHtml(t("account.change"))}</button></div>
    </form>
    <p class="hint">${escapeHtml(t("account.forgotten"))} <code>sudo dzpage-panel reset-password</code></p>`;
}

function render(rc, status, options) {
  const t = rc.t;
  rc.page(
    status,
    t("account.title"),
    `${pageHead({ title: t("account.title"), lede: t("account.lede", { user: rc.user.username }) })}
     ${card(form(rc, options), { title: t("account.password") })}`,
  );
}

export async function page(rc) {
  if (rc.method === "GET") {
    render(rc, 200);
    return;
  }

  const t = rc.t;
  const throttleKey = `account:${rc.user.id}`;
  const state = rc.app.throttle.check(throttleKey);
  if (state.locked) {
    render(rc, 429, { message: t("login.throttled", { minutes: Math.ceil(state.retryAfterMs / 60000) }) });
    return;
  }

  const user = await findUserById(rc.app.db, rc.user.id);
  const current = rc.form.get("current") || "";
  if (!user || !(await verifyPassword(current, user.password_hash))) {
    rc.app.throttle.fail(throttleKey);
    render(rc, 401, { message: t("account.wrongCurrent") });
    return;
  }

  const password = rc.form.get("password") || "";
  const check = checkPassword(password, rc.form.get("password2") || "");
  if (!check.ok) {
    render(rc, 400, { message: t(`setup.admin.err.${check.code}`, { min: MIN_PASSWORD_LENGTH }) });
    return;
  }

  rc.app.throttle.reset(throttleKey);
  await setPassword(rc.app.db, user.id, password);
  await deleteOtherSessions(rc.app.db, user.id, rc.session?.id ?? null);
  await recordEvent(rc.app.db, { kind: "auth.password", message: `${user.username} hat das Passwort geändert` });
  log.info(`Passwort von ${user.username} geaendert`);
  render(rc, 200, { message: t("account.changed"), kind: "ok" });
}
