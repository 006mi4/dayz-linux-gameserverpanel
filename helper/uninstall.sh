#!/usr/bin/env bash
#
# Entfernt das DZPage Panel von dieser Maschine.
#
#   uninstall.sh           Programm, Dienste, Spielserver-Dienste und ihre
#                          Benutzer weg. Spieldateien, Speicherstaende,
#                          Datenbank und Konfiguration bleiben liegen.
#   uninstall.sh --purge   zusaetzlich /var/lib/dzpage-panel und /etc/dzpage-panel
#                          samt Dienstbenutzer. Nicht umkehrbar.
#   --yes                  ohne Rueckfrage
#
# Aufruf als root, ueblicherweise ueber "sudo dzpage-panel uninstall".
set -euo pipefail

APP_DIR=/usr/lib/dzpage-panel
CONFIG_DIR=/etc/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
SYSTEMD_DIR=/etc/systemd/system
CLI=/usr/local/sbin/dzpage-panel
DEFAULT_CHECKOUT=/opt/dzpage-panel

PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo)."

# Dieses Skript liegt in dem Verzeichnis, das es gleich loescht, und bash liest
# Skripte haeppchenweise nach. Also erst eine Kopie ausserhalb starten.
if [ "${DZPANEL_UNINSTALL_RELOCATED:-0}" != "1" ]; then
  copy=$(mktemp /tmp/dzpage-uninstall.XXXXXXXX)
  cat "$0" > "$copy"
  chmod 0700 "$copy"
  DZPANEL_UNINSTALL_RELOCATED=1 exec "$copy" "$@"
fi
trap 'rm -f "$0"' EXIT

if [ "$YES" -ne 1 ]; then
  if [ "$PURGE" -eq 1 ]; then
    printf '\nDas entfernt das Panel UND alle Spielserver samt Speicherstaenden und Datenbank.\n'
  else
    printf '\nDas entfernt das Panel und die Dienste der Spielserver. Daten und Konfiguration bleiben liegen.\n'
  fi
  printf 'Zum Bestaetigen "entfernen" eintippen: '
  answer=""
  read -r answer < /dev/tty || true
  [ "$answer" = "entfernen" ] || die "Abgebrochen, nichts geaendert."
fi

# Der Arbeitsordner der Git-Installation steht in install.json.
CHECKOUT=$(grep -oE '"checkout": *"[^"]*"' "$CONFIG_DIR/install.json" 2>/dev/null | sed -E 's/.*"([^"]*)"$/\1/' || true)

say "Panel anhalten"
systemctl disable --now dzpage-panel.service >/dev/null 2>&1 || true
systemctl disable --now dzpage-panel-helper.socket >/dev/null 2>&1 || true
note "Panel und Helfer gestoppt"

