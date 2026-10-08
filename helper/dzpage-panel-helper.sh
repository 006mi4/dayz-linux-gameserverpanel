#!/usr/bin/env bash
#
# Der einzige Teil des Panels, der Rootrechte braucht.
#
# systemd-Dienste anlegen, Benutzer anlegen und systemctl aufrufen kann kein
# unprivilegierter Prozess. Statt das Panel als root laufen zu lassen, gibt es
# dieses kleine Programm: eine feste Liste benannter Operationen, jeder
# Parameter gegen ein Muster geprueft, nichts Freies aus der Oberflaeche.
#
# Aufruf nur ueber den Socket dzpage-panel-helper.socket, den allein der
# Dienstbenutzer oeffnen darf (Begruendung unten bei "--stdin"). Alles, was
# hier nicht steht, geht nicht.
#
#   prepare <id> <speicherMB> <cpuProzent>   Benutzer, Rechte, Grenzwerte
#   start|stop|restart|enable|disable <id>
#   status <id>                              maschinenlesbare Zustandszeilen
#   logs <id> <zeilen>
#   destroy <id>                             Dienst weg, Benutzer weg
#   firewall-open|firewall-close|firewall-status <id> <port>...
#                                            UDP-Ports in ufw/firewalld
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

  # Die Rechte nur richten, wenn sie nicht schon stimmen: Ein chown -R ueber
  # sechs Gigabyte Spieldateien kostet Zeit, und prepare laeuft inzwischen vor
  # jedem Start — damit ein Server, dessen Einrichtung einmal abgeraeumt wurde,
  # von selbst wieder hochkommt.
  if [ "$(stat -c '%U:%G' "$dir")" != "$PANEL_USER:$user" ]; then
    fix_permissions "$id" "$dir"
  fi

  # Durchgangsrecht, aber kein Leserecht: der Serverbenutzer kommt in sein
  # eigenes Verzeichnis, sieht aber weder die Nachbarn noch die Panel-Datenbank.
  chmod 0751 "$DATA_DIR" "$SERVERS_DIR"

  dropin=$DROPIN_ROOT/$unit.d
  mkdir -p "$dropin"
  cat > "$dropin/panel.conf.new" <<EOF
# Von dzpage-panel erzeugt. Aenderungen werden ueberschrieben.
[Service]
User=$user
Group=$user
MemoryMax=${memory}M
CPUQuota=${cpu}%
EOF
  chmod 0644 "$dropin/panel.conf.new"
  # daemon-reload nur, wenn sich wirklich etwas geaendert hat — sonst zahlt
  # jeder Start dafuer, dass systemd seine ganze Konfiguration neu liest.
  if cmp -s "$dropin/panel.conf.new" "$dropin/panel.conf"; then
    rm -f "$dropin/panel.conf.new"
  else
    mv "$dropin/panel.conf.new" "$dropin/panel.conf"
    systemctl daemon-reload
  fi
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

# Die Ports eines Spielservers in der Firewall der Maschine. Spieler und der
# RCon-Arbeiter von DZPage kommen von aussen; ohne Freigabe sieht niemand den
# Server, obwohl er laeuft. Nur ufw und firewalld werden angefasst: wer
# iptables oder nftables von Hand pflegt, hat sich bewusst dafuer entschieden.
#
# Die ufw-Regeln tragen den Kommentar "dzpage-panel <id>", damit die
# Deinstallation sie wiederfindet, ohne die Ports kennen zu muessen.
fw_backend() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
    echo ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    echo firewalld
  else
    echo none
  fi
}

fw_is_open() {
  local backend=$1 port=$2
  case "$backend" in
    ufw) ufw status 2>/dev/null | grep -qE "^$port/udp +ALLOW" ;;
    firewalld) firewall-cmd --quiet --query-port="$port/udp" ;;
    *) return 1 ;;
  esac
}

cmd_firewall() {
  local action=$1 id backend port open="" ports=()
  id=$(need_id "${2:-}")
  shift 2 || true
  [ "$#" -ge 1 ] && [ "$#" -le 3 ] || die "ein bis drei Ports erwartet"
  for port in "$@"; do ports+=("$(need_number "$port" 1024 65535)"); done
  backend=$(fw_backend)

  case "$backend:$action" in
    ufw:open)
      for port in "${ports[@]}"; do
        ufw allow proto udp from any to any port "$port" comment "dzpage-panel $id" >/dev/null
      done
      ;;
    ufw:close)
      for port in "${ports[@]}"; do
        ufw --force delete allow proto udp from any to any port "$port" >/dev/null 2>&1 || true
      done
      ;;
    firewalld:open)
      for port in "${ports[@]}"; do
        firewall-cmd --quiet --permanent --add-port="$port/udp"
        firewall-cmd --quiet --add-port="$port/udp"
      done
      ;;
    firewalld:close)
      for port in "${ports[@]}"; do
        firewall-cmd --quiet --permanent --remove-port="$port/udp" >/dev/null 2>&1 || true
        firewall-cmd --quiet --remove-port="$port/udp" >/dev/null 2>&1 || true
      done
      ;;
  esac

  echo "backend=$backend"
  if [ "$backend" != none ]; then
    for port in "${ports[@]}"; do
      fw_is_open "$backend" "$port" && open="$open,$port"
    done
    echo "open=${open#,}"
  fi
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
    firewall-open) cmd_firewall open "$@" ;;
    firewall-close) cmd_firewall close "$@" ;;
    firewall-status) cmd_firewall status "$@" ;;
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
  #
  # Die Unterschale laeuft mit "set -e", die aeussere fuer diesen einen Aufruf
  # ohne: So bricht ein "die" in $(need_id ...) die Operation wirklich ab, ein
  # gescheitertes systemctl meldet seinen Fehlercode, und trotzdem steht danach
  # die Statuszeile da. Bis 0.3.x lief die Unterschale mit "set +e" und
  # meldete jeden Fehler als Erfolg, ungueltige Parameter eingeschlossen.
  # (Nicht als "( ... ) || status=$?": in einem ||-Ausdruck schaltet bash
  # "set -e" auch innerhalb der Unterschale ab.)
  set +e
  # shellcheck disable=SC2086
  ( set -euo pipefail; dispatch $line ) 2>&1
  status=$?
  set -e
  printf '#status:%s\n' "$status"
  exit 0
fi

dispatch "$@"
