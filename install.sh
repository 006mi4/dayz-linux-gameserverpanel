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
#   sudo ./install.sh --lang <sprache>    Sprache der Terminal-Texte (en, de, fr, ...)
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
# Wie "engines" in package.json. node:sqlite gibt es ab 22.5, aber unter
# 22.5.1 scheitert die Testsuite reproduzierbar ("disk I/O error" von SQLite);
# 22.6, 22.7, 22.8, 22.10, 22.11, 22.12 und 24 bestehen sie.
NODE_MAJOR_MIN=22
NODE_MINOR_MIN=6
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)
# So lange warten die Fragen im Terminal auf eine Antwort.
ANSWER_SECONDS=300

# Die Sprache steht vor allem anderen fest, auch vor der Pruefung der
# Argumente. Gemerkt wird sie in install.json, aber nur, wenn sie mit --lang
# ausdruecklich gewaehlt wurde (dzpage.com haengt die Sprache der Seite an den
# Befehl); sonst bleibt die gemerkte, und ohne beides gilt die Umgebung.
# shellcheck source=helper/i18n.sh
. "$SOURCE_DIR/helper/i18n.sh"
i18n_init "$SOURCE_DIR/src/i18n/terminal" "$(i18n_arg "$@")"
LOCALE_LIST=${I18N_LOCALES// /, }

usage() {
  printf '%s\n\n' "$(t install.help.title)"
  printf '  %-38s %s\n' "sudo ./install.sh" "$(t install.help.default)"
  printf '  %-38s %s\n' "sudo ./install.sh --pair <code>" "$(t install.help.pair)"
  printf '  %-38s %s\n' "sudo ./install.sh --no-link" "$(t install.help.no_link)"
  printf '  %-38s %s\n' "sudo ./install.sh --domain <name>" "$(t install.help.domain)"
  printf '  %-38s %s\n' "sudo ./install.sh --no-steam-deps" "$(t install.help.no_steam_deps)"
  printf '  %-38s %s\n' "sudo ./install.sh --no-node" "$(t install.help.no_node)"
  printf '  %-38s %s\n' "sudo ./install.sh --with-docker" "$(t install.help.with_docker)"
  printf '  %-38s %s\n' "sudo ./install.sh --lang <code>" "$(t install.help.lang locales="$LOCALE_LIST")"
  printf '\n%s\n' "$(t install.help.rerun)"
}

WITH_STEAM_DEPS=1
WITH_NODE_INSTALL=1
WITH_DOCKER=0
DOMAIN=""
PAIR_TOKEN=""
LINK=1
LANG_WANTED=""
# Was die Selbstaktualisierung bei jeder neuen Fassung wieder mitgibt. Domain
# und Kopplungscode gehoeren nicht dazu: HTTPS wird einmal eingerichtet und
# bleibt, und ein Kopplungscode gilt genau einmal.
PERSIST_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-steam-deps) WITH_STEAM_DEPS=0; PERSIST_ARGS+=("$1") ;;
    --no-node) WITH_NODE_INSTALL=0; PERSIST_ARGS+=("$1") ;;
    --with-docker) WITH_DOCKER=1; PERSIST_ARGS+=("$1") ;;
    --domain) [ "$#" -ge 2 ] || { t install.domain_needs_name >&2; echo >&2; exit 2; }; DOMAIN=$2; shift ;;
    --domain=*) DOMAIN=${1#--domain=} ;;
    --pair) [ "$#" -ge 2 ] || { t install.pair_needs_code >&2; echo >&2; exit 2; }; PAIR_TOKEN=$2; shift ;;
    --pair=*) PAIR_TOKEN=${1#--pair=} ;;
    --no-link) LINK=0 ;;
    --lang)
      case "${2:-}" in ""|-*) t install.lang_needs_code locales="$LOCALE_LIST" >&2; echo >&2; exit 2 ;; esac
      LANG_WANTED=$2; shift ;;
    --lang=*) LANG_WANTED=${1#--lang=} ;;
    -h|--help) usage; exit 0 ;;
    *) t common.unknown_option option="$1" >&2; echo >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m %s\n' "$(t common.warning)" "$*"; }
die() { printf '\n\033[31m%s\033[0m %s\n' "$(t common.error)" "$*" >&2; exit 1; }

