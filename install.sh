#!/usr/bin/env bash
#
# Installiert das DZPage Panel als systemd-Dienst.
#
#   sudo ./install.sh                     Installation oder Aktualisierung
#   sudo ./install.sh --pair <code>       mit dem Kopplungscode von dzpage.com verbinden
#   sudo ./install.sh --no-link           am Ende nicht mit DZPage verbinden
#   sudo ./install.sh --domain <name>     lokale Oberflaeche ueber HTTPS (Caddy, Let's Encrypt)
#   sudo ./install.sh --no-steam-deps     ohne 32-Bit-Bibliotheken fuer SteamCMD
#   sudo ./install.sh --no-node           keine eigene Node-Laufzeit installieren
#   sudo ./install.sh --with-docker       Docker-Laufzeit freischalten (siehe README)
#
# Das Skript ist mehrfach ausfuehrbar: ein zweiter Lauf aktualisiert die
# Dateien und startet den Dienst neu, ohne Konfiguration oder Daten anzufassen.
set -euo pipefail

APP_DIR=/usr/lib/dzpage-panel
CONFIG_DIR=/etc/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
SERVICE_USER=dzpage
UNIT=/etc/systemd/system/dzpage-panel.service
CLI=/usr/local/sbin/dzpage-panel
NODE_MAJOR_MIN=22
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)

WITH_STEAM_DEPS=1
WITH_NODE_INSTALL=1
WITH_DOCKER=0
DOMAIN=""
PAIR_TOKEN=""
LINK=1
# Was die Selbstaktualisierung bei jeder neuen Fassung wieder mitgibt. Domain
# und Kopplungscode gehoeren nicht dazu: HTTPS wird einmal eingerichtet und
# bleibt, und ein Kopplungscode gilt genau einmal.
PERSIST_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-steam-deps) WITH_STEAM_DEPS=0; PERSIST_ARGS+=("$1") ;;
    --no-node) WITH_NODE_INSTALL=0; PERSIST_ARGS+=("$1") ;;
    --with-docker) WITH_DOCKER=1; PERSIST_ARGS+=("$1") ;;
    --domain) [ "$#" -ge 2 ] || { echo "--domain braucht einen Namen" >&2; exit 2; }; DOMAIN=$2; shift ;;
    --domain=*) DOMAIN=${1#--domain=} ;;
    --pair) [ "$#" -ge 2 ] || { echo "--pair braucht den Code von dzpage.com" >&2; exit 2; }; PAIR_TOKEN=$2; shift ;;
    --pair=*) PAIR_TOKEN=${1#--pair=} ;;
    --no-link) LINK=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33mAchtung:\033[0m %s\n' "$*"; }
die() { printf '\n\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

# Ein Befehl als Dienstbenutzer. Fuer Lesezugriffe in seinen Verzeichnissen:
# Dort kann er Eintraege gegen Verweise tauschen, und als er selbst erreicht
# ein Verweis nichts, was er nicht ohnehin lesen darf.
as_service() { setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --clear-groups -- "$@"; }

# Schreibt stdin als Datei, die root gehoert, in ein Verzeichnis des Dienstes.
# Warum ueber /etc und "mv -T", steht bei install.json.
replace_root_file() {
  local dest=$1 tmp
  tmp=$(mktemp "$(dirname "$CONFIG_DIR")/.dzpage-panel-$(basename "$dest").XXXXXX") \
    || die "$dest liess sich nicht schreiben (keine Nebendatei in $(dirname "$CONFIG_DIR"))."
  if cat > "$tmp" && chmod 0644 "$tmp" && mv -fT "$tmp" "$dest"; then
    return 0
  fi
  rm -f "$tmp"
  die "$dest liess sich nicht schreiben."
}

[ "$(id -u)" -eq 0 ] || die "Bitte mit sudo ausfuehren."
[ -d /run/systemd/system ] || die "Dieses System benutzt kein systemd."
[ -f "$SOURCE_DIR/bin/dzpage-panel.js" ] || die "install.sh muss im entpackten Panel-Verzeichnis liegen."

# Erstinstallation oder Aktualisierung? Nur bei der ersten wird gefragt.
FIRST_INSTALL=1
[ -f "$CONFIG_DIR/install.json" ] && FIRST_INSTALL=0

# ---------------------------------------------------------------- Vorpruefung
say "Vorpruefung"
# DayZServer und SteamCMD gibt es nur fuer x86_64. Auf einem ARM-Rechner
# liefe das Panel, koennte aber keinen einzigen Server starten.
#
# Nur bei der Erstinstallation ein Abbruch. Bei einer Aktualisierung lief das
# Panel hier schon, und ein Abbruch liesse die Selbstaktualisierung alle paar
# Minuten scheitern und zuruecknehmen, ohne Ende.
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
  if [ "$FIRST_INSTALL" -eq 1 ]; then
    die "Diese Maschine ist $ARCH. Den DayZ-Server und SteamCMD gibt es nur fuer x86_64 (amd64)."
  fi
  warn "Diese Maschine ist $ARCH. Spielserver laufen hier nicht; das Panel wird trotzdem aktualisiert."
else
  note "Architektur $ARCH"
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID=$(. /etc/os-release && echo "${ID:-}")
  OS_VERSION=$(. /etc/os-release && echo "${VERSION_ID:-}")
  OS_NAME=$(. /etc/os-release && echo "${PRETTY_NAME:-$OS_ID $OS_VERSION}")
  # Ehrlich bleiben: Von Anfang bis Ende durchgetestet sind Ubuntu 22.04 und
  # 24.04 und Debian 12 und 13, die beiden Debian auch als minimales System
  # ohne sudo, git und xz. Alles andere ist ungeprueft.
  case "$OS_ID:$OS_VERSION" in
    ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) note "$OS_NAME" ;;
    *) warn "$OS_NAME ist ungeprueft. Geprueft sind Ubuntu 22.04 und 24.04 und Debian 12 und 13; weiter auf eigene Verantwortung." ;;
  esac
