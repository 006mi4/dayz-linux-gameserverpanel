import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_LOCALES,
  fillText,
  isYes,
  localeFromEnv,
  normalizeLocale,
  readCatalog,
  terminalLocale,
  terminalTranslator,
} from "../src/i18n/terminal.js";

/**
 * Die Texte im Terminal: zehn Kataloge, die bash und Node gleichermassen
 * lesen. Geprueft wird, was beim Uebersetzen schiefgehen kann (fehlende oder
 * verbogene Platzhalter, Befehle uebersetzt, Gedankenstriche) und dass bash
 * und Node dasselbe ausgeben.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_DIR = join(ROOT, "src", "i18n", "terminal");
const PLACEHOLDER = /\{([a-z_]+)\}/g;
// Geviert-, Halbgeviert- und Ziffernstrich, waagerechter Strich.
const DASHES = /[\u2012-\u2015]/;

const en = readCatalog("en");
const placeholders = (text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();

/** Was der Mensch so abtippen muss, wie es dasteht: Optionen, Befehle, Pfade, Adressen. */
const LITERAL = new RegExp(
  [
    String.raw`--[a-z][a-z-]*`,
    String.raw`dzp_pair_`,
    String.raw`https?://[^\s)",;]*[^\s)",;.:]`,
    String.raw`(?:/[a-z0-9_.-]+){2,}`,
    String.raw`(?<![/\w-])dzpage-panel(?: (?:link|steam-login|status|setup-code|reset-password|https|logs|uninstall|help))?`,
    String.raw`journalctl -u [a-z-]+ -e`,
  ].join("|"),
  "g",
);
function literals(text) {
  return (text.match(LITERAL) ?? []).sort();
}

test("Jede Sprache hat ihre Datei, und es gibt keine weiteren", () => {
  const files = readdirSync(CATALOG_DIR).filter((name) => name.endsWith(".txt")).map((name) => name.slice(0, -4));
  assert.deepEqual(files.sort(), [...TERMINAL_LOCALES].sort());
});

for (const locale of TERMINAL_LOCALES) {
  test(`${locale}.txt: dieselben Texte wie en.txt, Platzhalter und Befehle unverändert`, () => {
    const raw = readFileSync(join(CATALOG_DIR, `${locale}.txt`), "utf8");
    const seen = new Set();
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      assert.ok(!line.endsWith("\r"), `${locale}: Zeilenende CRLF`);
      const key = line.slice(0, line.indexOf("="));
      assert.match(key, /^[a-z]+(\.[a-z0-9_]+)+$/, `${locale}: Schlüssel "${key}"`);
      assert.ok(!seen.has(key), `${locale}: ${key} doppelt`);
      seen.add(key);
    }

    const catalog = readCatalog(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), `${locale}: andere Schlüssel als en.txt`);
    for (const [key, text] of Object.entries(catalog)) {
      assert.ok(text.length > 0, `${locale} ${key}: leer`);
      assert.equal(text, text.trim(), `${locale} ${key}: Leerzeichen am Rand`);
      assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/, `${locale} ${key}: Steuerzeichen`);
      assert.doesNotMatch(text, DASHES, `${locale} ${key}: Gedankenstrich`);
      assert.deepEqual(placeholders(text), placeholders(en[key]), `${locale} ${key}: Platzhalter`);
      for (const literal of literals(en[key])) {
        assert.ok(text.includes(literal), `${locale} ${key}: "${literal}" fehlt`);
      }
    }
  });
}

