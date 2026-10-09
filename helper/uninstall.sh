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
#   --lang <sprache>       Sprache der Ausgaben (sonst die der Installation)
#
# Aufruf als root, ueblicherweise ueber "sudo dzpage-panel uninstall".
set -euo pipefail

APP_DIR=/usr/lib/dzpage-panel
CONFIG_DIR=/etc/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
SYSTEMD_DIR=/etc/systemd/system
CLI=/usr/local/sbin/dzpage-panel
DEFAULT_CHECKOUT=/opt/dzpage-panel
# Das Wort, das die Rueckfrage verlangt, in jeder Sprache dasselbe: so heisst
# der Befehl, den man gerade getippt hat, und Kyrillisch oder Chinesisch muss
# dafuer niemand umschalten. "entfernen" stand bis 0.5.4 dort und gilt weiter.
CONFIRM_WORD=uninstall

# Die Texte werden beim Start ganz gelesen; das Verzeichnis darf danach weg.
if [ -r "$APP_DIR/i18n.sh" ]; then
  # shellcheck source=helper/i18n.sh
  . "$APP_DIR/i18n.sh"
  i18n_init "$APP_DIR/src/i18n/terminal" "$(i18n_arg "$@")"
else
  t() { printf '%s' "$1"; }
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m %s\n' "$(t common.error)" "$*" >&2; exit 1; }

usage() {
  printf '  %-38s %s\n' "sudo dzpage-panel uninstall" "$(t uninstall.help.default)"
  printf '  %-38s %s\n' "sudo dzpage-panel uninstall --purge" "$(t uninstall.help.purge)"
  printf '  %-38s %s\n' "--yes" "$(t uninstall.help.yes)"
}

ARGS=("$@")
PURGE=0
YES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    --lang) case "${2:-}" in ""|-*) ;; *) shift ;; esac ;;
    --lang=*) ;;
    -h|--help) usage; exit 0 ;;
    *) echo "$(t common.unknown_option option="$1")" >&2; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "$(t common.need_root)"

# Dieses Skript liegt in dem Verzeichnis, das es gleich loescht, und bash liest
# Skripte haeppchenweise nach. Also erst eine Kopie ausserhalb starten.
if [ "${DZPANEL_UNINSTALL_RELOCATED:-0}" != "1" ]; then
  copy=$(mktemp /tmp/dzpage-uninstall.XXXXXXXX)
  cat "$0" > "$copy"
  chmod 0700 "$copy"
  DZPANEL_UNINSTALL_RELOCATED=1 exec "$copy" ${ARGS[@]+"${ARGS[@]}"}
fi
trap 'rm -f "$0"' EXIT

if [ "$YES" -ne 1 ]; then
  if [ "$PURGE" -eq 1 ]; then
    printf '\n%s\n' "$(t uninstall.warn_purge)"
  else
    printf '\n%s\n' "$(t uninstall.warn)"
  fi
  printf '%s ' "$(t uninstall.confirm word="$CONFIRM_WORD")"
  answer=""
  read -r answer < /dev/tty || true
  answer=$(printf '%s' "$answer" | tr -d '[:space:]')
  case "$answer" in
    "$CONFIRM_WORD"|entfernen) ;;
    *) die "$(t uninstall.aborted)" ;;
  esac
fi

# Der Arbeitsordner der Git-Installation steht in install.json.
CHECKOUT=$(grep -oE '"checkout": *"[^"]*"' "$CONFIG_DIR/install.json" 2>/dev/null | sed -E 's/.*"([^"]*)"$/\1/' || true)

if [ "$PURGE" -eq 1 ] && [ -x "$CLI" ]; then
  # Gleich verschwindet die Konfiguration mit dem Schluessel. Vorher bei
  # dzpage.com freigeben, sonst bliebe er dort aktiv, ohne dass ihn noch
  # jemand benutzen kann. Nutzt ihn eine andere Maschine, laesst DZPage ihn
  # stehen. Klappt es nicht, geht das Entfernen trotzdem weiter.
  say "$(t uninstall.key)"
  released=$(timeout 40 "$CLI" forget-key 2>&1 || true)
  printf '%s\n' "${released:-$(t uninstall.no_answer)}" | sed 's/^/  /'
