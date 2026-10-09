import { randomBytes } from "node:crypto";
import { log } from "./log.js";

/**
 * Laufende Vorgaenge (SteamCMD-Installation, Steam-Anmeldung, spaeter
 * Server-Installation). Sie laufen im Hintergrund, waehrend die Oberflaeche
 * eine Statusseite zeigt, die sich selbst neu laedt — so bleibt die Oberflaeche
 * ohne JavaScript und trotzdem lebendig.
 *
 * Ein Vorgang kann zurueckfragen (Steam-Guard-Code). Dann wartet er, die
 * Statusseite zeigt ein Feld, und die Antwort geht ueber `provide` weiter.
 *
 * Wichtig: Eingaben des Nutzers stehen nur im Arbeitsspeicher. Was in `lines`
 * landet, ist vorher durch die Streichliste gelaufen — ein Passwort oder ein
 * Code darf nicht versehentlich im Protokoll auftauchen.
 */

const MAX_LINES = 400;
const MAX_LINE_LENGTH = 500;
const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

class Job {
  constructor(kind) {
    this.id = randomBytes(8).toString("hex");
    this.kind = kind;
    this.status = "running";
    this.lines = [];
    this.awaiting = null;
    this.error = null;
    /** Fester Code des Fehlers (err.code), falls der Vorgang einen mitgibt. */
    this.errorCode = null;
    this.result = null;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.secrets = new Set();
    this.pending = null;
    /** Loest auf, sobald der Vorgang durch ist — egal wie er ausging. */
    this.completion = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Wert von jeder Protokollausgabe fernhalten. */
  redact(secret) {
    if (typeof secret === "string" && secret.length >= 3) this.secrets.add(secret);
  }

  clean(text) {
    let out = String(text ?? "");
    for (const secret of this.secrets) out = out.replaceAll(secret, "***");
    return out.slice(0, MAX_LINE_LENGTH);
  }

  append(text) {
    for (const line of this.clean(text).split("\n")) {
      const trimmed = line.replace(/\r/g, "").trimEnd();
      if (!trimmed) continue;
      this.lines.push(trimmed);
    }
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  /** Rueckfrage an den Menschen. Loest auf, sobald `provide` aufgerufen wird. */
  ask({ kind, text }) {
    if (this.pending) throw new Error("Es steht schon eine Rueckfrage offen.");
    this.awaiting = { kind, text: this.clean(text) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.awaiting = null;
        reject(new Error("Keine Antwort erhalten."));
      }, ANSWER_TIMEOUT_MS);
      timer.unref?.();
      this.pending = { resolve, reject, timer };
    });
  }

  provide(value) {
    if (!this.pending) return false;
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    this.awaiting = null;
    resolve(String(value ?? ""));
    return true;
  }

  get running() {
    return this.status === "running";
  }
}

export function createJobs() {
  const byId = new Map();
  let current = null;

  return {
    /** Genau ein Vorgang zur Zeit — zwei SteamCMD-Laeufe wuerden sich ins Gehege kommen. */
    start(kind, run) {
      if (current?.running) return { ok: false, code: "busy", job: current };
      const job = new Job(kind);
      byId.set(job.id, job);
      if (byId.size > 8) byId.delete(byId.keys().next().value);
      current = job;

      Promise.resolve()
        .then(() => run(job))
        .then((result) => {
          job.result = result ?? null;
          job.status = "ok";
        })
        .catch((err) => {
          job.status = "failed";
          job.error = job.clean(err.message || String(err));
          job.errorCode = typeof err?.code === "string" ? err.code : null;
          log.warn(`Vorgang ${kind} fehlgeschlagen: ${job.error}`);
        })
        .finally(() => {
          job.finishedAt = Date.now();
          if (job.pending) {
            clearTimeout(job.pending.timer);
            job.pending = null;
          }
          job.awaiting = null;
          // Passwort und Code duerfen nicht laenger im Arbeitsspeicher liegen
          // als der Vorgang, der sie gebraucht hat. Fehlermeldungen sind zu
          // diesem Zeitpunkt schon durch die Streichliste gelaufen.
          job.secrets.clear();
          job.settle(job);
        });

      return { ok: true, job };
    },

    get(id) {
      return byId.get(id) || null;
    },

    current() {
      return current;
    },
  };
}