fi

MEM_MB=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -lt 3500 ]; then
  warn "Nur ${MEM_MB} MB Arbeitsspeicher. Ein DayZ-Server braucht im Betrieb 3 bis 6 GB."
else
  note "${MEM_MB} MB Arbeitsspeicher"
fi
mkdir -p "$(dirname "$DATA_DIR")"
FREE_GB=$(df -Pk "$(dirname "$DATA_DIR")" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}')
if [ "${FREE_GB:-0}" -lt 12 ]; then
  warn "Nur ${FREE_GB:-0} GB frei unter $(dirname "$DATA_DIR"). Ein DayZ-Server braucht etwa 6 GB, mit Mods deutlich mehr."
else
  note "${FREE_GB} GB frei unter $(dirname "$DATA_DIR")"
fi

case "$PAIR_TOKEN" in
  ""|dzp_pair_*) ;;
  *) die "Der Kopplungscode beginnt mit dzp_pair_. Auf dzpage.com unter RCon einen neuen Befehl holen." ;;
esac

# Aus einem Git-Arbeitsverzeichnis installiert? Dann kann sich das Panel spaeter
# selbst aktualisieren — und nur dann. Wer die Dateien von Hand kopiert hat,
# bekommt kein Programm, das ihm ungefragt darin herumschreibt.
SOURCE_IS_GIT=0
[ -d "$SOURCE_DIR/.git" ] && SOURCE_IS_GIT=1