# Eine unbekannte Sprache ist kein Grund, die Installation abzubrechen: Kennt
# dzpage.com eines Tages eine Sprache mehr als dieses Panel, geht es auf
# Englisch weiter (oder in der gemerkten Sprache).
[ -z "$I18N_REJECTED" ] || warn "$(t common.lang_unknown lang="$I18N_REJECTED" locales="$LOCALE_LIST")"
STORE_LANG=$I18N_STORED
if [ -n "$LANG_WANTED" ] && [ -z "$I18N_REJECTED" ]; then
  STORE_LANG=$I18N_LOCALE
fi

# Ein Befehl als Dienstbenutzer. Fuer Lesezugriffe in seinen Verzeichnissen:
# Dort kann er Eintraege gegen Verweise tauschen, und als er selbst erreicht
# ein Verweis nichts, was er nicht ohnehin lesen darf.
as_service() { setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --clear-groups -- "$@"; }

# Schreibt stdin als Datei, die root gehoert, in ein Verzeichnis des Dienstes.
# Warum ueber /etc und "mv -T", steht bei install.json.
replace_root_file() {
  local dest=$1 tmp
  tmp=$(mktemp "$(dirname "$CONFIG_DIR")/.dzpage-panel-$(basename "$dest").XXXXXX") \
    || die "$(t install.write_failed_tmp file="$dest" dir="$(dirname "$CONFIG_DIR")")"
  if cat > "$tmp" && chmod 0644 "$tmp" && mv -fT "$tmp" "$dest"; then
    return 0
  fi
  rm -f "$tmp"
  die "$(t install.write_failed file="$dest")"
}

# apt-get, das auf eine belegte Paketverwaltung wartet, statt sofort mit 100
# abzubrechen: Auf einem frisch gestarteten Server laufen oft gerade die
# automatischen Updates. DPkg::Lock::Timeout allein reicht nicht, es deckt
# nur die Sperren von dpkg ab; "apt-get update" (Paketlisten) und das
# Herunterladen (Archiv) brechen trotzdem sofort ab, gemessen mit apt 2.4 und
# 2.8. Deshalb ein neuer Versuch, solange apt eine Sperre meldet, insgesamt
# hoechstens APT_WAIT_SECONDS lang. LC_ALL=C, damit die Meldung erkennbar ist.
APT_WAIT_SECONDS=600
apt_get() {
  local deadline=$((SECONDS + APT_WAIT_SECONDS)) out rc locked waited=0 left
  while :; do
    left=$((deadline - SECONDS))
    [ "$left" -ge 1 ] || left=1
    rc=0
    out=$(LC_ALL=C apt-get -o "DPkg::Lock::Timeout=$left" "$@" 2>&1) || rc=$?
    locked=0
    if [ "$rc" -ne 0 ] && grep -qE 'Could not get lock|Unable to lock|Unable to acquire' <<<"$out"; then
      locked=1
    fi
    if [ "$locked" -eq 0 ] || [ "$SECONDS" -ge "$deadline" ]; then
      if [ "$rc" -eq 0 ]; then
        [ -z "$out" ] || printf '%s\n' "$out"
      else
        printf '%s\n' "$out" >&2
      fi
      [ "$locked" -eq 0 ] || warn "$(t common.apt_locked seconds="$APT_WAIT_SECONDS")" >&2
      return "$rc"
    fi
    [ "$waited" -eq 1 ] || note "$(t common.apt_busy)" >&2
    waited=1
    sleep 10
  done
}

[ "$(id -u)" -eq 0 ] || die "$(t common.need_root)"
[ -d /run/systemd/system ] || die "$(t install.no_systemd)"
[ -f "$SOURCE_DIR/bin/dzpage-panel.js" ] || die "$(t install.not_in_source)"

# Erstinstallation oder Aktualisierung? Nur bei der ersten wird gefragt.
FIRST_INSTALL=1
[ -f "$CONFIG_DIR/install.json" ] && FIRST_INSTALL=0

# ---------------------------------------------------------------- Vorpruefung
say "$(t install.precheck)"
# DayZServer und SteamCMD gibt es nur fuer x86_64. Auf einem ARM-Rechner
# liefe das Panel, koennte aber keinen einzigen Server starten.
#
# Nur bei der Erstinstallation ein Abbruch. Bei einer Aktualisierung lief das
# Panel hier schon, und ein Abbruch liesse die Selbstaktualisierung alle paar
# Minuten scheitern und zuruecknehmen, ohne Ende.
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
  if [ "$FIRST_INSTALL" -eq 1 ]; then
    die "$(t install.arch_unsupported arch="$ARCH")"
  fi
  warn "$(t install.arch_update arch="$ARCH")"
