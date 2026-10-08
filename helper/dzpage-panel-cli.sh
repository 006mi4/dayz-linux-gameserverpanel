#!/usr/bin/env bash
#
# dzpage-panel: das Panel von der Kommandozeile der Maschine aus.
#
#   sudo dzpage-panel link                    mit dem DZPage-Konto verbinden (Link + Code)
#   sudo dzpage-panel steam-login <konto>     Steam-Anmeldung fuer die Downloads
#   sudo dzpage-panel status                  Dienst, Fassung, Adresse, offener Einrichtungscode
#   sudo dzpage-panel setup-code              Einrichtungscode der lokalen Oberflaeche
#   sudo dzpage-panel reset-password [name]   neues Passwort erzeugen (alle Sitzungen enden)
#   sudo dzpage-panel https enable <domain>   Oberflaeche ueber HTTPS (Caddy, Let's Encrypt)
#   sudo dzpage-panel https disable
#   sudo dzpage-panel logs                    Protokoll des Panels mitlesen
#   sudo dzpage-panel uninstall [--purge]     entfernen
#
# install.sh legt dieses Skript unter /usr/local/sbin ab und setzt die beiden
# Platzhalter fuer die Node-Laufzeit ein, mit der auch der Dienst laeuft.
set -euo pipefail

APP_DIR=/usr/lib/dzpage-panel
CONFIG_DIR=/etc/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
NODE='@NODE@'
NODE_FLAGS='@NODE_FLAGS@'

die() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'; }

# Das Verwaltungsprogramm als Dienstbenutzer: nur der darf Konfiguration und
# Datenbank lesen. Ein- und Ausgabe bleiben am Terminal (Steam fragt dort).
admin() {
  [ -x "$NODE" ] || die "Node-Laufzeit $NODE fehlt. install.sh erneut ausfuehren."
  # shellcheck disable=SC2086
  runuser -u dzpage -- env HOME="$DATA_DIR" TERM="${TERM:-xterm}" "$NODE" $NODE_FLAGS "$APP_DIR/bin/dzpage-panel-admin.js" "$@"
}

[ "$(id -u)" -eq 0 ] || die "Bitte mit sudo aufrufen."

# Nur die oberste Ebene, siehe panel_port in https.sh (MySQL hat einen zweiten "port").
panel_port() {
  local port
  port=$(sed -n 's/^  "port": *\([0-9][0-9]*\).*/\1/p' "$CONFIG_DIR/panel.json" 2>/dev/null | head -1 || true)
  echo "${port:-8410}"
}

cmd_status() {
  local version state domain
  version=$(sed -n 's/.*PANEL_VERSION *= *"\([^"]*\)".*/\1/p' "$APP_DIR/src/version.js" 2>/dev/null | head -1 || true)
  state=$(systemctl is-active dzpage-panel 2>/dev/null || true)
  printf 'Panel:      %s (%s)\n' "${version:-?}" "$state"
  if grep -q '"key": *"dzp_panel_' "$CONFIG_DIR/panel.json" 2>/dev/null; then
    printf 'DZPage:     verbunden\n'
  else
    printf 'DZPage:     nicht verbunden (sudo dzpage-panel link)\n'
  fi
  if [ -f "$CONFIG_DIR/https-domain" ]; then
    domain=$(cat "$CONFIG_DIR/https-domain")
    printf 'Oberfläche: https://%s\n' "$domain"
  else
    printf 'Oberfläche: http://127.0.0.1:%s (nur lokal; von außen per SSH-Tunnel oder "dzpage-panel https enable")\n' "$(panel_port)"
  fi
  if [ -s "$CONFIG_DIR/setup-code" ]; then
    printf 'Einrichtung offen, Code: %s\n' "$(cat "$CONFIG_DIR/setup-code")"
  fi
  printf 'Spielserver: %s\n' "$(systemctl list-units --plain --no-legend 'dzpage-server@*.service' 2>/dev/null | awk '{print $1 " " $4}' | tr '\n' ' ' | sed 's/ $//')"
}

case "${1:-}" in
  status) cmd_status ;;
  setup-code)
    if [ -s "$CONFIG_DIR/setup-code" ]; then
      cat "$CONFIG_DIR/setup-code"
    else
      echo "Kein offener Einrichtungscode: Es gibt schon einen Administrator. Anmelden, oder \"dzpage-panel reset-password\"."
    fi
    ;;
  reset-password) shift; admin reset-password "$@" ;;
  link)
    shift
    set +e
    admin link "$@"
    rc=$?
    set -e
    # Gekoppelt: Herzschlag und Abholer laufen erst mit dem Schluessel los,
    # und den liest der Dienst beim Start.
    [ "$rc" -eq 0 ] && systemctl restart dzpage-panel
    [ "$rc" -eq 3 ] && exit 0
    exit "$rc"
    ;;
  steam-login) shift; admin steam-login "$@" ;;
  https) shift; exec "$APP_DIR/https.sh" "$@" ;;
  logs) exec journalctl -u dzpage-panel -f ;;
  uninstall) shift; exec "$APP_DIR/uninstall.sh" "$@" ;;
  ""|-h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
