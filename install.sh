#!/usr/bin/env bash
#
# Installiert das DZPage Panel als systemd-Dienst.
#
#   sudo ./install.sh                  Installation oder Aktualisierung
#   sudo ./install.sh --no-steam-deps  ohne 32-Bit-Bibliotheken fuer SteamCMD
#   sudo ./install.sh --no-node        keine eigene Node-Laufzeit installieren
#   sudo ./install.sh --with-docker    Docker-Laufzeit freischalten (siehe README)
#
# Das Skript ist mehrfach ausfuehrbar: ein zweiter Lauf aktualisiert die
# Dateien und startet den Dienst neu, ohne Konfiguration oder Daten anzufassen.
set -euo pipefail

APP_DIR=/usr/lib/dzpage-panel
CONFIG_DIR=/etc/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
SERVICE_USER=dzpage
UNIT=/etc/systemd/system/dzpage-panel.service
NODE_MAJOR_MIN=22
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)

ORIGINAL_ARGS=("$@")

WITH_STEAM_DEPS=1
WITH_NODE_INSTALL=1
WITH_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --no-steam-deps) WITH_STEAM_DEPS=0 ;;
    --no-node) WITH_NODE_INSTALL=0 ;;
    --with-docker) WITH_DOCKER=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte mit sudo ausfuehren."
[ -d /run/systemd/system ] || die "Dieses System benutzt kein systemd."
[ -f "$SOURCE_DIR/bin/dzpage-panel.js" ] || die "install.sh muss im entpackten Panel-Verzeichnis liegen."

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
  note "util-linux (script), tar, ca-certificates und die 32-Bit-Bibliothek"
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
  ( cd "$TMP"
    curl -fsSL -O "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"
    FILE=$(grep "$NODE_ARCH.tar.xz" SHASUMS256.txt | awk '{print $2}' | head -1)
    [ -n "$FILE" ] || exit 1
    curl -fsSL -O "https://nodejs.org/dist/latest-v24.x/$FILE"
    # Nur herunterladen reicht nicht: die Pruefsumme kommt von derselben Quelle,
    # deckt aber einen abgebrochenen oder verfaelschten Transport ab.
    sha256sum -c --ignore-missing SHASUMS256.txt >/dev/null
    mkdir -p "$APP_DIR/node"
    tar -xJf "$FILE" -C "$APP_DIR/node" --strip-components=1
  ) || die "Node konnte nicht installiert werden."
  rm -rf "$TMP"
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
install -d -m 0751 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/servers"
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
# sein — sonst waere die sudo-Regel wertlos.
install -m 0755 -o root -g root "$SOURCE_DIR/helper/dzpage-panel-helper.sh" "$APP_DIR/helper.sh"
install -m 0755 -o root -g root "$SOURCE_DIR/helper/launch-server.sh" "$APP_DIR/launch-server.sh"
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
      -e "s|@INSTALL_ARGS@|$(sed_escape "${ORIGINAL_ARGS[*]:-}")|" \
    "$SOURCE_DIR/helper/self-update.sh" > "$APP_DIR/self-update.sh"
  chown root:root "$APP_DIR/self-update.sh"
  chmod 0755 "$APP_DIR/self-update.sh"
  note "Aktualisierung ueber $REPOSITORY"
else
  rm -f "$APP_DIR/self-update.sh"
  note "Von Hand installiert — das Panel meldet Aktualisierungen, spielt sie aber nicht ein."
fi

ARGS_JSON=""
for arg in ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}; do
  ARGS_JSON="${ARGS_JSON:+$ARGS_JSON, }\"$arg\""
done
cat > "$CONFIG_DIR/install.json" <<EOF
{
  "method": "$INSTALL_METHOD",
  "checkout": "$CHECKOUT",
  "repository": "$REPOSITORY",
  "args": [$ARGS_JSON],
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
# Gehoert root: Das Panel liest die Datei, aendern darf es sie nicht.
chown root:root "$CONFIG_DIR/install.json"
chmod 0644 "$CONFIG_DIR/install.json"

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

PORT=$(grep -oE '"port"[^0-9]*[0-9]+' "$CONFIG_DIR/panel.json" 2>/dev/null | grep -oE '[0-9]+$' || echo 8410)
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

say "Fertig"
note "Oberflaeche: http://127.0.0.1:$PORT"
note "Von aussen erreichbar nur ueber einen Reverse-Proxy mit TLS (siehe README)."
note "Protokoll:   journalctl -u dzpage-panel -f"
if [ "$INSTALL_METHOD" = "git" ]; then
  note "Aktualisierung: das Panel sieht selbst nach neuen Fassungen (unter 'Aktualisierungen' einstellbar)."
fi
printf '\n  Vor dem Assistenten auf dzpage.com unter /rcon einen Panel-Schluessel\n'
printf '  erstellen — der Assistent fragt im vierten Schritt danach.\n\n'