else
  note "$(t install.arch arch="$ARCH")"
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
    *) warn "$(t install.os_untested os="$OS_NAME")" ;;
  esac
fi

MEM_MB=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -lt 3500 ]; then
  warn "$(t install.memory_low mb="$MEM_MB")"
else
  note "$(t install.memory mb="$MEM_MB")"
fi
mkdir -p "$(dirname "$DATA_DIR")"
FREE_GB=$(df -Pk "$(dirname "$DATA_DIR")" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}')
if [ "${FREE_GB:-0}" -lt 12 ]; then
  warn "$(t install.disk_low gb="${FREE_GB:-0}" dir="$(dirname "$DATA_DIR")")"
else
  note "$(t install.disk gb="$FREE_GB" dir="$(dirname "$DATA_DIR")")"
fi

case "$PAIR_TOKEN" in
  ""|dzp_pair_*) ;;
  *) die "$(t install.pair_format)" ;;
esac

# Aus einem Git-Arbeitsverzeichnis installiert? Dann kann sich das Panel spaeter
# selbst aktualisieren — und nur dann. Wer die Dateien von Hand kopiert hat,
# bekommt kein Programm, das ihm ungefragt darin herumschreibt.
SOURCE_IS_GIT=0
[ -d "$SOURCE_DIR/.git" ] && SOURCE_IS_GIT=1

# ---------------------------------------------------------------- Pakete
if command -v apt-get >/dev/null 2>&1; then
  say "$(t install.packages)"
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
      note "$(t install.add_i386)"
      dpkg --add-architecture i386
      apt_get update -qq
    }
    dpkg -s lib32gcc-s1 >/dev/null 2>&1 || MISSING="$MISSING lib32gcc-s1"
  fi
  if [ -n "$MISSING" ]; then
    note "$(t install.installing packages="${MISSING# }")"
    apt_get update -qq
    # shellcheck disable=SC2086
    apt_get install -y -qq $MISSING
  else
    note "$(t install.packages_ok)"
  fi
else
  say "$(t install.no_apt)"
  note "$(t install.no_apt_list)"
fi

# ---------------------------------------------------------------- Node
say "$(t install.node)"
case "$(uname -m)" in
  x86_64) NODE_ARCH=linux-x64 ;;
  aarch64|arm64) NODE_ARCH=linux-arm64 ;;
  *) NODE_ARCH="" ;;
esac

# Laedt die aktuelle Node-24-Laufzeit von nodejs.org, prueft die Pruefsumme
# und entpackt sie nach $1, das es noch nicht geben darf. Alles darin gehoert
# root, gleich, was im Archiv steht.
#
# Jeder Schritt mit eigenem "|| exit 1": Links von "|| die" schaltet bash
# "set -e" auch innerhalb der Unterschale ab. Bis 0.4.0 lief deshalb eine
# falsche Pruefsumme einfach durch, und tar entpackte trotzdem.
fetch_node() {
  local dest=$1 tmp rc=0
  [ -n "$NODE_ARCH" ] || return 1
  tmp=$(mktemp -d) || return 1
  ( cd "$tmp" || exit 1
    curl -fsSL -O "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" || exit 1
    FILE=$(grep "$NODE_ARCH.tar.xz" SHASUMS256.txt | awk '{print $2}' | head -1)
    [ -n "$FILE" ] || exit 1
    curl -fsSL -O "https://nodejs.org/dist/latest-v24.x/$FILE" || exit 1
    # Nur herunterladen reicht nicht: die Pruefsumme kommt von derselben Quelle,
    # deckt aber einen abgebrochenen oder verfaelschten Transport ab.
    sha256sum -c --ignore-missing --quiet SHASUMS256.txt || exit 1
    mkdir "$dest" || exit 1
    # Ohne --no-same-owner uebernimmt tar als root den Besitzer aus dem
    # Archiv, bei nodejs.org uid 1001 (siehe unten).
    tar -xJf "$FILE" -C "$dest" --strip-components=1 --no-same-owner || exit 1
    chown -R root:root "$dest" || exit 1
  ) || rc=1
  rm -rf "$tmp"
  return "$rc"
}