# ---------------------------------------------------------------- Pakete
if command -v apt-get >/dev/null 2>&1; then
  say "Systempakete pruefen"
  export DEBIAN_FRONTEND=noninteractive
  MISSING=""
  # util-linux liefert script(1) — ohne Terminal kann SteamCMD nicht nach dem
  # Passwort fragen. tar und ca-certificates braucht die Installation selbst.
  for pkg in util-linux tar ca-certificates curl; do
    dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
  done
  # Node kommt als .tar.xz. Ein minimales Debian 12 hat kein xz, und tar
  # scheitert dann erst beim Entpacken ("xz: Cannot exec").
  if [ "$WITH_NODE_INSTALL" -eq 1 ]; then
    dpkg -s xz-utils >/dev/null 2>&1 || MISSING="$MISSING xz-utils"
  fi
  # git nur, wenn es auch gebraucht wird: es ist der Kanal fuer Aktualisierungen.
  if [ "$SOURCE_IS_GIT" -eq 1 ]; then
    dpkg -s git >/dev/null 2>&1 || MISSING="$MISSING git"
  fi
  if [ "$WITH_STEAM_DEPS" -eq 1 ]; then
    # SteamCMD ist 32-Bit, auch auf 64-Bit-Systemen.
    dpkg --print-foreign-architectures | grep -qx i386 || {
      note "i386-Architektur fuer SteamCMD ergaenzen"
      dpkg --add-architecture i386
      apt-get update -qq
    }
    dpkg -s lib32gcc-s1 >/dev/null 2>&1 || MISSING="$MISSING lib32gcc-s1"
  fi
  if [ -n "$MISSING" ]; then
    note "installiere:$MISSING"
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y -qq $MISSING
  else
    note "alles vorhanden"
  fi
else
  say "Kein apt gefunden — bitte selbst sicherstellen"
  note "util-linux (script), tar, xz, ca-certificates und die 32-Bit-Bibliothek"
  note "libgcc (i386) fuer SteamCMD muessen vorhanden sein."
fi

# ---------------------------------------------------------------- Node
say "Node-Laufzeit"
NODE_BIN=""
for candidate in "$APP_DIR/node/bin/node" "$(command -v node || true)" /usr/bin/node /usr/local/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge "$NODE_MAJOR_MIN" ]; then
    NODE_BIN=$candidate
    break
  fi
done

if [ -z "$NODE_BIN" ] && [ "$WITH_NODE_INSTALL" -eq 1 ]; then
  note "Kein Node $NODE_MAJOR_MIN+ gefunden — installiere eine eigene Laufzeit nach $APP_DIR/node"
  TMP=$(mktemp -d)
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) NODE_ARCH=linux-x64 ;;
    aarch64|arm64) NODE_ARCH=linux-arm64 ;;
    *) die "Nicht unterstuetzte Architektur: $ARCH — bitte Node $NODE_MAJOR_MIN+ selbst installieren." ;;
  esac
  # Jeder Schritt mit eigenem "|| exit 1": Links von "|| die" schaltet bash
  # "set -e" auch innerhalb der Unterschale ab. Bis 0.4.0 lief deshalb eine
  # falsche Pruefsumme einfach durch, und tar entpackte trotzdem.
  ( cd "$TMP" || exit 1
    curl -fsSL -O "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" || exit 1
    FILE=$(grep "$NODE_ARCH.tar.xz" SHASUMS256.txt | awk '{print $2}' | head -1)
    [ -n "$FILE" ] || exit 1
    curl -fsSL -O "https://nodejs.org/dist/latest-v24.x/$FILE" || exit 1
    # Nur herunterladen reicht nicht: die Pruefsumme kommt von derselben Quelle,
    # deckt aber einen abgebrochenen oder verfaelschten Transport ab.
    sha256sum -c --ignore-missing --quiet SHASUMS256.txt || exit 1
    mkdir -p "$APP_DIR/node" || exit 1
    tar -xJf "$FILE" -C "$APP_DIR/node" --strip-components=1 || exit 1
  ) || { rm -rf "$TMP"; die "Node konnte nicht installiert werden."; }
  rm -rf "$TMP"
  note "Pruefsumme stimmt (SHASUMS256.txt von nodejs.org)"
  NODE_BIN="$APP_DIR/node/bin/node"
fi

[ -n "$NODE_BIN" ] || die "Node $NODE_MAJOR_MIN oder neuer wird gebraucht (oder ohne --no-node erneut versuchen)."
note "$NODE_BIN ($("$NODE_BIN" --version))"