test("Jeder Schlüssel im Code steht in en.txt, und jeder Text wird benutzt", () => {
  const shell = ["install.sh", "helper/dzpage-panel-cli.sh", "helper/uninstall.sh", "helper/https.sh"]
    .map((file) => readFileSync(join(ROOT, file), "utf8"))
    .join("\n");
  const node = readFileSync(join(ROOT, "bin", "dzpage-panel-admin.js"), "utf8");
  const used = new Set([
    ...[...shell.matchAll(/\bt ((?:common|install|uninstall|https|cli)\.[a-z0-9_.]+)/g)].map((m) => m[1]),
    ...[...node.matchAll(/"((?:admin|common)\.[a-z0-9_.]+)"/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((key) => !(key in en));
  const unused = Object.keys(en).filter((key) => !used.has(key));
  assert.deepEqual(missing, [], "im Code benutzt, aber nicht in en.txt");
  assert.deepEqual(unused, [], "in en.txt, aber nirgends benutzt");
});

test("Sprache: ausdrücklich, dann gemerkt, dann Umgebung, sonst Englisch", () => {
  const dir = mkdtempSync(join(tmpdir(), "dzp-i18n-"));
  try {
    const installFile = join(dir, "install.json");
    const none = join(dir, "fehlt.json");
    writeFileSync(installFile, JSON.stringify({ method: "git", lang: "pl" }));

    assert.equal(terminalLocale({ env: { DZPAGE_PANEL_LANG: "cs", LANG: "de_DE.UTF-8" }, installFile }), "cs");
    assert.equal(terminalLocale({ env: { LANG: "de_DE.UTF-8" }, installFile }), "pl");
    assert.equal(terminalLocale({ env: { LANG: "de_DE.UTF-8" }, installFile: none }), "de");
    assert.equal(terminalLocale({ env: { LANG: "C.UTF-8" }, installFile: none }), "en");
    assert.equal(terminalLocale({ env: {}, installFile: none }), "en");
    // Unbekannt zaehlt wie nicht angegeben.
    assert.equal(terminalLocale({ env: { DZPAGE_PANEL_LANG: "tlh", LANG: "fr_FR" }, installFile: none }), "fr");

    // Wie gettext: LC_ALL=C heisst Englisch, auch wenn LANG etwas anderes sagt.
    assert.equal(localeFromEnv({ LC_ALL: "C", LANG: "de_DE.UTF-8" }), null);
    assert.equal(localeFromEnv({ LC_MESSAGES: "ru_RU.UTF-8", LANG: "de_DE.UTF-8" }), "ru");
    for (const [input, expected] of [
      ["de_DE.UTF-8", "de"], ["pt_BR", "pt"], ["pt-BR", "pt"], ["ZH", "zh"], ["zh_TW.UTF-8", "zh"],
      ["sr@latin", null], ["", null], ["C.UTF-8", null], ["POSIX", null], ["english", null], ["de fr", null],
    ]) {
      assert.equal(normalizeLocale(input), expected, input);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Platzhalter: ein Durchgang, fehlende bleiben stehen, Rückfall auf Englisch", () => {
  assert.equal(fillText("a {x} b {y}", { x: "{y}", y: "2" }), "a {y} b 2");
  assert.equal(fillText("{x} und {fehlt}", { x: "$&" }), "$& und {fehlt}");
  const de = terminalTranslator("de");
  assert.equal(de("install.arch", { arch: "x86_64" }), "Architektur x86_64");
  assert.equal(de("gibt.es.nicht"), "gibt.es.nicht");
  assert.equal(terminalTranslator("en")("install.arch", { arch: "x86_64" }), "Architecture x86_64");
});

test("Ja an der Kontofrage, in jeder der zehn Sprachen; alles andere ist nein", () => {
  for (const yes of ["", "  ", "y", "Y", "yes", "j", "JA", "o", "oui", "s", "sí", "si", "sì", "sim", "t", "tak", "a", "ano", "д", "Да", "是", "好"]) {
    assert.equal(isYes(yes), true, JSON.stringify(yes));
  }
  for (const no of ["n", "no", "nein", "non", "nie", "ne", "não", "нет", "н", "否", "不", "x", "yes please", "jj"]) {
    assert.equal(isYes(no), false, JSON.stringify(no));
  }
});

/* ------------------------------------------------------------------ bash */

const bash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
const noBash = bash.status === 0 && bash.stdout.trim() === "ok" ? false : "kein bash";

/**
 * bash mit helper/i18n.sh, als waere es kein root (sonst laese i18n_stored eine
 * echte Installation auf der Testmaschine). Ausgabe NUL-getrennt.
 */
function runBash(script, env = {}) {
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; id() { [ "\${1:-}" = -u ] && [ -z "\${2:-}" ] && echo 4242 || command id "$@"; }; . "$I18N_LIB"; ${script}`],
    { encoding: "utf8", env: { PATH: process.env.PATH, I18N_LIB: join(ROOT, "helper", "i18n.sh"), ...env } },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("bash liest jeden Katalog genau wie Node", { skip: noBash }, () => {
  for (const locale of TERMINAL_LOCALES) {
    const out = runBash(
      `i18n_load "$FILE"; for k in "\${!I18N_TEXT[@]}"; do printf '%s\\0%s\\0' "$k" "\${I18N_TEXT[$k]}"; done`,
      { FILE: join(CATALOG_DIR, `${locale}.txt`) },
    );
    const parts = out.split("\0").slice(0, -1);
    const fromBash = {};
    for (let i = 0; i < parts.length; i += 2) fromBash[parts[i]] = parts[i + 1];
    assert.deepEqual(fromBash, readCatalog(locale), locale);
  }
});

test("bash ersetzt Platzhalter wie Node, auch mit & und {name} im Wert", { skip: noBash }, () => {
  const out = runBash(
    `i18n_init "$DIR" de; t install.disk gb='5&' dir='{gb}/x'; printf '\\0'; t install.arch; printf '\\0'; t gibt.es.nicht arch=1; printf '\\0'; printf '%s' "$DZPAGE_PANEL_LANG"`,
    { DIR: CATALOG_DIR },
  );
  const de = terminalTranslator("de");
  assert.deepEqual(out.split("\0"), [
    de("install.disk", { gb: "5&", dir: "{gb}/x" }),
    "Architektur {arch}",
    "gibt.es.nicht",
    "de",
  ]);
});

test("bash bestimmt die Sprache wie Node", { skip: noBash }, () => {
  const cases = [
    [{ LANG: "de_DE.UTF-8" }, "", "de"],
    [{ LANG: "C.UTF-8" }, "", "en"],
    [{ LC_ALL: "C", LANG: "fr_FR.UTF-8" }, "", "en"],
    [{ LC_MESSAGES: "pt_BR.UTF-8" }, "", "pt"],
    [{ LANG: "de_DE.UTF-8" }, "zh", "zh"],
    [{ LANG: "de_DE.UTF-8", DZPAGE_PANEL_LANG: "it" }, "", "it"],
    [{ LANG: "ru_RU.UTF-8" }, "klingonisch", "ru"],
    // Nur genau zwei Buchstaben: "de fr" stand sonst als " de fr " in der Liste.
    [{ LANG: "pl_PL.UTF-8" }, "de fr", "pl"],
    [{ LANG: "en de" }, "", "en"],
  ];
  for (const [env, explicit, expected] of cases) {
    const out = runBash(`i18n_init "$DIR" "$WANT"; printf '%s|%s' "$I18N_LOCALE" "$I18N_REJECTED"`, {
      DIR: CATALOG_DIR,
      WANT: explicit,
      ...env,
    });
    const [locale, rejected] = out.split("|");
    assert.equal(locale, expected, JSON.stringify({ env, explicit }));
    assert.equal(locale, terminalLocale({ env: { ...env, DZPAGE_PANEL_LANG: explicit || env.DZPAGE_PANEL_LANG }, installFile: "/gibt/es/nicht" }));
    assert.equal(rejected, explicit && !normalizeLocale(explicit) ? explicit : "");
  }
});

test("--lang wird gefunden, ohne die Argumente zu verbrauchen", { skip: noBash }, () => {
  const out = runBash(
    `i18n_arg --pair x --lang de --no-link; printf '|'; i18n_arg --lang=fr; printf '|'; i18n_arg --pair x; printf '|'; i18n_arg --lang; printf '|'; i18n_arg --lang de --lang=it; printf '|'; i18n_arg --lang --purge`,
  );
  // Eine Option direkt nach --lang ist kein Wert: "--lang --purge" darf --purge nicht schlucken.
  assert.equal(out, "de|fr|||it|");
});

/* ------------------------------------------------------------- bootstrap */

/**
 * bootstrap.sh kommt allein per curl und hat seine Texte deshalb selbst. Je
 * Sprache dieselben Namen, jeweils so viele %s wie im Englischen und kein
 * anderes %, weil die Texte als printf-Format dienen.
 */
test("bootstrap.sh: jede Sprache mit allen Texten und passenden %s", () => {
  const source = readFileSync(join(ROOT, "bootstrap.sh"), "utf8");
  const body = source.slice(source.indexOf("bootstrap_texts() {"), source.indexOf("\nbootstrap_main() {"));
  const [defaults, cases] = body.split('  case "$1" in');
  const assignments = (block) =>
    Object.fromEntries([...block.matchAll(/^\s+(T_[A-Z_]+)="([^"]*)"$/gm)].map((m) => [m[1], m[2]]));
  const base = assignments(defaults);
  assert.ok(Object.keys(base).length >= 10);
  const blocks = {};
  for (const part of cases.split(/^\s{4}([a-z]{2})\)$/m).slice(1).reduce((acc, item, i, all) => {
    if (i % 2 === 0) acc.push([item, all[i + 1]]);
    return acc;
  }, [])) {
    blocks[part[0]] = assignments(part[1]);
  }
  assert.deepEqual(Object.keys(blocks).sort(), TERMINAL_LOCALES.filter((l) => l !== "en").sort());
  for (const [locale, texts] of Object.entries(blocks)) {
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(base).sort(), locale);
    for (const [name, text] of Object.entries(texts)) {
      const formats = (s) => (s.match(/%./g) ?? []).join("");
      assert.equal(formats(text), formats(base[name]), `${locale} ${name}`);
      assert.doesNotMatch(text, DASHES, `${locale} ${name}`);
      assert.ok(text.length > 0, `${locale} ${name}`);
    }
  }
});

test("bootstrap.sh bestimmt die Sprache wie install.sh", { skip: noBash }, () => {
  const lib = join(ROOT, "bootstrap.sh");
  for (const [args, env, expected] of [
    ["--pair x --lang de", { LANG: "fr_FR.UTF-8" }, "de"],
    ["--lang=pl", {}, "pl"],
    ["", { LANG: "cs_CZ.UTF-8" }, "cs"],
    ["", { LC_ALL: "C", LANG: "de_DE.UTF-8" }, "en"],
    ["--lang xx", { LANG: "de_DE.UTF-8" }, "de"],
    ["--lang de --lang=it", {}, "it"],
    ["--lang 'de fr'", { LANG: "cs_CZ.UTF-8" }, "cs"],
    ["--lang --no-link", { LANG: "fr_FR.UTF-8" }, "fr"],
  ]) {
    const result = spawnSync(
      "bash",
      ["-c", `id() { [ "\${1:-}" = -u ] && [ -z "\${2:-}" ] && echo 4242 || command id "$@"; }; source <(sed '$d' "$LIB"); bootstrap_lang ${args}`],
      { encoding: "utf8", env: { PATH: process.env.PATH, LIB: lib, ...env } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, JSON.stringify({ args, env }));
  }
});
