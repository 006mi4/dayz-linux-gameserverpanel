import { deleteSetting, getSetting, KEYS, setSetting } from "../store/settings.js";
import { recordEvent } from "../store/events.js";

/**
 * Ob DZPage den gespeicherten Panel-Schluessel noch annimmt. Herzschlag und
 * Abholer halten an, wenn DZPage ihn mit 401/403 und JSON ablehnt (eine
 * Sperrseite davor zaehlt nicht, siehe client.js); damit "dzpage-panel status"
 * und "link" das auch ohne laufenden Dienst wissen, steht die Ablehnung in der
 * Datenbank.
 * Sie verschwindet, sobald ein Schluessel wieder angenommen wird.
 */

export const REJECTED_CODES = new Set(["revoked", "invalid_key"]);

export function isRejection(code) {
  return REJECTED_CODES.has(code);
}

/** Vermerkt die Ablehnung; der Zeitpunkt bleibt der erste, das Ereignis steht nur einmal im Protokoll. */
export async function markKeyRejected(db, code, { source = "dzpage" } = {}) {
  const already = await getSetting(db, KEYS.dzpageKeyRejected);
  await setSetting(db, KEYS.dzpageKeyRejected, code);
  if (already) return;
  await setSetting(db, KEYS.dzpageKeyRejectedAt, Date.now());
  await recordEvent(db, {
    kind: "dzpage.key",
    source,
    message: `Panel-Schlüssel abgelehnt (${code})`,
  });
}

export async function clearKeyRejected(db) {
  if ((await getSetting(db, KEYS.dzpageKeyRejected)) === null) return;
  await deleteSetting(db, KEYS.dzpageKeyRejected);
  await deleteSetting(db, KEYS.dzpageKeyRejectedAt);
}

export async function readKeyRejection(db) {
  const code = await getSetting(db, KEYS.dzpageKeyRejected);
  if (!code) return null;
  const at = Number(await getSetting(db, KEYS.dzpageKeyRejectedAt));
  return { code, at: Number.isFinite(at) && at > 0 ? at : null };
}