# node:sqlite ist erst ab Node 24 stabil; davor braucht es einen Schalter.
# Statt die Version zu raten, wird beides ausprobiert.
NODE_FLAGS=""
if ! "$NODE_BIN" -e 'require("node:sqlite")' >/dev/null 2>&1; then
  if "$NODE_BIN" --experimental-sqlite -e 'require("node:sqlite")' >/dev/null 2>&1; then
    NODE_FLAGS="--experimental-sqlite"
    note "node:sqlite braucht hier $NODE_FLAGS"
  else
    die "Diese Node-Version kann node:sqlite nicht — bitte Node 24 oder neuer verwenden."
  fi
fi

# ---------------------------------------------------------------- Benutzer und Verzeichnisse
if [ "$WITH_DOCKER" -eq 1 ]; then
  say "Docker-Laufzeit"
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker ist nicht installiert — erst Docker einrichten, dann erneut mit --with-docker."
  fi
  # Ehrlich bleiben: Wer in der docker-Gruppe ist, kann auf dieser Maschine
  # alles. Das liegt an Docker, nicht am Panel — aber wissen sollte man es.
  note "ACHTUNG: Der Dienstbenutzer kommt in die Gruppe docker."
  note "Das entspricht auf dieser Maschine faktisch Rootrechten — so ist Docker gebaut."
fi

say "Dienstbenutzer und Verzeichnisse"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  note "Benutzer $SERVICE_USER angelegt"
fi
if [ "$WITH_DOCKER" -eq 1 ]; then
  usermod -aG docker "$SERVICE_USER"
  note "$SERVICE_USER ist jetzt in der Gruppe docker"
fi

# Das Konfigurationsverzeichnis gehoert dem Dienst, nicht root: das Panel legt
# panel.json atomar an (Nebendatei, dann umbenennen) und braucht dafuer
# Schreibrecht im Verzeichnis selbst. Die Datei bleibt 0600.
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_DIR"
#
# Dasselbe fuer die beiden Dateien, die das Panel dort selbst schreibt. Wer
# panel.json vor der Installation von Hand anlegt (Port setzen) oder eine
# Sicherung mit "sudo mv" zurueckspielt, hat eine Datei, die root gehoert. Mit
# 0600 kann der Dienst sie nicht lesen, startet nicht, und unten heisst es nur
# "nicht hochgekommen". install.json gehoert dagegen absichtlich root.
#
# Node statt chown und chmod: Diese Zeilen laufen auch bei jeder
# Selbstaktualisierung als root, waehrend das Panel noch laeuft, und das
# Verzeichnis gehoert dem Dienstbenutzer. Ein uebernommenes Panel koennte die
# Datei gegen einen Verweis auf /etc/passwd tauschen; chmod folgt Verweisen,
# auch noch zwischen Pruefung und Aufruf. Ein einziger Deskriptor mit
# O_NOFOLLOW schliesst das aus, der Linkzaehler einen harten Link. O_NONBLOCK,
# damit eine untergeschobene FIFO das Oeffnen nicht ewig blockiert.
for name in panel.json setup-code; do
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const [file, uid, gid] = process.argv.slice(1);
    let fd;
    try {
      fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      process.exit(err.code === "ENOENT" ? 0 : 1);
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) process.exit(1);
    fs.fchownSync(fd, Number(uid), Number(gid));
    fs.fchmodSync(fd, 0o600);
  ' "$CONFIG_DIR/$name" "$(id -u "$SERVICE_USER")" "$(id -g "$SERVICE_USER")" \
    || warn "$CONFIG_DIR/$name bleibt, wie sie ist (Verweis, harter Link oder keine gewoehnliche Datei). Der Dienst braucht dort eine Datei, die ihm gehoert, mit 0600."
