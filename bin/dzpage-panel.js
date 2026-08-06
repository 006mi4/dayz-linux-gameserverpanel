#!/usr/bin/env node
import { installSignalHandlers, startPanel } from "../src/main.js";
import { log } from "../src/log.js";

/**
 * Eintrittspunkt des Dienstes.
 *
 * SQLite kommt aus node:sqlite. In Node 24 ist das Modul stabil, in 22 und 23
 * braucht es --experimental-sqlite. Der Installer prueft das und schreibt die
 * Startzeile entsprechend; hier wird nur noch verstaendlich gemeldet, wenn es
 * doch fehlt.
 */

try {
  const panel = await startPanel();
  installSignalHandlers(panel);
} catch (err) {
  log.error(err.stack || err.message);
  process.exitCode = 1;
}
