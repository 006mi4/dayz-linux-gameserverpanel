#!/usr/bin/env bash
#
# Der einzige Teil des Panels, der Rootrechte braucht.
#
# systemd-Dienste anlegen, Benutzer anlegen und systemctl aufrufen kann kein
# unprivilegierter Prozess. Statt das Panel als root laufen zu lassen, gibt es
# dieses kleine Programm: eine feste Liste benannter Operationen, jeder
# Parameter gegen ein Muster geprueft, nichts Freies aus der Oberflaeche.
#
# Aufruf nur ueber sudo durch den Dienstbenutzer (Regel in
# /etc/sudoers.d/dzpage-panel). Alles, was hier nicht steht, geht nicht.
#
#   prepare <id> <speicherMB> <cpuProzent>   Benutzer, Rechte, Grenzwerte
#   start|stop|restart|enable|disable <id>
#   status <id>                              maschinenlesbare Zustandszeilen
#   logs <id> <zeilen>
#   destroy <id>                             Dienst weg, Benutzer weg
#   self-update <vX.Y.Z>                     neue Panel-Fassung ausrollen
#
set -euo pipefail

DATA_DIR=/var/lib/dzpage-panel
SERVERS_DIR=$DATA_DIR/servers
APP_DIR=/usr/lib/dzpage-panel
PANEL_USER=dzpage
UNIT_PREFIX=dzpage-server
DROPIN_ROOT=/etc/systemd/system

die() { echo "helper: $*" >&2; exit 64; }

need_id() {
  local id=${1:-}
  [[ "$id" =~ ^[a-f0-9]{12}$ ]] || die "ungueltige Server-Kennung"
  echo "$id"
}

need_number() {
  local value=${1:-} min=$2 max=$3
  [[ "$value" =~ ^[0-9]{1,7}$ ]] || die "keine Zahl: $value"
  [ "$value" -ge "$min" ] && [ "$value" -le "$max" ] || die "Wert ausserhalb des Bereichs: $value"
  echo "$value"
}

unit_for() { echo "$UNIT_PREFIX@$1.service"; }
user_for() { echo "dzsrv_$1"; }

# Rechte so setzen, dass beide Seiten arbeiten koennen: das Panel installiert
# die Spieldateien als dzpage, der Server schreibt spaeter als eigener Benutzer
# in dieselben Verzeichnisse. Deshalb Gruppe = Serverbenutzer, Gruppenschreibrecht
# und das setgid-Bit auf den Verzeichnissen.
fix_permissions() {
  local id=$1 dir=$2 user
  user=$(user_for "$id")
  chown -R "$PANEL_USER:$user" "$dir"
  chmod 2770 "$dir"
  find "$dir" -type d -exec chmod g+rwxs {} +
  find "$dir" -type f -exec chmod g+rw {} +
}

cmd_prepare() {
  local id memory cpu dir user unit dropin
  id=$(need_id "${1:-}")
  memory=$(need_number "${2:-6144}" 512 131072)
  cpu=$(need_number "${3:-400}" 50 3200)
  dir=$SERVERS_DIR/$id
  user=$(user_for "$id")
  unit=$(unit_for "$id")

  [ -d "$SERVERS_DIR" ] || die "Datenverzeichnis fehlt"
  [ -f "$DROPIN_ROOT/$UNIT_PREFIX@.service" ] || die "Vorlage $UNIT_PREFIX@.service fehlt"

  id -u "$user" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
  mkdir -p "$dir/game" "$dir/profiles/battleye"
  fix_permissions "$id" "$dir"

  # Durchgangsrecht, aber kein Leserecht: der Serverbenutzer kommt in sein
  # eigenes Verzeichnis, sieht aber weder die Nachbarn noch die Panel-Datenbank.
  chmod 0751 "$DATA_DIR" "$SERVERS_DIR"

  dropin=$DROPIN_ROOT/$unit.d
  mkdir -p "$dropin"
  cat > "$dropin/panel.conf" <<EOF
# Von dzpage-panel erzeugt. Aenderungen werden ueberschrieben.
[Service]
User=$user
Group=$user
MemoryMax=${memory}M
CPUQuota=${cpu}%
EOF
  chmod 0644 "$dropin/panel.conf"
  systemctl daemon-reload
  echo "prepared $id"
}

