/**
 * Drosselung der Anmeldeversuche. Im Arbeitsspeicher, weil ein Panel einen
 * einzigen Prozess hat und ein Neustart die Zaehler ohnehin loeschen darf —
 * wer den Dienst neu starten kann, ist schon drin.
 */

const DEFAULTS = { max: 8, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };

export function createThrottle(options = {}) {
  const { max, windowMs, lockMs } = { ...DEFAULTS, ...options };
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.lockedUntil > now) continue;
      if (now - entry.last > windowMs) entries.delete(key);
    }
  }

  return {
    /** Gibt zurueck, ob gerade gesperrt ist — und fuer wie lange noch. */
    check(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return { locked: false, retryAfterMs: 0 };
      if (entry.lockedUntil > now) return { locked: true, retryAfterMs: entry.lockedUntil - now };
      return { locked: false, retryAfterMs: 0 };
    },

    fail(key, now = Date.now()) {
      prune(now);
      const entry = entries.get(key) || { count: 0, last: now, lockedUntil: 0 };
      if (now - entry.last > windowMs) entry.count = 0;
      entry.count += 1;
      entry.last = now;
      if (entry.count >= max) {
        entry.lockedUntil = now + lockMs;
        entry.count = 0;
      }
      entries.set(key, entry);
      return this.check(key, now);
    },

    reset(key) {
      entries.delete(key);
    },

    get size() {
      return entries.size;
    },
  };
}