done
#
# 0751 und nicht 0750: Jeder Spielserver laeuft unter einem eigenen Benutzer und
# muss durch diese beiden Verzeichnisse hindurch in sein eigenes kommen —
# durchgehen darf er, hineinsehen nicht. Genau das setzt auch der Helfer beim
# Anlegen eines Servers.
#
# Das steht hier, weil install.sh laengst nicht mehr nur einmal laeuft: Seit der
# Selbstaktualisierung laeuft er bei jeder neuen Panel-Fassung. Ein 0750 an
# dieser Stelle nimmt jedem vorhandenen Spielserver den Weg in sein Verzeichnis,
# und er scheitert beim naechsten Start mit "200/CHDIR" — einmal live erlebt.
install -d -m 0751 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
#
# Anders als $CONFIG_DIR und $DATA_DIR liegt servers in einem Verzeichnis des
# Dienstes, und "install -d -o" folgt einem Verweis: Ein uebernommenes Panel
# koennte servers gegen einen Verweis auf /etc/systemd/system tauschen und
# bekaeme das Ziel bei der naechsten Selbstaktualisierung geschenkt. Deshalb
# derselbe Weg wie oben bei panel.json: anlegen, mit O_NOFOLLOW oeffnen,
# Besitzer und Rechte ueber den Deskriptor.
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
  const [dir, uid, gid] = process.argv.slice(1);
  try {
    fs.mkdirSync(dir, 0o751);
  } catch (err) {
    if (err.code !== "EEXIST") process.exit(1);
  }
  let fd;
  try {
    fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    process.exit(1);
  }
  fs.fchownSync(fd, Number(uid), Number(gid));
  fs.fchmodSync(fd, 0o751);
' "$DATA_DIR/servers" "$(id -u "$SERVICE_USER")" "$(id -g "$SERVICE_USER")" \
  || warn "$DATA_DIR/servers bleibt, wie es ist (Verweis oder kein Verzeichnis). Der Dienst braucht dort ein Verzeichnis, das ihm gehoert, mit 0751."
note "$CONFIG_DIR und $DATA_DIR bereit"

# ---------------------------------------------------------------- Dateien
say "Programmdateien nach $APP_DIR"
install -d -m 0755 "$APP_DIR"
for item in bin src public package.json systemd; do
  rm -rf "${APP_DIR:?}/$item"
  cp -a "$SOURCE_DIR/$item" "$APP_DIR/$item"
done
chown -R root:root "$APP_DIR/bin" "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/package.json"
note "$(du -sh "$APP_DIR" | cut -f1) installiert"

# Das Hilfsprogramm gehoert root und darf vom Dienstbenutzer nicht veraenderbar
# sein: Es laeuft als root, wer es aendern koennte, waere root.
install -m 0755 -o root -g root "$SOURCE_DIR/helper/dzpage-panel-helper.sh" "$APP_DIR/helper.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/launch-server.sh" "$APP_DIR/launch-server.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/https.sh" "$APP_DIR/https.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/uninstall.sh" "$APP_DIR/uninstall.sh"
for unit in dzpage-server@.service dzpage-panel-helper.socket dzpage-panel-helper@.service; do
  install -m 0644 -o root -g root "$SOURCE_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done

# ---------------------------------------------------------------- Herkunft
say "Herkunft und Selbstaktualisierung"
INSTALL_METHOD=manual
CHECKOUT=""
REPOSITORY=""
if [ "$SOURCE_IS_GIT" -eq 1 ] && command -v git >/dev/null 2>&1; then
  # Gehoert das Arbeitsverzeichnis einem anderen Benutzer, verweigert Git seit
  # 2.35 als root die Arbeit ("dubious ownership"). Das trifft jeden, der als
  # normaler Benutzer klont und dann mit sudo installiert.
  #
  # --system und nicht --global: Die Aktualisierung laeuft spaeter als eigener
  # systemd-Dienst, und der hat kein HOME — "git config --global" bricht dort
  # mit "fatal: $HOME not set" ab. /etc/gitconfig braucht keins.
  git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$SOURCE_DIR" \
    || git config --system --add safe.directory "$SOURCE_DIR"
  INSTALL_METHOD=git
  CHECKOUT=$SOURCE_DIR
  REPOSITORY=$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)
