import { countUsers } from "./store/users.js";
import { getSettings, KEYS } from "./store/settings.js";
import { SetupState } from "./http/server.js";

/**
 * Der gemeinsame Zustand des laufenden Panels: Konfiguration, offene
 * Datenbank, Auftragsverwaltung, DZPage-Verbindung. Wird beim Start einmal
 * gebaut und an jede Anfrage weitergegeben.
 */

export function createApp({ config, db = null, jobs, dzpage }) {
  const app = {
    config,
    db,
    jobs,
    dzpage,
    setup: new SetupState(),
    startedAt: Date.now(),

    /** Datenbank ist eingerichtet, aber nicht offen — das ist ein Betriebsfehler, kein Assistent. */
    get databaseBroken() {
      return Boolean(config.database) && !app.db;
    },

    async setupProgress() {
      return readProgress(app);
    },
  };
  return app;
}

export async function readProgress(app) {
  if (!app.config.database || !app.db) {
    return {
      hasDatabase: false,
      hasAdmin: false,
      steamDone: false,
      steamSkipped: false,
      dzpageDone: false,
      completed: false,
      step: 1,
      next: "/setup/database",
    };
  }

  const hasAdmin = (await countUsers(app.db)) > 0;
  const settings = await getSettings(app.db, [
    KEYS.steamLoggedInAt,
    KEYS.steamSkipped,
    KEYS.dzpagePanelId,
    KEYS.setupCompletedAt,
  ]);

  const progress = {
    hasDatabase: true,
    hasAdmin,
    steamDone: settings[KEYS.steamLoggedInAt] !== null,
    steamSkipped: settings[KEYS.steamSkipped] === "1",
    dzpageDone: settings[KEYS.dzpagePanelId] !== null,
    completed: settings[KEYS.setupCompletedAt] !== null,
  };

  if (!progress.hasAdmin) {
    progress.step = 2;
    progress.next = "/setup/admin";
  } else if (!progress.steamDone && !progress.steamSkipped) {
    progress.step = 3;
    progress.next = "/steam";
  } else if (!progress.dzpageDone) {
    progress.step = 4;
    progress.next = "/dzpage";
  } else {
    progress.step = 5;
    progress.next = "/setup/done";
  }
  return progress;
}
