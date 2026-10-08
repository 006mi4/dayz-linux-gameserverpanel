import { PANEL_VERSION } from "../version.js";
import { LOCALE_NAMES, LOCALES } from "../i18n/index.js";

/**
 * Serverseitig gerendertes HTML, ohne Bauschritt und ohne JavaScript im
 * Browser. Hier stehen das Geruest der Seite und die Bausteine, aus denen die
 * Ansichten zusammengesetzt sind — Karten, Kacheln, Zustandspunkte, Tabellen.
 *
 * Zwei Regeln, die alles hier bestimmen:
 * - Kein Skript und kein "style"-Attribut. Was anderswo eine berechnete Breite
 *   waere, ist hier eine Klasse (siehe meter()).
 * - Alles Eingesetzte wird maskiert. Wer fertiges HTML einsetzen will, sagt es
 *   mit raw() — dann steht es sichtbar im Aufruf.
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

/* ------------------------------------------------------------- Bildzeichen */

/**
 * Eingebettetes SVG statt Schrift- oder Bilddateien: ein Abruf weniger, und es
 * faerbt sich mit der Textfarbe. Alle Zeichen sind Striche auf 16x16.
 */
const ICONS = {
  gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5 11 8"/>',
  server: '<rect x="2.5" y="3" width="11" height="4" rx="1.5"/><rect x="2.5" y="9" width="11" height="4" rx="1.5"/><path d="M5 5h.01M5 11h.01"/>',
  download: '<path d="M8 2.5v7"/><path d="m5 6.5 3 3 3-3"/><path d="M3 12.5h10"/>',
  box: '<path d="m8 1.8 5.5 3v6.4L8 14.2 2.5 11.2V4.8z"/><path d="M2.5 4.8 8 7.8l5.5-3"/><path d="M8 7.8v6.4"/>',
  link: '<path d="m6.5 9.5 3-3"/><path d="m9.2 4.7 1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1"/><path d="m6.8 11.3-1 1A2.5 2.5 0 0 1 2.3 8.8l1-1"/>',
  play: '<path d="M5.5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
  restart: '<path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.8"/><path d="M13.4 2.4v3.2h-3.2"/>',
  power: '<path d="M8 2.2v5.3"/><path d="M4.6 4.7a4.8 4.8 0 1 0 6.8 0"/>',
  trash: '<path d="M3 4.5h10"/><path d="M6.4 4.5V3h3.2v1.5"/><path d="m4.6 4.5.7 8.5h5.4l.7-8.5"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  check: '<path d="m3.5 8.4 3 3 6-6.6"/>',
  alert: '<path d="M8 2.8 13.7 12.7H2.3z"/><path d="M8 6.4v3M8 11.3h.01"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.7V8l2.2 1.5"/>',
  // Schieberegler statt Zahnrad: Es geht um Werte, nicht um Maschinerie.
  sliders: '<path d="M2.5 4.6h4M9.5 4.6h4M2.5 11.4h2M7.5 11.4h6"/><circle cx="8" cy="4.6" r="1.6"/><circle cx="6" cy="11.4" r="1.6"/>',
  cpu: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/><path d="M6.4 1.8v2.7M9.6 1.8v2.7M6.4 11.5v2.7M9.6 11.5v2.7M1.8 6.4h2.7M1.8 9.6h2.7M11.5 6.4h2.7M11.5 9.6h2.7"/>',
  database: '<ellipse cx="8" cy="3.9" rx="5" ry="2.1"/><path d="M3 3.9v8.2c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V3.9"/><path d="M13 8c0 1.2-2.2 2.1-5 2.1S3 9.2 3 8"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m5 6.6 2 1.9-2 1.9"/><path d="M8.6 10.4h3"/>',
  logout: '<path d="M6.2 3.5H3.5v9h2.7"/><path d="M8.8 8h4.7"/><path d="M11.4 5.6 13.8 8l-2.4 2.4"/>',
  activity: '<path d="M1.5 8h2.8l1.6-4.4 2.6 8.8 1.6-4.4h4.4"/>',
  shield: '<path d="M8 1.8 13 3.6v4c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6v-4z"/>',
};