fi

if [ "$INSTALL_METHOD" = "git" ]; then
  # Die beiden Platzhalter stehen erst hier fest: welches Arbeitsverzeichnis
  # gemeint ist und mit welchen Optionen die naechste Fassung ausgerollt wird.
  # Ohne die Optionen wuerde eine Aktualisierung Dinge tun, die bei der
  # Erstinstallation ausdruecklich abgewaehlt waren.
  # In der Ersetzung von sed sind \, & und das Trennzeichen besonders — ein Pfad
  # mit einem davon wuerde sonst still etwas anderes ergeben.
  sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
  sed -e "s|@CHECKOUT@|$(sed_escape "$CHECKOUT")|" \
      -e "s|@INSTALL_ARGS@|$(sed_escape "${PERSIST_ARGS[*]:-}")|" \
    "$SOURCE_DIR/helper/self-update.sh" > "$APP_DIR/self-update.sh"
  chown root:root "$APP_DIR/self-update.sh"
  chmod 0755 "$APP_DIR/self-update.sh"
  note "Aktualisierung ueber $REPOSITORY"
else
  rm -f "$APP_DIR/self-update.sh"
  note "Von Hand installiert — das Panel meldet Aktualisierungen, spielt sie aber nicht ein."
fi

ARGS_JSON=""
for arg in ${PERSIST_ARGS[@]+"${PERSIST_ARGS[@]}"}; do
  ARGS_JSON="${ARGS_JSON:+$ARGS_JSON, }\"$arg\""
