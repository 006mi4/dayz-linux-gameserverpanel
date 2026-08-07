#!/usr/bin/env bash
#
# Rollt eine neue Panel-Fassung aus. Aufruf nur ueber den privilegierten Helfer
# (Operation "self-update"), der uns als eigenen, kurzlebigen systemd-Dienst
# startet — waehrend dieses Skript laeuft, startet das Panel neu.
#
#   self-update.sh v0.3.1
#
# install.sh setzt beim Installieren die beiden Platzhalter unten. Das Skript
# steht deshalb nur in /usr/lib/dzpage-panel und nicht im Git-Arbeitsverzeichnis
# als fertiges Programm.
#
# Kommt die neue Fassung nicht hoch, wird der vorherige Stand wiederhergestellt.
# Das ist der ganze Grund, warum hier ein Skript steht und nicht drei Zeilen im
# Panel: Ein Prozess, der sich selbst ersetzt, kann seinen eigenen Fehlstart
# nicht mehr bemerken.
set -euo pipefail

CHECKOUT='@CHECKOUT@'
INSTALL_ARGS=(@INSTALL_ARGS@)

APP_DIR=/usr/lib/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
RESULT=$DATA_DIR/self-update.json
LOG=$DATA_DIR/self-update.log

# systemd-run startet uns mit einer nackten Umgebung: kein HOME, ein knapper
# PATH. Git und install.sh brauchen beides — ohne HOME bricht Git mit
# "fatal: $HOME not set" ab, und das mitten in einer Aktualisierung.
export HOME=${HOME:-/root}
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Sich selbst aus dem Weg raeumen: install.sh ueberschreibt gleich genau diese
# Datei, und bash liest sein Skript haeppchenweise nach — ein Austausch mitten
# im Lauf fuehrt zu unerklaerlichen Syntaxfehlern.
if [ "${DZPANEL_SELF_UPDATE_RELOCATED:-0}" != "1" ]; then
  copy=$(mktemp /tmp/dzpage-self-update.XXXXXXXX)
  cat "$0" > "$copy"
  chmod 0700 "$copy"
  DZPANEL_SELF_UPDATE_RELOCATED=1 exec "$copy" "$@"
fi
trap 'rm -f "$0"' EXIT

VERSION=${1:-}
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FROM=$(sed -n 's/.*PANEL_VERSION *= *"\([^"]*\)".*/\1/p' "$APP_DIR/src/version.js" 2>/dev/null | head -1)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Anfuehrungszeichen und Zeilenumbrueche raus: die Meldung landet in JSON, und
# eine kaputte Datei waere schlimmer als eine ungenaue Meldung.
clean() { printf '%s' "$1" | tr -d '"\\\n\r' | cut -c1-300; }

write_result() {
  local state=$1 message=$2 rolled=${3:-false} finished=""
  [ "$state" = "running" ] || finished=$(now)
  cat > "$RESULT.tmp" <<EOF
{
  "state": "$state",
  "from": "$FROM",
  "to": "${VERSION#v}",
  "startedAt": "$STARTED",
  "finishedAt": "$finished",
  "rolledBack": $rolled,
  "message": "$(clean "$message")"
}
EOF
  chmod 0644 "$RESULT.tmp"
  mv "$RESULT.tmp" "$RESULT"
}

fail() {
  echo "self-update: $*" >&2
  write_result failed "$*" false
  exit 1
}

[[ "$VERSION" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || fail "ungueltige Fassung: ${VERSION:-(keine)}"
[ -d "$CHECKOUT/.git" ] || fail "Kein Git-Arbeitsverzeichnis unter $CHECKOUT"
command -v git >/dev/null 2>&1 || fail "git ist nicht installiert"

: > "$LOG"
chmod 0640 "$LOG"
log() { echo "[$(now)] $*" >> "$LOG"; }

write_result running ""
log "Aktualisierung $FROM -> ${VERSION#v} aus $CHECKOUT"

PREVIOUS=$(git -C "$CHECKOUT" rev-parse HEAD 2>>"$LOG") || fail "Stand des Arbeitsverzeichnisses nicht lesbar"
git -C "$CHECKOUT" fetch --tags --prune --quiet origin >>"$LOG" 2>&1 || fail "git fetch fehlgeschlagen — siehe $LOG"
git -C "$CHECKOUT" rev-parse --verify --quiet "refs/tags/$VERSION^{commit}" >/dev/null \
  || fail "Etikett $VERSION gibt es bei der Gegenstelle nicht"
git -C "$CHECKOUT" reset --hard --quiet "refs/tags/$VERSION" >>"$LOG" 2>&1 || fail "Auschecken von $VERSION fehlgeschlagen"

log "Rolle aus: install.sh ${INSTALL_ARGS[*]:-(ohne Optionen)}"
if "$CHECKOUT/install.sh" "${INSTALL_ARGS[@]}" >>"$LOG" 2>&1; then
  log "Fertig auf ${VERSION#v}"
  write_result ok ""
  exit 0
fi

# Ab hier ist die neue Fassung durchgefallen: install.sh wartet selbst auf
# /health und bricht ab, wenn der Dienst nicht hochkommt.
log "Fehlstart — stelle $PREVIOUS wieder her"
git -C "$CHECKOUT" reset --hard --quiet "$PREVIOUS" >>"$LOG" 2>&1 || log "Ruecknahme im Arbeitsverzeichnis fehlgeschlagen"
if "$CHECKOUT/install.sh" "${INSTALL_ARGS[@]}" >>"$LOG" 2>&1; then
  write_result failed "Fassung ${VERSION#v} kam nicht hoch — alter Stand wiederhergestellt. Protokoll: $LOG" true
else
  write_result failed "Fassung ${VERSION#v} kam nicht hoch, und die Ruecknahme ebenfalls nicht. Protokoll: $LOG" true
fi
exit 1
