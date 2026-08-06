#!/usr/bin/env bash
#
# Installiert das DZPage Panel als systemd-Dienst.
#
#   sudo ./install.sh                  Installation oder Aktualisierung
#   sudo ./install.sh --no-steam-deps  ohne 32-Bit-Bibliotheken fuer SteamCMD
#   sudo ./install.sh --no-node        keine eigene Node-Laufzeit installieren
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

WITH_STEAM_DEPS=1
WITH_NODE_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --no-steam-deps) WITH_STEAM_DEPS=0 ;;
    --no-node) WITH_NODE_INSTALL=0 ;;
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
say "Dienstbenutzer und Verzeichnisse"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  note "Benutzer $SERVICE_USER angelegt"
fi

# Das Konfigurationsverzeichnis gehoert dem Dienst, nicht root: das Panel legt
# panel.json atomar an (Nebendatei, dann umbenennen) und braucht dafuer
# Schreibrecht im Verzeichnis selbst. Die Datei bleibt 0600.
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/servers"
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
printf '\n  Vor dem Assistenten auf dzpage.com unter /rcon einen Panel-Schluessel\n'
printf '  erstellen — der Assistent fragt im vierten Schritt danach.\n\n'