done
# Gehoert root: Das Panel liest die Datei, aendern darf es sie nicht.
#
# Nicht "cat >" und chmod auf den Namen: $CONFIG_DIR gehoert dem Dienst, und
# beide folgten einem Verweis, den ein uebernommenes Panel dort hinlegt (die
# Zieldatei waere danach JSON). Die Nebendatei entsteht deshalb in /etc, wo der
# Dienst nichts anfassen kann, und "mv -T" ist auf demselben Dateisystem ein
# rename: Es ersetzt den Eintrag selbst, folgt keinem Verweis, und -T laesst
# einen Verweis auf ein Verzeichnis die Datei nicht dort hineinschieben.
replace_root_file "$CONFIG_DIR/install.json" <<EOF
{
  "method": "$INSTALL_METHOD",
  "checkout": "$CHECKOUT",
  "repository": "$REPOSITORY",
  "args": [$ARGS_JSON],
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Der Befehl "dzpage-panel" fuer die Kommandozeile. Er braucht dieselbe
# Node-Laufzeit wie der Dienst, fuer "reset-password".
sed_escape_cli() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
install -d -m 0755 "$(dirname "$CLI")"
sed -e "s|@NODE@|$(sed_escape_cli "$NODE_BIN")|" \
    -e "s|@NODE_FLAGS@|$(sed_escape_cli "$NODE_FLAGS")|" \
  "$SOURCE_DIR/helper/dzpage-panel-cli.sh" > "$CLI.new"
chown root:root "$CLI.new"
chmod 0755 "$CLI.new"
mv "$CLI.new" "$CLI"
note "Befehl $CLI (sudo dzpage-panel help)"

say "Privilegierter Helfer"
# Kein sudo: Die Unit des Panels ist gehaertet, und Optionen wie PrivateDevices
# setzen implizit NoNewPrivileges — sudo koennte dann gar nichts mehr erhoehen.
# Stattdessen ein Socket, den nur der Dienstbenutzer oeffnen darf; systemd
# startet den Helfer je Anfrage als root.
rm -f /etc/sudoers.d/dzpage-panel
systemctl daemon-reload
systemctl enable --quiet dzpage-panel-helper.socket
systemctl restart dzpage-panel-helper.socket
note "Socket: $(systemctl is-active dzpage-panel-helper.socket) (/run/dzpage-panel-helper.sock)"

# ---------------------------------------------------------------- Dienst
say "systemd-Dienst"
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $NODE_FLAGS $APP_DIR/bin/dzpage-panel.js|" \
  "$SOURCE_DIR/systemd/dzpage-panel.service" > "$UNIT"
chmod 0644 "$UNIT"
systemd-analyze verify "$UNIT" || die "Die Unit-Datei ist fehlerhaft."
systemctl daemon-reload
systemctl enable --quiet dzpage-panel
systemctl restart dzpage-panel

# Nur der Port der obersten Ebene (siehe panel_port in https.sh): Bei MySQL
# steht unter "database" ein zweiter, und mit beiden Zahlen in der Adresse
# scheiterte die Pruefung auf /health und damit jede Selbstaktualisierung.
PORT=$(sed -n 's/^  "port": *\([0-9][0-9]*\).*/\1/p' "$CONFIG_DIR/panel.json" 2>/dev/null | head -1 || true)
PORT=${PORT:-8410}
for _ in $(seq 1 40); do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
done

if [ "${READY:-0}" != "1" ]; then
  systemctl status dzpage-panel --no-pager --lines=20 || true
  die "Der Dienst ist nicht hochgekommen. Protokoll: journalctl -u dzpage-panel -e"
fi

# ---------------------------------------------------------------- HTTPS
# Scheitert nur dieser Teil, ist das Panel trotzdem installiert. Deshalb kein
# Abbruch, sondern ein Hinweis, wie es spaeter nachzuholen ist.
if [ -n "$DOMAIN" ]; then
  if ! "$APP_DIR/https.sh" enable "$DOMAIN"; then
    warn "HTTPS liess sich nicht einrichten (siehe oben). Spaeter nachholen: sudo dzpage-panel https enable $DOMAIN"
  fi
fi

# ---------------------------------------------------------------- Lokale Oberflaeche
# Verwaltet wird ueber dzpage.com. Die lokale Oberflaeche ist der Notzugang,
# deshalb steht sie hier kurz und vor der Kopplung, die den Abschluss bildet.
say "Lokale Oberflaeche (optional)"
# Als Dienstbenutzer gelesen: Bei der Selbstaktualisierung geht diese Ausgabe
# in self-update.log, und root braechte ueber einen Verweis anstelle der Datei
# den Anfang jeder Datei dorthin, die nur root lesen darf. timeout, weil eine
# FIFO an dieser Stelle das Lesen sonst ewig blockiert.
HTTPS_DOMAIN=$(as_service timeout 5 head -c 256 "$CONFIG_DIR/https-domain" 2>/dev/null | head -n 1 || true)
if [ -n "$HTTPS_DOMAIN" ]; then
  note "https://$HTTPS_DOMAIN"
else
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  note "http://127.0.0.1:$PORT, vom eigenen Rechner aus ueber einen SSH-Tunnel:"
  note "    ssh -L $PORT:127.0.0.1:$PORT ${SUDO_USER:-root}@${HOST_IP:-<diese-maschine>}"
  note "Mit eigener Domain und HTTPS: sudo dzpage-panel https enable panel.example.com"
fi
if [ -s "$CONFIG_DIR/setup-code" ]; then
  # Nur auf ein Terminal: Bei der Selbstaktualisierung geht diese Ausgabe in
  # eine Protokolldatei, und dort hat ein Geheimnis nichts verloren.
  if [ -t 1 ]; then
    note "Einrichtungscode dafuer: $(cat "$CONFIG_DIR/setup-code")"
  else
    note "Einrichtungscode dafuer: sudo dzpage-panel setup-code"
  fi
fi
note "Protokoll: sudo dzpage-panel logs   Zustand: sudo dzpage-panel status"

# ---------------------------------------------------------------- Kopplung
# Der Moment, um den es geht: Server und DZPage-Konto verbinden. Mit dem Code
# aus dem Befehl von dzpage.com geht das ohne Rueckfrage; sonst zeigt das
# Panel einen Link, der auf dzpage.com mit einem Klick bestaetigt wird. Nie
# bei der Selbstaktualisierung (kein Terminal, und gekoppelt ist dann laengst).
LINKED=0
grep -q '"key": *"dzp_panel_' "$CONFIG_DIR/panel.json" 2>/dev/null && LINKED=1
TERMINAL=0
[ -t 1 ] && (exec < /dev/tty) 2>/dev/null && TERMINAL=1

# Strg+C waehrend des Wartens soll nur die Kopplung abbrechen, nicht den Rest
# dieses Skripts. Ein Handler (statt ignorieren) gilt nur hier: Das Kind
# bekommt das Signal wie gewohnt, dieses Skript laeuft danach weiter.
pair() {
  local rc=0
  trap 'printf "\n"' INT
  "$CLI" link "$@" || rc=$?
  trap - INT
  return "$rc"
}

if [ "$LINKED" -eq 1 ]; then
  # Schon ein Schluessel da. Mit Code fragt link bei DZPage nach und ersetzt
  # ihn nur, wenn DZPage ihn ablehnt (widerrufen): Derselbe Befehl ein zweites
  # Mal koppelt so nicht doppelt, einer nach dem Widerrufen aber schon.
  if [ -n "$PAIR_TOKEN" ]; then
    say "Mit DZPage verbinden"
    if ! pair --token "$PAIR_TOKEN"; then
      LINKED=0
      warn "Nicht verbunden. Spaeter: sudo dzpage-panel link"
    fi
  fi
elif [ -n "$PAIR_TOKEN" ]; then
  say "Mit DZPage verbinden"
  if pair --token "$PAIR_TOKEN"; then
    LINKED=1
  elif [ "$TERMINAL" -eq 1 ] && [ "$LINK" -eq 1 ]; then
    note "Dann mit Link und Code:"
    pair && LINKED=1 || warn "Nicht verbunden. Spaeter: sudo dzpage-panel link"
  else
    warn "Nicht verbunden. Spaeter mit Link und Code: sudo dzpage-panel link"
  fi
elif [ "$LINK" -eq 1 ] && [ "$TERMINAL" -eq 1 ]; then
  say "Mit DZPage verbinden"
  pair && LINKED=1 || warn "Nicht verbunden. Spaeter: sudo dzpage-panel link"
else
  say "Mit DZPage verbinden"
  note "sudo dzpage-panel link"
fi

# ---------------------------------------------------------------- Steam
# Ohne Steam-Konto mit DayZ laedt kein Server herunter. Das Passwort tippt der
# Mensch direkt in SteamCMD; es geht weder durch dieses Skript noch zu DZPage.
if [ "$LINKED" -eq 1 ] && { [ "$FIRST_INSTALL" -eq 1 ] || [ -n "$PAIR_TOKEN" ]; } && [ "$TERMINAL" -eq 1 ]; then
  say "Steam"
  note "Ein DayZ-Server braucht ein Steam-Konto, das DayZ besitzt (anonym verweigert Steam den Download)."
  printf '  Steam-Kontoname (leer lassen, um es spaeter mit "sudo dzpage-panel steam-login <konto>" zu tun): '
  STEAM_ACCOUNT=""
  read -r STEAM_ACCOUNT < /dev/tty || STEAM_ACCOUNT=""
  STEAM_ACCOUNT=$(printf '%s' "$STEAM_ACCOUNT" | tr -d '[:space:]')
  if [ -n "$STEAM_ACCOUNT" ]; then
    "$CLI" steam-login "$STEAM_ACCOUNT" < /dev/tty \
      || warn "Steam-Anmeldung nicht abgeschlossen. Spaeter: sudo dzpage-panel steam-login $STEAM_ACCOUNT"
  fi
fi

say "Fertig"
if [ "$LINKED" -eq 1 ]; then
  note "Das Panel steht jetzt auf dzpage.com unter RCon bei deinen verbundenen Servern."
fi
if [ "$INSTALL_METHOD" = "git" ]; then
  note "Das Panel aktualisiert sich selbst, sobald eine neue Fassung erscheint."
fi
printf '\n'
