import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

/**
 * Pseudo-Konsole ohne native Abhaengigkeit.
 *
 * SteamCMD fragt Passwort und Steam-Guard-Code interaktiv ab und akzeptiert sie
 * nicht als Argument. Es braucht also ein Terminal. Node bringt keines mit, und
 * node-pty waere eine native Abhaengigkeit — genau das, was dieses Projekt
 * vermeidet.
 *
 * Loesung: script(1) aus util-linux. Es haengt das Programm an ein
 * frisch angelegtes Terminal und leitet die eigene Standardeingabe dorthin
 * weiter. Auf jedem Debian und Ubuntu ist es Teil des Grundsystems.
 *
 * Zwei Feinheiten, die sonst zu schwer findbaren Fehlern fuehren:
 * - `script -c` fuehrt den Befehl ueber $SHELL aus. Bei einem Kunden mit fish
 *   oder csh gelten andere Zitierregeln — deshalb setzen wir SHELL fest auf
 *   /bin/sh.
 * - Das Terminal spiegelt Eingaben zurueck. Passwoerter tut es nicht, weil
 *   SteamCMD die Anzeige vorher abschaltet, aber verlassen darf man sich darauf
 *   nicht: was hier geschrieben wird, landet nie im Protokoll, und der Wert
 *   steht zusaetzlich auf der Streichliste des Vorgangs.
 */

const SCRIPT_BINARY = "/usr/bin/script";
const SAFE_ARGUMENT = /^[A-Za-z0-9@%+=:,./_-]+$/;

/**
 * SteamCMD faerbt seine Ausgabe. Am echten Client steht hinter jeder
 * Eingabeaufforderung eine Rueckstellsequenz — "password: \x1b[0m" — und ein
 * Muster, das auf das Zeilenende zielt, trifft dann nie. Deshalb werden die
 * Steuerzeichen entfernt, bevor irgendjemand den Text zu sehen bekommt.
 */
const ANSI = /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[=>]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, "");
}

export function isPtyAvailable() {
  try {
    accessSync(SCRIPT_BINARY, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ein Argument fuer die Kommandozeile von /bin/sh einpacken. Nur bekannte
 * Zeichen sind erlaubt; alles andere weisen wir ab, statt es zu zitieren —
 * "kein Pfad aus der Oberflaeche in eine Kommandozeile" gilt hier wortwoertlich.
 */
export function quoteArgument(value) {
  const text = String(value);
  if (!SAFE_ARGUMENT.test(text)) {
    throw new Error(`Argument enthaelt unerlaubte Zeichen: ${JSON.stringify(text)}`);
  }
  return `'${text}'`;
}

export function buildCommandLine(command, args = []) {
  return [command, ...args].map(quoteArgument).join(" ");
}

/** Ein Terminal mit dem Programm darin. */
export function spawnPty({ command, args = [], env = {}, cwd, onData }) {
  if (!isPtyAvailable()) {
    throw new Error(
      "script(1) aus util-linux fehlt — ohne Terminal kann SteamCMD nicht nach dem Passwort fragen. " +
        "Auf Debian/Ubuntu: apt-get install util-linux",
    );
  }

  const commandLine = buildCommandLine(command, args);
  const child = spawn(SCRIPT_BINARY, ["-q", "-f", "-e", "-c", commandLine, "/dev/null"], {
    cwd,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      SHELL: "/bin/sh",
      TERM: "dumb",
      LANG: "C",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session = {
    child,
    buffer: "",
    closed: false,
    exit: null,
    waiters: [],
  };

  const consume = (chunk) => {
    const text = stripAnsi(chunk.toString("utf8"));
    session.buffer = (session.buffer + text).slice(-8192);
    onData?.(text);
    checkWaiters(session);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  session.exited = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      session.closed = true;
      session.exit = { code, signal };
      checkWaiters(session);
      resolve(session.exit);
    });
  });
  child.on("error", (err) => {
    session.closed = true;
    session.exit = { code: null, signal: null, error: err };
    checkWaiters(session);
  });

  return {
    exited: session.exited,

    /** Antwort ins Terminal schreiben. Wird nie protokolliert. */
    write(text) {
      if (!session.closed) child.stdin.write(`${text}\n`);
    },

    /**
     * Warten, bis eine der Muster im Ausgabepuffer auftaucht.
     * Gibt {name} des Treffers zurueck, oder {name:"exit"} wenn das Programm
     * vorher endet, oder wirft bei Zeitueberschreitung.
     */
    waitFor(patterns, { timeoutMs = 120_000 } = {}) {
      return new Promise((resolve, reject) => {
        const waiter = { patterns, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = session.waiters.indexOf(waiter);
          if (index >= 0) session.waiters.splice(index, 1);
          reject(new Error("SteamCMD hat nicht rechtzeitig geantwortet."));
        }, timeoutMs);
        waiter.timer.unref?.();
        session.waiters.push(waiter);
        checkWaiters(session);
      });
    },

    /** Puffer leeren, damit ein alter Treffer nicht sofort wieder zaehlt. */
    clear() {
      session.buffer = "";
    },

    get output() {
      return session.buffer;
    },

    kill() {
      if (!session.closed) child.kill("SIGTERM");
    },
  };
}

function checkWaiters(session) {
  for (const waiter of [...session.waiters]) {
    let hit = null;
    for (const [name, pattern] of Object.entries(waiter.patterns)) {
      if (pattern.test(session.buffer)) {
        hit = name;
        break;
      }
    }
    if (!hit && session.closed) hit = "exit";
    if (!hit) continue;

    clearTimeout(waiter.timer);
    session.waiters.splice(session.waiters.indexOf(waiter), 1);
    waiter.resolve({ name: hit, output: session.buffer, exit: session.exit });
  }
}
