import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, launchPanel, prepareEnv, startDzpageStub, unlockSetup } from "../test-support/helper.js";

/**
 * Der Steam-Schritt. Gegen einen Nachbau von SteamCMD, der dieselben
 * Eingabeaufforderungen stellt — damit sind Pseudo-Konsole, Prompt-Erkennung,
 * Rueckfragen und die Streichliste pruefbar, ohne dass echte Zugangsdaten im
 * Spiel sind.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURE = join(FIXTURES, "fake-steamcmd.sh");
const ECHO_FIXTURE = join(FIXTURES, "echo-once.sh");
const PASSWORD = "panel-test-passwort";

const env = prepareEnv("steam");
process.on("exit", () => env.cleanup());
// Unter Windows ausgecheckt fehlt das Ausfuehrungsrecht — hier einmal setzen.
chmodSync(FIXTURE, 0o755);
chmodSync(ECHO_FIXTURE, 0o755);

const { steamLogin, findSteamCmd, PATTERNS, ACCOUNT_PATTERN } = await import("../src/steam/steamcmd.js");
const { isPtyAvailable, spawnPty, stripAnsi } = await import("../src/steam/pty.js");
const { createJobs } = await import("../src/jobs.js");

function runLogin({ account, password = PASSWORD }) {
  const jobs = createJobs();
  const started = jobs.start("steam-login", (job) =>
    steamLogin({ steamcmdPath: FIXTURE, account, password, job }),
  );
  return started.job;
}

async function waitFor(check, { timeoutMs = 20_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Bedingung wurde nicht erreicht.");
}

test("script(1) ist vorhanden", () => {
  assert.equal(isPtyAvailable(), true);
});

test("Pseudo-Konsole reicht Eingaben durch und meldet das Ende", async () => {
  const pty = spawnPty({ command: ECHO_FIXTURE });
  await pty.waitFor({ ready: /ready:\s*$/ }, { timeoutMs: 10_000 });
  pty.write("hallo");
  const exit = await pty.exited;
  assert.match(pty.output, /GOT=hallo/);
  assert.equal(exit.code, 0);
});

test("Anmeldung gelingt und das Passwort steht nirgends im Protokoll", async () => {
  const job = runLogin({ account: "testkonto" });
  const result = await waitFor(() => (job.running ? null : job));
  assert.equal(job.status, "ok", job.error || "");
  assert.deepEqual(result.result, { ok: true, account: "testkonto" });

  const text = job.lines.join("\n");
  assert.match(text, /Logging in user 'testkonto'/);
  assert.match(text, /Waiting for user info\.\.\.OK/);
  assert.equal(text.includes(PASSWORD), false, "Das Passwort darf nicht im Protokoll stehen.");
});

test("Falsches Passwort wird als Klartext gemeldet", async () => {
  const job = runLogin({ account: "testkonto", password: "falsch-falsch" });
  const result = await waitFor(() => (job.running ? null : job.result));
  // steamLogin meldet den Fehlschlag als Rueckgabewert; erst die Route macht
  // daraus einen gescheiterten Vorgang.
  assert.equal(result.ok, false);
  assert.match(result.message, /Invalid Password/);
});

test("Steam-Guard: Rückfrage, Antwort, Erfolg", async () => {
  const job = runLogin({ account: "guard_konto" });
  const question = await waitFor(() => job.awaiting);
  assert.equal(question.kind, "guard");

  assert.equal(job.provide("54321"), true);
  await waitFor(() => (job.running ? null : true));
  assert.equal(job.status, "ok", job.error || "");
  assert.equal(job.lines.join("\n").includes("54321"), false, "Der Code darf nicht im Protokoll stehen.");
});

test("Steam-Guard: falscher Code scheitert verständlich", async () => {
  const job = runLogin({ account: "guard_konto" });
  await waitFor(() => job.awaiting);
  job.provide("11111");
  const result = await waitFor(() => (job.running ? null : job.result));
  assert.equal(result.ok, false);
  assert.match(result.message, /Two-factor code mismatch/);
});

test("Unbekannte Rückfrage wird im Wortlaut weitergereicht", async () => {
  const job = runLogin({ account: "ask_konto" });
  const question = await waitFor(() => job.awaiting);
  assert.equal(question.kind, "prompt");
  assert.match(question.text, /confirm the device name/i);
  job.provide("heimserver");
  await waitFor(() => (job.running ? null : true));
  assert.equal(job.status, "ok", job.error || "");
});

test("Kontonamen mit Sonderzeichen werden abgewiesen", async () => {
  assert.equal(ACCOUNT_PATTERN.test("gut_konto-1.2"), true);
  assert.equal(ACCOUNT_PATTERN.test("konto; rm -rf /"), false);
  const jobs = createJobs();
  const job = jobs.start("steam-login", (ctl) =>
    steamLogin({ steamcmdPath: FIXTURE, account: "boese konto", password: "x", job: ctl }),
  ).job;
  const result = await waitFor(() => (job.running ? null : job.result));
  assert.equal(result.ok, false);
});

test("Muster erkennen die Ausgaben von SteamCMD", () => {
  assert.equal(PATTERNS.consolePrompt.test("Loading Steam API...OK\nSteam>"), true);
  assert.equal(PATTERNS.passwordPrompt.test("password: "), true);
  assert.equal(PATTERNS.guardPrompt.test("Two-factor code: "), true);
  assert.equal(PATTERNS.guardPrompt.test("Steam Guard code: "), true);
  assert.equal(PATTERNS.loginOk.test("Waiting for user info...OK"), true);
  assert.equal(PATTERNS.loginFailed.test("FAILED (Invalid Password)"), true);
  assert.equal(PATTERNS.loginFailed.test("Rate Limit Exceeded"), true);
  // Ein Prompt ist erst einer, wenn nichts mehr dahinter kommt.
  assert.equal(PATTERNS.passwordPrompt.test("password: \nOK\n"), false);
});

test("Am echten Client gemessene Ausgaben werden richtig eingeordnet", () => {
  // Wortlaut aus einem Lauf gegen SteamCMD 1785799152 auf Ubuntu 22.04.
  const startup =
    "Redirecting stderr to '/var/lib/dzpage-panel/steam-home/Steam/logs/stderr.txt'\r\n" +
    'ILocalize::AddFile() failed to load file "public/steambootstrapper_english.txt".\r\n' +
    "[  0%] Checking for available update...\r\n";
  assert.equal(
    PATTERNS.loginFailed.test(startup),
    false,
    "Startmeldungen mit kleingeschriebenem 'failed' sind kein Anmeldefehler",
  );

  const prompt = stripAnsi(
    "Steam Console Client (c) Valve Corporation - version 1785799152\r\n-- type 'quit' to exit --\r\n" +
      "Loading Steam API...\u001B[0mOK\r\n\u001B[0m\u001B[1m\r\nSteam>\u001B[0m",
  );
  assert.equal(PATTERNS.consolePrompt.test(prompt), true, "Farbcodes hinter dem Prompt müssen weg sein");

  const asking = stripAnsi("\u001B[1mCached credentials not found.\r\n\u001B[0m\r\npassword: \u001B[0m");
  assert.equal(PATTERNS.passwordPrompt.test(asking), true);
  assert.equal(PATTERNS.cachedCredentialsMissing.test(asking), true);

  // Das Ergebnis steht MITTEN in der Zeile, nicht an deren Anfang.
  const rejected =
    "Proceeding with login using username/password.\r\n" +
    "Logging in user 'probekonto' [U:1:0] to Steam Public...ERROR (Invalid Password)\r\n\r\nSteam>";
  assert.equal(PATTERNS.loginFailed.test(rejected), true);
  assert.equal(PATTERNS.loginOk.test(rejected), false);

  // Ein Fehlergrund, den wir noch nie gesehen haben, darf nicht als Erfolg
  // durchgehen — sonst meldet das Panel eine Anmeldung, die es nicht gab.
  const unseen = "Logging in user 'probekonto' [U:1:0] to Steam Public...ERROR (Account Disabled)\r\n\r\nSteam>";
  assert.equal(PATTERNS.loginFailed.test(unseen), true);
  assert.equal(PATTERNS.loginOk.test(unseen), false);

  const accepted =
    "Logging in user 'probekonto' [U:1:0] to Steam Public...OK\r\nWaiting for user info...OK\r\n\r\nSteam>";
  assert.equal(PATTERNS.loginOk.test(accepted), true);
  assert.equal(PATTERNS.loginFailed.test(accepted), false);
});

test("stripAnsi entfernt Farbcodes und lässt den Text stehen", () => {
  assert.equal(stripAnsi("\u001B[0m\u001B[1mHallo\u001B[0m"), "Hallo");
  assert.equal(stripAnsi("a\u001B]0;Titel\u0007b"), "ab");
  assert.equal(stripAnsi("kein [Klammertext] verloren"), "kein [Klammertext] verloren");
});

test("Gemerkte Anmeldung: trägt und trägt nicht", async () => {
  const { verifySession } = await import("../src/steam/steamcmd.js");
  assert.deepEqual(await verifySession({ steamcmdPath: FIXTURE, account: "cached_konto" }), { ok: true });

  const stale = await verifySession({ steamcmdPath: FIXTURE, account: "testkonto" });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /Sitzungstoken/);
});

test("Vorhandenes SteamCMD wird gefunden", () => {
  assert.equal(findSteamCmd({ steam: { steamcmdPath: FIXTURE } }).path, FIXTURE);
  assert.equal(findSteamCmd({ steam: { steamcmdPath: "/gibt/es/nicht" } })?.path !== "/gibt/es/nicht", true);
});

test("Steam-Schritt über HTTP: Rückfrage im Browser beantworten", async () => {
  const stub = await startDzpageStub();
  process.env.DZPAGE_BASE_URL = stub.url;
  const panel = await launchPanel();
  const client = new Client(panel.url);

  await unlockSetup(client, env);
  await client.get("/setup/database");
  await client.submit("/setup/database", { kind: "sqlite", action: "save" });
  await client.get("/setup/admin");
  await client.submit("/setup/admin", {
    username: "admin",
    password: "panel-passwort-1",
    password2: "panel-passwort-1",
  });
  panel.app.config.steam.steamcmdPath = FIXTURE;

  await client.get("/steam");
  await client.submit("/steam", { action: "login", account: "guard_konto", password: PASSWORD });
  assert.equal(client.lastStatus, 303);
  assert.match(client.lastLocation, /^\/steam\/status\?id=/);
  const statusPath = client.lastLocation;

  await waitFor(() => panel.app.jobs.current().awaiting);
  await client.get(statusPath);
  assert.match(client.lastBody, /Steam Guard code|Steam-Guard-Code/);

  const jobId = panel.app.jobs.current().id;
  await client.submit("/steam/status", { id: jobId, answer: "54321" });
  await waitFor(() => (panel.app.jobs.current().running ? null : true));

  await client.get(statusPath);
  assert.match(client.lastBody, /Signed in as guard_konto/);
  assert.equal(client.lastBody.includes(PASSWORD), false);
  // Fertig heisst: keine Selbstaktualisierung mehr.
  assert.equal(/http-equiv="refresh"/.test(client.lastBody), false);

  await client.get("/dzpage");
  assert.equal(client.lastStatus, 200);

  // Die Probe aus der Oberflaeche: genau das Abnahmekriterium der Phase —
  // meldet sich das Konto ohne Passwort an?
  await client.get("/steam");
  assert.match(client.lastBody, /Check the saved sign-in/);
  await client.submit("/steam", { action: "verify" });
  assert.match(client.lastLocation, /^\/steam\/status\?id=/);
  const verifyPath = client.lastLocation;
  await waitFor(() => (panel.app.jobs.current().running ? null : true));
  await client.get(verifyPath);
  // Das Testkonto heisst nicht "cached*", die Probe muss also scheitern.
  assert.match(client.lastBody, /saved session does not work/);

  // Fehlschlag auf demselben Weg: die Route macht aus dem Ergebnis einen
  // gescheiterten Vorgang, die Statusseite zeigt den Grund.
  await client.get("/steam");
  await client.submit("/steam", { action: "login", account: "badpass_konto", password: PASSWORD });
  const failPath = client.lastLocation;
  await waitFor(() => (panel.app.jobs.current().running ? null : true));
  await client.get(failPath);
  assert.match(client.lastBody, /Invalid Password/);
  assert.match(client.lastBody, /Sign-in failed/);

  await panel.stop();
  await stub.stop();
});

test("SteamCMD-Installation aus dem Netz", { skip: process.env.DZPANEL_NET_TESTS !== "1" }, async () => {
  const { installSteamCmd } = await import("../src/steam/steamcmd.js");
  const { createJobs } = await import("../src/jobs.js");
  const job = createJobs().start("install", async () => {}).job;
  const path = await installSteamCmd(job);
  assert.equal(existsSync(path), true);
  assert.match(job.lines.join("\n"), /Lade SteamCMD/);
});