# Eine frische Laufzeit nach $APP_DIR/node: erst daneben laden und pruefen,
# dann tauschen. $APP_DIR gehoert root, beide Umbenennungen kann sonst niemand
# stoeren, und der laufende Dienst behaelt bis zu seinem Neustart die Datei,
# die er geoeffnet hat.
replace_node_runtime() {
  local fresh="$APP_DIR/node.neu" old="$APP_DIR/node.alt"
  # Bei der Erstinstallation gibt es $APP_DIR hier noch nicht.
  install -d -m 0755 "$APP_DIR" || return 1
  rm -rf "$fresh" "$old"
  fetch_node "$fresh" || { rm -rf "$fresh"; return 1; }
  if [ -e "$APP_DIR/node" ] || [ -L "$APP_DIR/node" ]; then
    mv -T "$APP_DIR/node" "$old" || { rm -rf "$fresh"; return 1; }
  fi
  if ! mv -T "$fresh" "$APP_DIR/node"; then
    if [ -e "$old" ]; then mv -T "$old" "$APP_DIR/node" || true; fi
    rm -rf "$fresh"
    return 1
  fi
  rm -rf "$old" || warn "$(t install.node_old_left dir="$old")"
}

# Bis 0.5.3 entpackte tar als root mit dem Besitzer aus dem Archiv: Die eigene
# Laufzeit gehoerte uid 1001, und root fuehrt sie hier und bei jeder
# Selbstaktualisierung aus. Wer uid 1001 hat, konnte bin/node gegen etwas
# Eigenes tauschen oder gegen einen Verweis darauf. Eine solche Laufzeit wird
# deshalb weder ausgefuehrt noch umgebaut (chown -R aendert an einem Verweis
# nur den Verweis), sondern durch eine frisch geladene ersetzt.
#
# Klappt das Laden nicht, kommt die alte trotzdem weg, bevor die Installation
# abbricht: Die Selbstaktualisierung nimmt danach den vorherigen Stand zurueck,
# und dessen install.sh fuehrt $APP_DIR/node/bin/node sonst doch als root aus.
# Der laufende Dienst behaelt seine geoeffnete Datei; die naechste
# Aktualisierung (oder ein erneutes install.sh) laedt die Laufzeit dann neu.
node_runtime_untrusted() {
  [ -L "$APP_DIR/node" ] && return 0
  [ -d "$APP_DIR/node" ] || return 1
  [ -n "$(find "$APP_DIR/node" \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) -print -quit 2>/dev/null || true)" ]
}
discard_node_runtime() {
  rm -rf "$APP_DIR/node.alt"
  mv -T "$APP_DIR/node" "$APP_DIR/node.alt" || return 1
  rm -rf "$APP_DIR/node.alt" || true
}
# Reste eines abgebrochenen Austauschs; benutzt werden sie nie.
rm -rf "$APP_DIR/node.neu" "$APP_DIR/node.alt" || true
if node_runtime_untrusted; then
  if [ "$WITH_NODE_INSTALL" -eq 1 ]; then
    note "$(t install.node_untrusted dir="$APP_DIR/node")"
    if ! replace_node_runtime; then
      discard_node_runtime || true
      die "$(t install.node_reload_failed)"
    fi
    note "$(t install.node_checksum)"
  else
    discard_node_runtime || die "$(t install.node_discard_failed dir="$APP_DIR/node")"
    note "$(t install.node_discarded dir="$APP_DIR/node")"
  fi
fi