export function icon(name, extraClass = "") {
  const body = ICONS[name];
  if (!body) return "";
  const cls = extraClass ? `ico ${extraClass}` : "ico";
  return (
    `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

/* ------------------------------------------------------------------ Geruest */

/**
 * Die Seitenleiste. Der Pfad entscheidet, welcher Eintrag hervorgehoben wird;
 * die Unterseiten eines Bereichs zaehlen zu ihrem Eintrag, damit die Markierung
 * beim Blaettern nicht verschwindet.
 */
const NAV = [
  { path: "/", icon: "gauge", key: "nav.dashboard", also: [] },
  { path: "/servers", icon: "server", key: "nav.servers", also: ["/server", "/servers/new", "/job"] },
  { path: "/updates", icon: "download", key: "nav.updates", also: [] },
  { path: "/steam", icon: "box", key: "nav.steam", also: ["/steam/status"] },
  { path: "/dzpage", icon: "link", key: "nav.dzpage", also: [] },
];

function navList(t, path) {
  return NAV.map((entry) => {
    const active = entry.path === path || entry.also.includes(path);
    return html`<a class="${active ? "nav-item active" : "nav-item"}" href="${entry.path}"
      >${raw(icon(entry.icon))}${t(entry.key)}</a
    >`;
  }).join("");
}

export function layout({ title, locale, t, user, body, path = "/", head = "", nav = false }) {
  const langLinks = LOCALES.map((code) =>
    code === locale
      ? html`<span class="lang current">${LOCALE_NAMES[code]}</span>`
      : html`<a class="lang" href="${`${path}?lang=${code}`}">${LOCALE_NAMES[code]}</a>`,
  ).join("");

  const logout = user
    ? html`<form method="post" action="/logout" class="inline">
        <input type="hidden" name="_csrf" value="${user.csrf}">
        <button class="link" type="submit">${raw(icon("logout"))} ${t("common.logout")}</button>
      </form>`
    : "";

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
<div class="app${nav ? "" : " plain"}">
<aside class="side">
  <a class="brand" href="/"><span class="mark">DZ</span> ${escapeHtml(t("app.name"))}</a>
  ${nav ? `<nav>${navList(t, path)}</nav>` : ""}
  <div class="side-foot">${escapeHtml(t("app.version", { version: PANEL_VERSION }))}</div>
</aside>
<div class="main">
  <header class="bar">
    <div class="crumb"><strong>${escapeHtml(title)}</strong></div>
    <div class="who">${langLinks}${user ? html`<a class="account" href="/account">${user.username}</a>` : ""}${logout}</div>
  </header>
  <main class="content">
${body}
  </main>
  <footer class="bottom">${escapeHtml(t("app.footer", { version: PANEL_VERSION }))}</footer>
</div>
</div>
</body>
</html>
`;
}

/* ----------------------------------------------------------- Bausteine */

/** Kopf einer Seite: Titel links, die wichtigste Schaltflaeche rechts. */
export function pageHead({ title, lede = "", actions = "" }) {
  return `<div class="page-head">
    <div><h1>${escapeHtml(title)}</h1>${lede ? html`<p class="lede">${lede}</p>` : ""}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </div>`;
}

/** Karte, wahlweise mit abgesetzter Kopfleiste. */
export function card(body, { title = "", sub = "", actions = "" } = {}) {
  const head = title
    ? `<div class="card-head"><div><h2>${escapeHtml(title)}</h2>${
        sub ? html`<div class="sub">${sub}</div>` : ""
      }</div>${actions ? `<div class="btn-group">${actions}</div>` : ""}</div>`
    : "";
  return `<div class="card">${head}${body}</div>`;
}

/** Kennzahl auf der Uebersicht. */
export function tile({ label, value, sub = "", iconName = "", tone = "" }) {
  return `<div class="tile${tone ? ` is-${tone}` : ""}">
    <div class="k">${iconName ? icon(iconName) : ""}${escapeHtml(label)}</div>
    <div class="v">${escapeHtml(value)}</div>
    ${sub ? html`<div class="s">${sub}</div>` : ""}
  </div>`;
}

/** ok | warn | bad | off */
export function dot(kind) {
  return `<span class="dot ${kind}"></span>`;
}

/** ok | warn | info | bad | off */
export function pill(kind, text) {
  return html`<span class="pill ${kind}">${text}</span>`;
}

/**
 * Fuellstand. Die Breite kommt aus einer Klasse, nicht aus einem
 * "style"-Attribut — die Inhaltsrichtlinie laesst kein Inline-CSS zu. Auf
 * fuenf Prozent gerundet reicht das fuer eine Anzeige, die nur einen Eindruck
 * geben soll.
 */
export function meter(percent, { tone = "" } = {}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const step = Math.round(clamped / 5) * 5;
  return `<div class="meter${tone ? ` ${tone}` : ""} p${step}"><span></span></div>`;
}

export function emptyState({ iconName = "server", text, action = "" }) {
  return `<div class="empty">${icon(iconName, "ico-lg")}<p>${escapeHtml(text)}</p>${action}</div>`;
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
  const mark = kind === "ok" ? "check" : kind === "error" ? "alert" : kind === "warn" ? "clock" : "";
  return html`<p class="notice ${kind}">${raw(mark ? icon(mark) : "")}<span>${message}</span></p>`;
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

/**
 * Ein- und Mehrzahl. Die Mehrzahl steht im Deutschen im Dativ ("vor drei
 * Tagen", "seit drei Tagen") — beide Saetze, in denen diese Angabe vorkommt,
 * verlangen ihn, und "1 Minuten" laesst eine Oberflaeche unfertig aussehen.
 */
function count(t, key, value) {
  return value === 1 ? t(key) : t(`${key}s`, { value });
}

/** Zeitpunkt in Klartext: "3 Minuten" braucht keine Bibliothek. */
export function relativeTime(t, timestamp) {
  if (!timestamp) return t("common.never");
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000));
  if (seconds < 60) return count(t, "time.second", seconds);
  if (seconds < 3600) return count(t, "time.minute", Math.round(seconds / 60));
  if (seconds < 86400) return count(t, "time.hour", Math.round(seconds / 3600));
  return count(t, "time.day", Math.round(seconds / 86400));
}
