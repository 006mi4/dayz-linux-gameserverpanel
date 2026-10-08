import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomInt, timingSafeEqual } from "node:crypto";
import { SETUP_CODE_FILE } from "../paths.js";

/**
 * Der Einrichtungscode schuetzt die beiden Schritte, die es noch ohne Konto
 * geben muss (Datenbank, Administrator). Ohne ihn gehoert das Panel dem, der
 * als Erster den Port erreicht: Er legt den Administrator an und kann sogar
 * die Datenbank auf eine eigene MySQL-Instanz umbiegen.
 *
 * Der Code liegt als Datei neben panel.json (0600, Dienstbenutzer). Wer ihn
 * lesen kann, ist auf der Maschine ohnehin root, und genau der soll das Panel
 * einrichten. Ins Protokoll kommt er nicht: dort darf nie ein Geheimnis landen.
 *
 * Zwoelf Zeichen aus 31 Buchstaben und Ziffern sind knapp 60 Bit, dazu kommt
 * die Drosselung der Versuche. Ohne die leicht verwechselbaren Zeichen
 * (0/O, 1/I/L), weil der Code von einem Terminal abgetippt wird.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 12;

export function generateSetupCode() {
  let out = "";
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Gross, ohne Trennzeichen: so darf der Code abgetippt werden, wie er kommt. */
export function normaliseSetupCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function readSetupCode(file = SETUP_CODE_FILE) {
  try {
    const code = readFileSync(file, "utf8").trim();
    return code || null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Vorhandenen Code behalten, sonst einen neuen anlegen. Gibt den Code zurueck. */
export function ensureSetupCode(file = SETUP_CODE_FILE) {
  const existing = readSetupCode(file);
  if (existing) return existing;
  const code = generateSetupCode();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${code}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return code;
}

export function clearSetupCode(file = SETUP_CODE_FILE) {
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export function matchesSetupCode(input, file = SETUP_CODE_FILE) {
  const stored = readSetupCode(file);
  if (!stored) return false;
  const a = Buffer.from(normaliseSetupCode(input));
  const b = Buffer.from(normaliseSetupCode(stored));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