say "Spielserver anhalten"
ids=""
for dir in "$SYSTEMD_DIR"/dzpage-server@*.service.d; do
  [ -d "$dir" ] || continue
  id=${dir##*/dzpage-server@}
  id=${id%.service.d}
  [[ "$id" =~ ^[a-f0-9]{12}$ ]] && ids="$ids $id"
done
for unit in $(systemctl list-units --all --plain --no-legend 'dzpage-server@*.service' 2>/dev/null | awk '{print $1}'); do
  id=${unit#dzpage-server@}
  id=${id%.service}
  [[ "$id" =~ ^[a-f0-9]{12}$ ]] && ids="$ids $id"
done
ids=$(printf '%s\n' $ids | sort -u | tr '\n' ' ')
for id in $ids; do
  systemctl disable --now "dzpage-server@$id.service" >/dev/null 2>&1 || true
  rm -rf "${SYSTEMD_DIR:?}/dzpage-server@$id.service.d"
  note "dzpage-server@$id gestoppt"
done
if command -v docker >/dev/null 2>&1; then
  # Nur echte Kennungen: Ohne laufenden Dienst schreiben manche docker-Programme
  # (etwa der Platzhalter von Docker Desktop unter WSL) Hinweistext auf stdout.
  containers=$(docker ps -aq --filter label=dzpage-panel=server 2>/dev/null | grep -E '^[0-9a-f]{12,64}$' || true)
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086
    docker rm -f $containers >/dev/null 2>&1 || true
    note "Docker-Container der Spielserver entfernt"
  fi
fi

say "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
  # Von hinten loeschen: jede Loeschung verschiebt die Nummern dahinter.
  # "|| true": Ohne Regeln des Panels findet grep nichts, und unter set -e und
  # pipefail brach die Deinstallation genau hier stumm ab (im Test gesehen).
  numbers=$(ufw status numbered 2>/dev/null | grep '# dzpage-panel' | sed -nE 's/^\[ *([0-9]+)\].*/\1/p' | sort -rn || true)
  for n in $numbers; do ufw --force delete "$n" >/dev/null 2>&1 || true; done
  note "ufw: Regeln des Panels entfernt"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  # firewalld kennt keine Kommentare; die Ports stehen in den Serverdateien.
  # Den RCon-Port in allen BattlEye-Dateien suchen: BattlEye benennt die
  # gelesene beim Start in beserver_x64_active_*.cfg um.
  for dir in "$DATA_DIR"/servers/*/; do
    [ -f "$dir/server.env" ] || continue
    for port in $(grep -hoE '^DZ_(PORT|QUERY_PORT)=[0-9]+' "$dir/server.env" | cut -d= -f2) \
                $(cat "$dir"/profiles/battleye/*.cfg 2>/dev/null | grep -oiE '^RConPort +[0-9]+' | grep -oE '[0-9]+$' | sort -u); do
      firewall-cmd --quiet --permanent --remove-port="$port/udp" >/dev/null 2>&1 || true
      firewall-cmd --quiet --remove-port="$port/udp" >/dev/null 2>&1 || true
    done
  done
  note "firewalld: Ports der Spielserver entfernt"
else
  note "keine lokale Firewall aktiv"
fi

# Auch nach einem abgebrochenen "https enable" aufraeumen: Dann fehlt
# vielleicht der Merker, aber Seite oder Unit-Ergaenzung sind schon da.
if [ -x "$APP_DIR/https.sh" ] && { [ -f "$CONFIG_DIR/https-domain" ] || [ -f /etc/caddy/dzpage-panel.caddy ] \
  || [ -f "$SYSTEMD_DIR/dzpage-panel.service.d/https.conf" ]; }; then
  say "HTTPS"
  "$APP_DIR/https.sh" disable >/dev/null 2>&1 || true
  note "Caddy-Seite des Panels entfernt (Caddy selbst bleibt installiert)"
fi

say "Dienste und Programm"
rm -f "$SYSTEMD_DIR/dzpage-panel.service" \
      "$SYSTEMD_DIR/dzpage-server@.service" \
      "$SYSTEMD_DIR/dzpage-panel-helper.socket" \
      "$SYSTEMD_DIR/dzpage-panel-helper@.service"
rm -rf "$SYSTEMD_DIR/dzpage-panel.service.d"
rm -f /etc/sudoers.d/dzpage-panel
systemctl daemon-reload
systemctl reset-failed 'dzpage-*' >/dev/null 2>&1 || true

for user in $(getent passwd | cut -d: -f1 | grep -E '^dzsrv_[a-f0-9]{12}$' || true); do
  userdel "$user" >/dev/null 2>&1 || true
done
note "Dienste und Serverbenutzer entfernt"

if [ -n "$CHECKOUT" ] && command -v git >/dev/null 2>&1; then
  git config --system --unset-all safe.directory "^$(printf '%s' "$CHECKOUT" | sed 's/[.[\*^$/]/\\&/g')\$" >/dev/null 2>&1 || true
fi
rm -rf "$APP_DIR" "$CLI"
# Nur den eigenen Standardordner loeschen: einen Klon an anderer Stelle hat
# jemand bewusst dort angelegt.
if [ "$CHECKOUT" = "$DEFAULT_CHECKOUT" ]; then
  rm -rf "$DEFAULT_CHECKOUT"
fi
note "Programm entfernt"

if [ "$PURGE" -eq 1 ]; then
  say "Daten"
  rm -rf "$DATA_DIR" "$CONFIG_DIR"
  userdel dzpage >/dev/null 2>&1 || true
  note "$DATA_DIR, $CONFIG_DIR und der Benutzer dzpage sind entfernt"
else
  say "Geblieben"
  note "$DATA_DIR (Spieldateien, Speicherstaende, Datenbank)"
  note "$CONFIG_DIR (Konfiguration mit den Schluesseln, ohne die die Datenbank nutzlos ist)"
  note "Benutzer dzpage"
  note "Eine neue Installation setzt dort wieder auf. Alles loeschen: Panel neu installieren und mit --purge entfernen,"
  note "oder von Hand: sudo rm -rf $DATA_DIR $CONFIG_DIR && sudo userdel dzpage"
fi

say "Fertig"