NODE_BIN=""
for candidate in "$APP_DIR/node/bin/node" "$(command -v node || true)" /usr/bin/node /usr/local/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  version=$("$candidate" -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
  major=${version%%.*}
  minor=${version#*.}
  minor=${minor%%.*}
  case "$major:$minor" in *[!0-9:]*|:*|*:) continue ;; esac
  if [ "$major" -gt "$NODE_MAJOR_MIN" ] || { [ "$major" -eq "$NODE_MAJOR_MIN" ] && [ "$minor" -ge "$NODE_MINOR_MIN" ]; }; then
    NODE_BIN=$candidate
    break
  fi
done

if [ -z "$NODE_BIN" ] && [ "$WITH_NODE_INSTALL" -eq 1 ]; then
  [ -n "$NODE_ARCH" ] \
    || die "$(t install.node_arch arch="$(uname -m)" version="$NODE_MAJOR_MIN.$NODE_MINOR_MIN")"
  note "$(t install.node_installing version="$NODE_MAJOR_MIN.$NODE_MINOR_MIN" dir="$APP_DIR/node")"
  replace_node_runtime || die "$(t install.node_failed)"
  note "$(t install.node_checksum)"
  NODE_BIN="$APP_DIR/node/bin/node"
fi

[ -n "$NODE_BIN" ] || die "$(t install.node_missing version="$NODE_MAJOR_MIN.$NODE_MINOR_MIN")"
note "$NODE_BIN ($("$NODE_BIN" --version))"

# node:sqlite braucht bis Node 22.12 einen Schalter.
# Statt die Version zu raten, wird beides ausprobiert.
NODE_FLAGS=""
if ! "$NODE_BIN" -e 'require("node:sqlite")' >/dev/null 2>&1; then
  if "$NODE_BIN" --experimental-sqlite -e 'require("node:sqlite")' >/dev/null 2>&1; then
    NODE_FLAGS="--experimental-sqlite"
    note "$(t install.node_flags flags="$NODE_FLAGS")"
  else
    die "$(t install.node_sqlite node="$NODE_BIN" version="$NODE_MAJOR_MIN.$NODE_MINOR_MIN")"
  fi
fi

# ---------------------------------------------------------------- Benutzer und Verzeichnisse
if [ "$WITH_DOCKER" -eq 1 ]; then
  say "$(t install.docker)"
  if ! command -v docker >/dev/null 2>&1; then
    die "$(t install.docker_missing)"
  fi
  # Ehrlich bleiben: Wer in der docker-Gruppe ist, kann auf dieser Maschine
  # alles. Das liegt an Docker, nicht am Panel — aber wissen sollte man es.
  note "$(t install.docker_group)"
  note "$(t install.docker_root)"
fi

say "$(t install.users)"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  note "$(t install.user_created user="$SERVICE_USER")"
fi
if [ "$WITH_DOCKER" -eq 1 ]; then
  usermod -aG docker "$SERVICE_USER"
  note "$(t install.user_docker user="$SERVICE_USER")"
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
    || warn "$(t install.file_kept file="$CONFIG_DIR/$name")"
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
  || warn "$(t install.dir_kept dir="$DATA_DIR/servers")"
note "$(t install.dirs_ready config="$CONFIG_DIR" data="$DATA_DIR")"

# ---------------------------------------------------------------- Dateien
say "$(t install.files dir="$APP_DIR")"
install -d -m 0755 "$APP_DIR"
for item in bin src public package.json systemd; do
  rm -rf "${APP_DIR:?}/$item"
  cp -a "$SOURCE_DIR/$item" "$APP_DIR/$item"
done
chown -R root:root "$APP_DIR/bin" "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/package.json"
note "$(t install.files_size size="$(du -sh "$APP_DIR" | cut -f1)")"

# Das Hilfsprogramm gehoert root und darf vom Dienstbenutzer nicht veraenderbar
# sein: Es laeuft als root, wer es aendern koennte, waere root.
install -m 0755 -o root -g root "$SOURCE_DIR/helper/dzpage-panel-helper.sh" "$APP_DIR/helper.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/launch-server.sh" "$APP_DIR/launch-server.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/https.sh" "$APP_DIR/https.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/uninstall.sh" "$APP_DIR/uninstall.sh"
# Wird eingebunden, nicht ausgefuehrt; die Texte dazu liegen unter src/.
install -m 0644 -o root -g root "$SOURCE_DIR/helper/i18n.sh" "$APP_DIR/i18n.sh"
for unit in dzpage-server@.service dzpage-panel-helper.socket dzpage-panel-helper@.service; do
  install -m 0644 -o root -g root "$SOURCE_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done

# ---------------------------------------------------------------- Herkunft
say "$(t install.origin)"
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
  note "$(t install.origin_git repo="$REPOSITORY")"
else
  rm -f "$APP_DIR/self-update.sh"
  note "$(t install.origin_manual)"
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
  "lang": "$STORE_LANG",
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
note "$(t install.cli cli="$CLI")"

say "$(t install.helper)"
# Kein sudo: Die Unit des Panels ist gehaertet, und Optionen wie PrivateDevices
# setzen implizit NoNewPrivileges — sudo koennte dann gar nichts mehr erhoehen.
# Stattdessen ein Socket, den nur der Dienstbenutzer oeffnen darf; systemd
# startet den Helfer je Anfrage als root.
rm -f /etc/sudoers.d/dzpage-panel
systemctl daemon-reload
systemctl enable --quiet dzpage-panel-helper.socket
systemctl restart dzpage-panel-helper.socket
note "$(t install.socket state="$(systemctl is-active dzpage-panel-helper.socket)")"

# ---------------------------------------------------------------- Dienst
say "$(t install.service)"
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $NODE_FLAGS $APP_DIR/bin/dzpage-panel.js|" \
  "$SOURCE_DIR/systemd/dzpage-panel.service" > "$UNIT"
chmod 0644 "$UNIT"
systemd-analyze verify "$UNIT" || die "$(t install.unit_broken)"
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
  die "$(t install.not_up)"
fi

# ---------------------------------------------------------------- HTTPS
# Scheitert nur dieser Teil, ist das Panel trotzdem installiert. Deshalb kein
# Abbruch, sondern ein Hinweis, wie es spaeter nachzuholen ist.
if [ -n "$DOMAIN" ]; then
  if ! "$APP_DIR/https.sh" enable "$DOMAIN"; then
    warn "$(t install.https_failed domain="$DOMAIN")"
  fi
fi

# ---------------------------------------------------------------- Lokale Oberflaeche
# Verwaltet wird ueber dzpage.com. Die lokale Oberflaeche ist der Notzugang,
# deshalb steht sie hier kurz und vor der Kopplung, die den Abschluss bildet.
say "$(t install.local_ui)"
# Als Dienstbenutzer gelesen: Bei der Selbstaktualisierung geht diese Ausgabe
# in self-update.log, und root braechte ueber einen Verweis anstelle der Datei
# den Anfang jeder Datei dorthin, die nur root lesen darf. timeout, weil eine
# FIFO an dieser Stelle das Lesen sonst ewig blockiert.
HTTPS_DOMAIN=$(as_service timeout 5 head -c 256 "$CONFIG_DIR/https-domain" 2>/dev/null | head -n 1 || true)
if [ -n "$HTTPS_DOMAIN" ]; then
  note "https://$HTTPS_DOMAIN"
else
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  note "$(t install.local_url port="$PORT")"
  note "    ssh -L $PORT:127.0.0.1:$PORT ${SUDO_USER:-root}@${HOST_IP:-$(t install.this_machine)}"
  note "$(t install.https_hint)"
fi
if [ -s "$CONFIG_DIR/setup-code" ]; then
  # Nur auf ein Terminal: Bei der Selbstaktualisierung geht diese Ausgabe in
  # eine Protokolldatei, und dort hat ein Geheimnis nichts verloren.
  if [ -t 1 ]; then
    note "$(t install.setup_code code="$(cat "$CONFIG_DIR/setup-code")")"
  else
    note "$(t install.setup_code_cmd)"
  fi
fi
note "$(t install.logs_status)"

# ---------------------------------------------------------------- Kopplung
# Der Moment, um den es geht: Server und DZPage-Konto verbinden. Mit dem Code
# aus dem Befehl von dzpage.com geht das bis auf die Frage nach dem Konto von
# selbst; sonst zeigt das Panel einen Link, der auf dzpage.com mit einem Klick
# bestaetigt wird. Nie bei der Selbstaktualisierung (kein Terminal, und
# gekoppelt ist dann laengst).
LINKED=0
grep -q '"key": *"dzp_panel_' "$CONFIG_DIR/panel.json" 2>/dev/null && LINKED=1
TERMINAL=0
[ -t 1 ] && (exec < /dev/tty) 2>/dev/null && TERMINAL=1

# Strg+C waehrend eines solchen Schritts soll nur ihn abbrechen, nicht den Rest
# dieses Skripts. Ein Handler (statt ignorieren) gilt nur hier: Das Kind
# bekommt das Signal wie gewohnt, dieses Skript laeuft danach weiter. Fuer ein
# "read" in diesem Skript selbst taugt das nicht, ein abgefangenes SIGINT
# unterbricht "read -t" nicht (gemessen mit bash 5.1 und 5.2); dort liest eine
# Unterschale ohne Handler.
interactive() {
  local rc=0
  trap 'printf "\n"' INT
  "$@" || rc=$?
  trap - INT
  return "$rc"
}
pair() { interactive "$CLI" link "$@"; }

# Unter "curl ... | sudo bash" startet sudo dieses Skript als Hintergrund-
# Prozessgruppe in einem eigenen Terminal und reicht Tastatureingaben erst
# durch, wenn es das Terminal anfasst und dafuer SIGTTIN oder SIGTTOU bekommt.
# Ein "read -t" tut das unter bash 5.2 nicht (es wartet per select), die
# unveraenderten Einstellungen zu setzen schon (SIGTTOU). Deshalb vor jedem
# Lesen mit Frist.
claim_terminal() {
  local settings
  if settings=$(stty -g < /dev/tty 2>/dev/null); then
    stty "$settings" < /dev/tty 2>/dev/null || true
  fi
}

if [ "$LINKED" -eq 1 ]; then
  # Schon ein Schluessel da. Mit Code fragt link bei DZPage nach und ersetzt
  # ihn nur, wenn DZPage ihn ablehnt (widerrufen): Derselbe Befehl ein zweites
  # Mal koppelt so nicht doppelt, einer nach dem Widerrufen aber schon.
  if [ -n "$PAIR_TOKEN" ]; then
    say "$(t install.link)"
    if ! pair --token "$PAIR_TOKEN"; then
      LINKED=0
      warn "$(t install.not_linked)"
    fi
  fi
elif [ -n "$PAIR_TOKEN" ]; then
  say "$(t install.link)"
  PAIR_RC=0
  pair --token "$PAIR_TOKEN" || PAIR_RC=$?
  # Link und Code nur, wenn der Code selbst nicht ging (Exit 1: abgelaufen,
  # Netz). Wer an der Kontofrage verneint, abbricht oder nicht antwortet
  # (Exit 4), hat entschieden; ebenso, wer vorher Strg+C drueckt (130).
  if [ "$PAIR_RC" -eq 0 ]; then
    LINKED=1
  elif [ "$PAIR_RC" -eq 1 ] && [ "$TERMINAL" -eq 1 ] && [ "$LINK" -eq 1 ]; then
    note "$(t install.link_fallback)"
    pair && LINKED=1 || warn "$(t install.not_linked)"
  elif [ "$PAIR_RC" -eq 1 ]; then
    warn "$(t install.not_linked_later)"
  else
    warn "$(t install.not_linked)"
  fi
elif [ "$LINK" -eq 1 ] && [ "$TERMINAL" -eq 1 ]; then
  say "$(t install.link)"
  pair && LINKED=1 || warn "$(t install.not_linked)"
else
  say "$(t install.link)"
  note "sudo dzpage-panel link"
fi

# ---------------------------------------------------------------- Steam
# Ohne Steam-Konto mit DayZ laedt kein Server herunter. Das Passwort tippt der
# Mensch direkt in SteamCMD; es geht weder durch dieses Skript noch zu DZPage.
if [ "$LINKED" -eq 1 ] && { [ "$FIRST_INSTALL" -eq 1 ] || [ -n "$PAIR_TOKEN" ]; } && [ "$TERMINAL" -eq 1 ]; then
  say "$(t install.steam)"
  note "$(t install.steam_why)"
  printf '  %s ' "$(t install.steam_prompt)"
  # Mit Frist, damit eine Installation ohne Menschen davor trotzdem endet.
  # Strg+C, Strg+D und keine Antwort ueberspringen nur diesen Schritt.
  claim_terminal
  STEAM_RC=0
  trap 'printf "\n"' INT
  STEAM_ACCOUNT=$(trap - INT; IFS= read -r -t "$ANSWER_SECONDS" line < /dev/tty && printf '%s' "$line") || STEAM_RC=$?
  trap - INT
  if [ "$STEAM_RC" -ne 0 ]; then
    STEAM_ACCOUNT=""
    printf '\n'
    note "$(t install.steam_skipped)"
  fi
  STEAM_ACCOUNT=$(printf '%s' "$STEAM_ACCOUNT" | tr -d '[:space:]')
  if [ -n "$STEAM_ACCOUNT" ]; then
    interactive "$CLI" steam-login "$STEAM_ACCOUNT" < /dev/tty \
      || warn "$(t install.steam_failed account="$STEAM_ACCOUNT")"
  fi
fi

say "$(t install.done)"
if [ "$LINKED" -eq 1 ]; then
  note "$(t install.done_linked)"
fi
if [ "$INSTALL_METHOD" = "git" ]; then
  note "$(t install.done_selfupdate)"
fi
printf '\n'
