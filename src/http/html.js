import { PANEL_VERSION } from "../version.js";
import { LOCALE_NAMES, LOCALES } from "../i18n/index.js";

/**
 * Serverseitig gerendertes HTML, ohne Bauschritt und ohne JavaScript im
 * Browser. Der Assistent sind fuenf Formulare — ein Bundler stuende in keinem
 * Verhaeltnis, und ohne Skripte im Browser bleibt die Inhaltsrichtlinie so
 * streng, wie sie fuer ein Panel sein sollte.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Kurzform fuer Vorlagen: alles Eingesetzte wird maskiert. */
export function html(strings, ...values) {
  return strings.reduce((out, part, index) => {
    if (index === 0) return part;
    const value = values[index - 1];
    const text = value instanceof Raw ? value.value : escapeHtml(value);
    return out + text + part;
  }, "");
}

class Raw {
  constructor(value) {
    this.value = value;
  }
}

/** Bereits fertiges HTML einsetzen, ohne es erneut zu maskieren. */
export function raw(value) {
  return new Raw(Array.isArray(value) ? value.join("") : String(value ?? ""));
}

export function layout({ title, locale, t, user, body, path = "/", head = "" }) {
  const langLinks = LOCALES.map((code) =>
    code === locale
      ? html`<span class="lang current">${LOCALE_NAMES[code]}</span>`
      : html`<a class="lang" href="${`${path}?lang=${code}`}">${LOCALE_NAMES[code]}</a>`,
  );

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${head}
<title>${escapeHtml(title)} · ${escapeHtml(t("app.name"))}</title>
<link rel="icon" href="/assets/icon.svg">
<link rel="stylesheet" href="/assets/panel.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="mark">DZ</span> ${escapeHtml(t("app.name"))}</a>
  <nav>
    ${langLinks.join("")}
    ${
      user
        ? html`<form method="post" action="/logout" class="inline">
            <input type="hidden" name="_csrf" value="${user.csrf}">
            <button class="link" type="submit">${t("common.logout")}</button>
          </form>`
        : ""
    }
  </nav>
</header>
<main>
${body}
</main>
<footer class="bottom">${escapeHtml(t("app.footer", { version: PANEL_VERSION }))}</footer>
</body>
</html>
`;
}

/** Fortschrittsleiste des Assistenten. */
export function stepper(t, current) {
  const steps = [
    "setup.step.database",
    "setup.step.admin",
    "setup.step.steam",
    "setup.step.dzpage",
    "setup.step.done",
  ];
  const items = steps.map((key, index) => {
    const number = index + 1;
    const state = number === current ? "current" : number < current ? "done" : "todo";
    return html`<li class="${state}"><span class="num">${number}</span>${t(key)}</li>`;
  });
  return `<ol class="stepper">${items.join("")}</ol>`;
}

export function notice(kind, message) {
  return html`<p class="notice ${kind}">${message}</p>`;
}

export function field({ name, label, type = "text", value = "", hint = "", required = false, autocomplete, inputmode, min, max }) {
  const id = `f_${name}`;
  return html`<p class="field">
    <label for="${id}">${label}</label>
    <input id="${id}" name="${name}" type="${type}" value="${value}"
      ${raw(required ? "required" : "")}
      ${raw(autocomplete ? `autocomplete="${escapeHtml(autocomplete)}"` : 'autocomplete="off"')}
      ${raw(inputmode ? `inputmode="${escapeHtml(inputmode)}"` : "")}
      ${raw(min !== undefined ? `min="${escapeHtml(min)}"` : "")}
      ${raw(max !== undefined ? `max="${escapeHtml(max)}"` : "")}>
    ${raw(hint ? html`<span class="hint">${hint}</span>` : "")}
  </p>`;
}

export function csrfInput(token) {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

/** Zeitpunkt in Klartext: "vor 3 Minuten" braucht keine Bibliothek. */
export function relativeTime(t, timestamp) {
  if (!timestamp) return t("common.never");
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000));
  if (seconds < 60) return t("time.seconds", { value: seconds });
  if (seconds < 3600) return t("time.minutes", { value: Math.round(seconds / 60) });
  if (seconds < 86400) return t("time.hours", { value: Math.round(seconds / 3600) });
  return t("time.days", { value: Math.round(seconds / 86400) });
}
