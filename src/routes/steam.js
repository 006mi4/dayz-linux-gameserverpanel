import { saveConfig } from "../config.js";
import { ACCOUNT_PATTERN, ensureSteamCmd, steamLogin, verifySession } from "../steam/steamcmd.js";
import { isPtyAvailable } from "../steam/pty.js";
import { deleteSetting, getSetting, KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";
import { csrfInput, escapeHtml, field, notice, stepper } from "../http/html.js";
import { log } from "../log.js";

/**
 * Schritt 3: Steam-Anmeldung. Der einzige Schritt, der sich nicht ohne echte
 * Zugangsdaten pruefen laesst — deshalb wurde er zuletzt gebaut, und deshalb
 * darf er uebersprungen werden: ohne ihn kann das Panel spaeter kein DayZ
 * herunterladen, aber der Assistent laeuft durch.
 *
 * Die Anmeldung laeuft als Vorgang im Hintergrund; die Statusseite laedt sich
 * selbst neu, damit die Oberflaeche ohne JavaScript lebendig bleibt.
 */

const JOB_KIND = "steam-login";
const VERIFY_KIND = "steam-verify";

function frame(rc, inSetup, body) {
  return inSetup ? `${stepper(rc.t, 3)}<div class="card">${body}</div>` : `<div class="card">${body}</div>`;
}

function loginForm(rc, { account = "", inSetup, connected = false, message = null, messageKind = "error" }) {
  const t = rc.t;
  // Ist das Konto schon angemeldet, gehoert die Probe nach oben: sie beantwortet
  // genau die Frage, um die es geht — traegt das gemerkte Sitzungstoken noch?
  const verifyBlock = connected
    ? `<form method="post" action="/steam">
         ${csrfInput(rc.csrf)}
         <div class="actions">
           <button class="secondary" type="submit" name="action" value="verify">${escapeHtml(
             t("setup.steam.verify"),
           )}</button>
         </div>
         <p class="hint">${escapeHtml(t("setup.steam.verifyHint"))}</p>
       </form>`
    : "";

  return `
    <h1>${escapeHtml(t("setup.steam.heading"))}</h1>
    <p class="lede">${escapeHtml(t("setup.steam.lede"))}</p>
    ${message ? notice(messageKind, message) : ""}
    ${verifyBlock}
    <form method="post" action="/steam">
      ${csrfInput(rc.csrf)}
      ${field({
        name: "account",
        label: t("setup.steam.account"),
        value: account,
        required: true,
        autocomplete: "off",
      })}
      ${field({
        name: "password",
        label: t("setup.steam.password"),
        type: "password",
        hint: t("setup.steam.passwordHint"),
        required: true,
        autocomplete: "off",
      })}
      <div class="actions">
        <button class="primary" type="submit" name="action" value="login">${escapeHtml(t("setup.steam.start"))}</button>
        ${
          inSetup
            ? `<button class="secondary" type="submit" name="action" value="skip">${escapeHtml(
                t("common.skip"),
              )}</button>`
            : `<a class="button secondary" href="/">${escapeHtml(t("common.back"))}</a>`
        }
      </div>
    </form>
    ${inSetup ? `<p class="hint">${escapeHtml(t("setup.steam.skipWarning"))}</p>` : ""}`;
}

export async function page(rc) {
  const progress = await rc.app.setupProgress();
  const inSetup = !progress.completed;

  if (rc.method === "GET") {
    const running = rc.app.jobs.current();
    if (running && running.running && (running.kind === JOB_KIND || running.kind === VERIFY_KIND)) {
      rc.redirect(`/steam/status?id=${running.id}`);
      return;
    }
    const account = (await getSetting(rc.app.db, KEYS.steamAccount)) || "";
    const ptyMissing = !isPtyAvailable();
    rc.page(
      200,
      rc.t("setup.step.steam"),
      frame(
        rc,
        inSetup,
        loginForm(rc, {
          account,
          inSetup,
          connected: progress.steamDone && !ptyMissing,
          message: ptyMissing
            ? "script(1) aus util-linux fehlt auf diesem System — ohne Terminal kann SteamCMD nicht nach dem Passwort fragen."
            : progress.steamDone
              ? rc.t("setup.steam.success", { account })
              : null,
          messageKind: ptyMissing ? "error" : "ok",
        }),
      ),
      { nav: !inSetup },
    );
    return;
  }

  if (rc.form.get("action") === "verify") {
    const account = (await getSetting(rc.app.db, KEYS.steamAccount)) || "";
    const config = rc.config;
    const started = rc.app.jobs.start(VERIFY_KIND, async (job) => {
      const found = await ensureSteamCmd(config, job);
      job.append(`Prüfe die gemerkte Anmeldung für ${account}.`);
      const result = await verifySession({ steamcmdPath: found.path, account });
      if (!result.ok) throw new Error(result.message);
      return { account };
    });
    if (!started.ok) {
      rc.page(
        409,
        rc.t("setup.step.steam"),
        frame(rc, inSetup, loginForm(rc, { account, inSetup, connected: true, message: rc.t("setup.steam.busy") })),
        { nav: !inSetup },
      );
      return;
    }
    rc.redirect(`/steam/status?id=${started.job.id}`);
    return;
  }

  if (rc.form.get("action") === "skip" && inSetup) {
    await setSetting(rc.app.db, KEYS.steamSkipped, "1");
    await recordEvent(rc.app.db, { kind: "setup.steam", message: "Steam-Anmeldung übersprungen" });
    rc.redirect("/dzpage");
    return;
  }

  const account = (rc.form.get("account") || "").trim();
  const password = rc.form.get("password") || "";
  if (!ACCOUNT_PATTERN.test(account) || !password) {
    rc.page(
      400,
      rc.t("setup.step.steam"),
      frame(
        rc,
        inSetup,
        loginForm(rc, {
          account,
          inSetup,
          message: rc.t("setup.steam.failed", { message: "Kontoname oder Passwort fehlt." }),
        }),
      ),
      { nav: !inSetup },
    );
    return;
  }

  // Der Vorgang laeuft weiter, nachdem die Antwort raus ist. Deshalb bekommt er
  // nur Konfiguration und Datenbank mit — haenge er an der Anfrage, hielte er
  // Anfrage und Verbindung unnoetig am Leben.
  const { config, db } = { config: rc.config, db: rc.app.db };
  const started = rc.app.jobs.start(JOB_KIND, async (job) => {
    const found = await ensureSteamCmd(config, job);
    if (found.installed) {
      config.steam.steamcmdPath = found.path;
      saveConfig(config);
      job.append("SteamCMD installiert.");
    }
    const result = await steamLogin({ steamcmdPath: found.path, account, password, job });
    if (!result.ok) throw new Error(result.message);

    await setSetting(db, KEYS.steamAccount, account);
    await setSetting(db, KEYS.steamLoggedInAt, Date.now());
    await deleteSetting(db, KEYS.steamSkipped);
    await recordEvent(db, { kind: "setup.steam", message: `Bei Steam angemeldet als ${account}` });
    log.info("Steam-Anmeldung erfolgreich");
    return { account };
  });

  if (!started.ok) {
    rc.page(
      409,
      rc.t("setup.step.steam"),
      frame(rc, inSetup, loginForm(rc, { account, inSetup, message: rc.t("setup.steam.busy") })),
      { nav: !inSetup },
    );
    return;
  }
  rc.redirect(`/steam/status?id=${started.job.id}`);
}

export async function status(rc) {
  const progress = await rc.app.setupProgress();
  const inSetup = !progress.completed;
  const id = rc.method === "GET" ? rc.url.searchParams.get("id") : rc.form.get("id");
  const job = (id && rc.app.jobs.get(id)) || rc.app.jobs.current();

  if (!job || (job.kind !== JOB_KIND && job.kind !== VERIFY_KIND)) {
    rc.redirect("/steam");
    return;
  }
  const verifying = job.kind === VERIFY_KIND;

  if (rc.method === "POST") {
    const answer = rc.form.get("answer") || "";
    if (!job.provide(answer)) {
      log.debug("Antwort kam, aber es stand keine Rueckfrage offen.");
    }
    rc.redirect(`/steam/status?id=${job.id}`);
    return;
  }

  const t = rc.t;
  const logBlock = `<pre class="log">${escapeHtml(job.lines.join("\n") || t("setup.steam.running"))}</pre>
    <p class="hint">${escapeHtml(t("setup.steam.logNote"))}</p>`;

  let head = "";
  let top = "";
  let actions = "";

  if (job.awaiting) {
    const label = job.awaiting.kind === "guard" ? t("setup.steam.guard") : t("setup.steam.prompt", { prompt: job.awaiting.text });
    top = notice("warn", job.awaiting.kind === "guard" ? t("setup.steam.guardHint") : label);
    actions = `
      <form method="post" action="/steam/status">
        ${csrfInput(rc.csrf)}
        <input type="hidden" name="id" value="${escapeHtml(job.id)}">
        ${field({ name: "answer", label, required: true, autocomplete: "off" })}
        <div class="actions">
          <button class="primary" type="submit">${escapeHtml(
            job.awaiting.kind === "guard" ? t("setup.steam.guardSubmit") : t("setup.steam.promptSubmit"),
          )}</button>
        </div>
      </form>`;
  } else if (job.running) {
    // Ohne JavaScript: die Seite laedt sich selbst neu, solange etwas laeuft.
    head = '<meta http-equiv="refresh" content="2">';
    top = notice("warn", t("setup.steam.running"));
  } else if (job.status === "ok") {
    top = notice(
      "ok",
      verifying
        ? t("setup.steam.verifyOk", { account: job.result?.account || "" })
        : t("setup.steam.success", { account: job.result?.account || "" }),
    );
    actions = inSetup
      ? `<div class="actions"><a class="button" href="/dzpage">${escapeHtml(t("common.next"))}</a></div>`
      : `<div class="actions"><a class="button" href="/">${escapeHtml(t("common.dashboard"))}</a></div>`;
  } else {
    top = notice(
      "error",
      verifying
        ? t("setup.steam.verifyFailed", { message: job.error || "" })
        : t("setup.steam.failed", { message: job.error || "" }),
    );
    actions = `<div class="actions"><a class="button secondary" href="/steam">${escapeHtml(
      t("setup.steam.again"),
    )}</a></div>`;
  }

  rc.page(
    200,
    t("setup.step.steam"),
    frame(rc, inSetup, `<h1>${escapeHtml(t("setup.steam.heading"))}</h1>${top}${actions}${logBlock}`),
    { head, nav: !inSetup },
  );
}