cmd_destroy() {
  local id unit user dir
  id=$(need_id "${1:-}")
  unit=$(unit_for "$id")
  user=$(user_for "$id")
  dir=$SERVERS_DIR/$id

  systemctl disable --now "$unit" >/dev/null 2>&1 || true
  rm -rf "${DROPIN_ROOT:?}/$unit.d"
  systemctl daemon-reload
  id -u "$user" >/dev/null 2>&1 && userdel "$user" || true
  # Die Spieldateien bleiben liegen; sie zu loeschen ist Sache des Panels,
  # das vorher nachfragt.
  [ -d "$dir" ] && chown -R "$PANEL_USER:$PANEL_USER" "$dir" || true
  echo "destroyed $id"
}

cmd_simple() {
  local action=$1 id unit
  id=$(need_id "${2:-}")
  unit=$(unit_for "$id")
  case "$action" in
    start|stop|restart) systemctl "$action" "$unit" ;;
    enable) systemctl enable "$unit" ;;
    disable) systemctl disable "$unit" ;;
    *) die "unbekannte Aktion" ;;
  esac
  echo "$action $id"
}

cmd_status() {
  local id unit
  id=$(need_id "${1:-}")
  unit=$(unit_for "$id")
  systemctl show "$unit" \
    -p ActiveState -p SubState -p MainPID -p MemoryCurrent -p NRestarts \
    -p ExecMainStartTimestamp -p UnitFileState -p Result
}

cmd_logs() {
  local id unit lines
  id=$(need_id "${1:-}")
  lines=$(need_number "${2:-200}" 1 2000)
  unit=$(unit_for "$id")
  journalctl -u "$unit" -n "$lines" --no-pager --output=short-iso 2>/dev/null || true
}

# Die neue Panel-Fassung rollt ein eigener Dienst aus, nicht dieser Aufruf:
# Dabei startet das Panel neu, und ein Prozess, der am Socket des Panels haengt,
# koennte danach nichts mehr melden. systemd-run bricht ausserdem ab, wenn schon
# eine Aktualisierung laeuft — zwei gleichzeitig waeren ein zerlegtes Panel.
cmd_self_update() {
  local version=${1:-}
  [[ "$version" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || die "ungueltige Fassung: $version"
  [ -x "$APP_DIR/self-update.sh" ] || die "Selbstaktualisierung ist hier nicht eingerichtet"
  systemd-run --collect --quiet --unit=dzpage-panel-selfupdate \
    --description="DZPage Panel Selbstaktualisierung $version" \
    "$APP_DIR/self-update.sh" "$version" \
    || die "Aktualisierung laeuft bereits oder liess sich nicht starten"
  echo "self-update $version gestartet"
}

[ "$(id -u)" -eq 0 ] || die "muss als root laufen"

dispatch() {
  local action=${1:-}
  shift || true
  case "$action" in
    prepare) cmd_prepare "$@" ;;
    destroy) cmd_destroy "$@" ;;
    start|stop|restart|enable|disable) cmd_simple "$action" "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    self-update) cmd_self_update "$@" ;;
    *) die "unbekannte Operation: ${action:-(keine)}" ;;
  esac
}

# Betriebsart "--stdin": systemd nimmt die Verbindung an und startet uns je
# Anfrage (siehe dzpage-panel-helper.socket). Die Anfrage ist EINE Zeile.
#
# Warum nicht sudo: Die Unit des Panels ist gehaertet, und Optionen wie
# PrivateDevices oder ProtectKernelTunables setzen implizit NoNewPrivileges —
# damit kann sudo keine Rechte mehr erhoehen. Statt die Haertung aufzuweichen,
# kommt die Anfrage ueber einen Socket, den nur der Dienstbenutzer oeffnen darf.
#
# Der Punkt gehoert seit "self-update v0.3.0" zu den erlaubten Zeichen. Er ist
# ungefaehrlich, weil keine Operation einen Pfad entgegennimmt: Kennungen sind
# zwoelf Hex-Stellen, Zahlen sind Zahlen, Fassungen haben ihr eigenes Muster.
if [ "${1:-}" = "--stdin" ]; then
  IFS= read -r line || line=""
  case "$line" in
    "")
      echo "helper: leere Anfrage" >&2
      printf '#status:64\n'
      exit 0
      ;;
    *[!A-Za-z0-9\ ._-]*)
      echo "helper: unerlaubte Zeichen in der Anfrage" >&2
      printf '#status:64\n'
      exit 0
      ;;
  esac
  # Absichtlich ohne Anfuehrungszeichen: die Zeile soll in Woerter zerfallen.
  # Gefaehrliche Zeichen sind oben schon ausgeschlossen, Namensmuster gibt es
  # keine mehr.
  # shellcheck disable=SC2086
  ( set +e; dispatch $line ) 2>&1
  printf '#status:%s\n' "$?"
  exit 0
fi

dispatch "$@"
