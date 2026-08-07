/**
 * Steams Schluessel-Wert-Format (VDF/KeyValues) lesen.
 *
 * Zwei Dateien des Panels sprechen es: die Ausgabe von `app_info_print` und die
 * `appmanifest_<app>.acf` neben den Spieldateien. Beide sind derselbe Aufbau —
 * Zeichenkette in Anfuehrungszeichen, danach entweder ein Wert oder ein Block
 * in geschweiften Klammern.
 *
 * Warum ein Leser und kein Muster: Die Build-Nummer steht bei SteamCMD vier
 * Ebenen tief (`depots` > `branches` > `public` > `buildid`), und dieselbe
 * Zeile `"buildid"` kommt im selben Text mehrfach vor — einmal je Zweig. Ein
 * Muster wuerde je nach Reihenfolge der Zweige mal den oeffentlichen und mal
 * den experimentellen Stand liefern.
 *
 * Der Leser ist bewusst nachsichtig: Alles, was kein Anfuehrungszeichen und
 * keine Klammer ist, wird uebersprungen. Damit stoert der Vorspann von SteamCMD
 * nicht ("Loading Steam API...OK" und ein paar Zeilen mehr).
 */

/** Sicherheitsnetz gegen entartete Eingaben; echte Ausgaben liegen bei ~5 kB. */
const MAX_TOKENS = 200_000;

function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length && tokens.length < MAX_TOKENS) {
    const char = text[index];
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: "text", value });
      continue;
    }
    if (char === "{" || char === "}") {
      tokens.push({ kind: char });
    }
    index += 1;
  }
  return tokens;
}

/** Liest einen Block ab `tokens[start]`, das eine oeffnende Klammer sein muss. */
function readObject(tokens, start) {
  const out = {};
  let index = start + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "}") return { value: out, next: index + 1 };
    if (token.kind !== "text") {
      index += 1;
      continue;
    }
    const next = tokens[index + 1];
    if (!next) break;
    if (next.kind === "{") {
      const nested = readObject(tokens, index + 1);
      out[token.value] = nested.value;
      index = nested.next;
      continue;
    }
    if (next.kind === "text") {
      out[token.value] = next.value;
      index += 2;
      continue;
    }
    index += 1;
  }
  return { value: out, next: index };
}

/**
 * Den Block hinter einem Schluessel der obersten Ebene lesen — `"223350"` bei
 * SteamCMD, `"AppState"` in der appmanifest-Datei. Gibt null zurueck, wenn der
 * Schluessel fehlt oder kein Block folgt.
 */
export function readVdfBlock(text, key) {
  const tokens = tokenize(String(text ?? ""));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].kind !== "text" || tokens[index].value !== key) continue;
    if (tokens[index + 1].kind !== "{") continue;
    return readObject(tokens, index + 1).value;
  }
  return null;
}

/** Verschachtelten Wert holen, ohne bei jedem Schritt auf null zu pruefen. */
export function pick(object, ...path) {
  let current = object;
  for (const step of path) {
    if (!current || typeof current !== "object") return null;
    current = current[step];
  }
  return current === undefined ? null : current;
}