fi

say "$(t uninstall.stop_panel)"
systemctl disable --now dzpage-panel.service >/dev/null 2>&1 || true
systemctl disable --now dzpage-panel-helper.socket >/dev/null 2>&1 || true
note "$(t uninstall.panel_stopped)"

say "$(t uninstall.stop_servers)"
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
  note "$(t uninstall.server_stopped id="$id")"
done
if command -v docker >/dev/null 2>&1; then
  # Nur echte Kennungen: Ohne laufenden Dienst schreiben manche docker-Programme
  # (etwa der Platzhalter von Docker Desktop unter WSL) Hinweistext auf stdout.
  containers=$(docker ps -aq --filter label=dzpage-panel=server 2>/dev/null | grep -E '^[0-9a-f]{12,64}$' || true)
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086
    docker rm -f $containers >/dev/null 2>&1 || true
    note "$(t uninstall.containers)"
  fi
fi

say "$(t uninstall.firewall)"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
  # Von hinten loeschen: jede Loeschung verschiebt die Nummern dahinter.
  # "|| true": Ohne Regeln des Panels findet grep nichts, und unter set -e und
  # pipefail brach die Deinstallation genau hier stumm ab (im Test gesehen).
  numbers=$(ufw status numbered 2>/dev/null | grep '# dzpage-panel' | sed -nE 's/^\[ *([0-9]+)\].*/\1/p' | sort -rn || true)
  for n in $numbers; do ufw --force delete "$n" >/dev/null 2>&1 || true; done
  note "$(t uninstall.ufw)"
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
  note "$(t uninstall.firewalld)"
else
  note "$(t uninstall.no_firewall)"
fi

# Auch nach einem abgebrochenen "https enable" aufraeumen: Dann fehlt
# vielleicht der Merker, aber Seite oder Unit-Ergaenzung sind schon da.
if [ -x "$APP_DIR/https.sh" ] && { [ -f "$CONFIG_DIR/https-domain" ] || [ -f /etc/caddy/dzpage-panel.caddy ] \
  || [ -f "$SYSTEMD_DIR/dzpage-panel.service.d/https.conf" ]; }; then
  say "$(t uninstall.https)"
  "$APP_DIR/https.sh" disable >/dev/null 2>&1 || true
  note "$(t uninstall.https_removed)"
fi

say "$(t uninstall.services)"
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
note "$(t uninstall.services_removed)"

if [ -n "$CHECKOUT" ] && command -v git >/dev/null 2>&1; then
  git config --system --unset-all safe.directory "^$(printf '%s' "$CHECKOUT" | sed 's/[.[\*^$/]/\\&/g')\$" >/dev/null 2>&1 || true
fi
rm -rf "$APP_DIR" "$CLI"
# Nur den eigenen Standardordner loeschen: einen Klon an anderer Stelle hat
# jemand bewusst dort angelegt.
if [ "$CHECKOUT" = "$DEFAULT_CHECKOUT" ]; then
  rm -rf "$DEFAULT_CHECKOUT"
fi
note "$(t uninstall.program_removed)"

if [ "$PURGE" -eq 1 ]; then
  say "$(t uninstall.data)"
  rm -rf "$DATA_DIR" "$CONFIG_DIR"
  userdel dzpage >/dev/null 2>&1 || true
  note "$(t uninstall.data_removed data="$DATA_DIR" config="$CONFIG_DIR")"
else
  say "$(t uninstall.kept)"
  note "$(t uninstall.kept_data dir="$DATA_DIR")"
  note "$(t uninstall.kept_config dir="$CONFIG_DIR")"
  note "$(t uninstall.kept_user)"
  note "$(t uninstall.kept_key)"
  note "$(t uninstall.kept_reinstall)"
  note "$(t uninstall.kept_manual data="$DATA_DIR" config="$CONFIG_DIR")"
fi

say "$(t uninstall.done)"
