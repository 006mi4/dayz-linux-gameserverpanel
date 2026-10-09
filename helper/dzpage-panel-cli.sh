#!/usr/bin/env bash
#
# dzpage-panel: das Panel von der Kommandozeile der Maschine aus.
#
#   sudo dzpage-panel link                    mit dem DZPage-Konto verbinden (Link + Code)
#   sudo dzpage-panel steam-login <konto>     Steam-Anmeldung fuer die Downloads
#   sudo dzpage-panel status                  Dienst, Fassung, DZPage-Verbindung, Adresse, Code
#   sudo dzpage-panel setup-code              Einrichtungscode der lokalen Oberflaeche
#   sudo dzpage-panel reset-password [name]   neues Passwort erzeugen (alle Sitzungen enden)
#   sudo dzpage-panel https enable <domain>   Oberflaeche ueber HTTPS (Caddy, Let's Encrypt)
#   sudo dzpage-panel https disable
#   sudo dzpage-panel logs                    Protokoll des Panels mitlesen
#   sudo dzpage-panel uninstall [--purge]     entfernen
#
#   sudo dzpage-panel language [<sprache>]    Sprache anzeigen oder dauerhaft umstellen
#   sudo dzpage-panel --lang <sprache> ...    Ausgaben in dieser Sprache, nur fuer
#                                             diesen Aufruf (sonst die der Installation)
#
# install.sh legt dieses Skript unter /usr/local/sbin ab und setzt die beiden
# Platzhalter fuer die Node-Laufzeit ein, mit der auch der Dienst laeuft.
set -euo pipefail

APP_DIR=/usr/lib/dzpage-panel
CONFIG_DIR=/etc/dzpage-panel
DATA_DIR=/var/lib/dzpage-panel
NODE='@NODE@'
NODE_FLAGS='@NODE_FLAGS@'

LANG_ARG=""
LANG_GIVEN=0
case "${1:-}" in
  --lang) LANG_GIVEN=1; LANG_ARG=${2:-}; shift; [ "$#" -eq 0 ] || shift ;;
  --lang=*) LANG_GIVEN=1; LANG_ARG=${1#--lang=}; shift ;;
esac

if [ -r "$APP_DIR/i18n.sh" ]; then
  # shellcheck source=helper/i18n.sh
  . "$APP_DIR/i18n.sh"
  i18n_init "$APP_DIR/src/i18n/terminal" "$LANG_ARG"
  [ -z "$I18N_REJECTED" ] \
    || printf '%s\n' "$(t common.lang_unknown lang="$I18N_REJECTED" locales="${I18N_LOCALES// /, }")" >&2
else
  t() { printf '%s' "$1"; }
  I18N_LOCALE=en
  I18N_LOCALES=en
fi

die() { printf '%s %s\n' "$(t common.error)" "$*" >&2; exit 1; }

usage() {
  printf '%s\n\n' "$(t cli.help.title)"
  printf '  %-40s %s\n' "sudo dzpage-panel link" "$(t cli.help.link)"
  printf '  %-40s %s\n' "sudo dzpage-panel steam-login <account>" "$(t cli.help.steam_login)"
  printf '  %-40s %s\n' "sudo dzpage-panel status" "$(t cli.help.status)"
  printf '  %-40s %s\n' "sudo dzpage-panel setup-code" "$(t cli.help.setup_code)"
  printf '  %-40s %s\n' "sudo dzpage-panel reset-password [name]" "$(t cli.help.reset_password)"
  printf '  %-40s %s\n' "sudo dzpage-panel https enable <domain>" "$(t cli.help.https_enable)"
  printf '  %-40s %s\n' "sudo dzpage-panel https disable" "$(t cli.help.https_disable)"
  printf '  %-40s %s\n' "sudo dzpage-panel logs" "$(t cli.help.logs)"
  printf '  %-40s %s\n' "sudo dzpage-panel uninstall [--purge]" "$(t cli.help.uninstall)"
  printf '  %-40s %s\n' "sudo dzpage-panel language [<code>]" "$(t cli.help.language)"
  printf '\n%s\n' "$(t cli.help.lang locales="${I18N_LOCALES// /, }")"
}

# Das Verwaltungsprogramm als Dienstbenutzer: nur der darf Konfiguration und
# Datenbank lesen. Ein- und Ausgabe bleiben am Terminal (Steam fragt dort).
# Protokollzeilen fuer journald ("[info] Datenbank auf Stand 1 ...") haben im
# Terminal nichts verloren; Warnungen und Fehler schon.
admin() {
  [ -x "$NODE" ] || die "$(t cli.node_missing node="$NODE")"
  # shellcheck disable=SC2086
  runuser -u dzpage -- env HOME="$DATA_DIR" TERM="${TERM:-xterm}" DZPAGE_PANEL_LANG="$I18N_LOCALE" \
    DZPAGE_PANEL_LOG_LEVEL="${DZPAGE_PANEL_LOG_LEVEL:-warn}" \
    "$NODE" $NODE_FLAGS "$APP_DIR/bin/dzpage-panel-admin.js" "$@"
}

[ "$(id -u)" -eq 0 ] || die "$(t common.need_root)"

# Nur die oberste Ebene, siehe panel_port in https.sh (MySQL hat einen zweiten "port").
panel_port() {
  local port
  port=$(sed -n 's/^  "port": *\([0-9][0-9]*\).*/\1/p' "$CONFIG_DIR/panel.json" 2>/dev/null | head -1 || true)
  echo "${port:-8410}"
}

# Beschriftung links, Werte untereinander. Gemessen wird die Breite im
# Terminal, nicht die Zeichenzahl: Chinesische Zeichen belegen zwei Spalten.
# wc -L rechnet so, wenn es UTF-8 versteht; C.UTF-8 gibt es auf Debian und
# Ubuntu immer, egal was LANG sagt.
STATUS_WIDTH=0
columns() { printf '%s\n' "$1" | LC_ALL=C.UTF-8 wc -L; }
row() {
  printf '%s%*s %s\n' "$1" $((STATUS_WIDTH - $(columns "$1"))) '' "$2"
}

cmd_status() {
  local version state domain dzpage label
  for label in "$(t cli.status.panel)" "$(t cli.status.dzpage)" "$(t cli.status.ui)" "$(t cli.status.servers)"; do
    [ "$(columns "$label")" -le "$STATUS_WIDTH" ] || STATUS_WIDTH=$(columns "$label")
  done
  version=$(sed -n 's/.*PANEL_VERSION *= *"\([^"]*\)".*/\1/p' "$APP_DIR/src/version.js" 2>/dev/null | head -1 || true)
  state=$(systemctl is-active dzpage-panel 2>/dev/null || true)
  row "$(t cli.status.panel)" "${version:-?} ($state)"
  # Ein Schluessel in panel.json heisst noch nicht verbunden: Ob DZPage ihn
  # annimmt (letzter Herzschlag) oder abgelehnt hat, steht in der Datenbank.
  # Protokollzeilen des Verwaltungsprogramms beginnen mit "[".
  dzpage=$(admin dzpage-status 2>/dev/null | grep -v '^\[' | tail -n 1 || true)
  if [ -z "$dzpage" ]; then
    if grep -q '"key": *"dzp_panel_' "$CONFIG_DIR/panel.json" 2>/dev/null; then
      dzpage=$(t cli.status.key_unreadable)
    else
      dzpage=$(t cli.status.not_linked)
    fi
  fi
  row "$(t cli.status.dzpage)" "$dzpage"
  if [ -f "$CONFIG_DIR/https-domain" ]; then
    domain=$(cat "$CONFIG_DIR/https-domain")
    row "$(t cli.status.ui)" "https://$domain"
  else
    row "$(t cli.status.ui)" "$(t cli.status.ui_local port="$(panel_port)")"
  fi
  if [ -s "$CONFIG_DIR/setup-code" ]; then
    printf '%s %s\n' "$(t cli.status.setup)" "$(cat "$CONFIG_DIR/setup-code")"
  fi
  row "$(t cli.status.servers)" "$(systemctl list-units --plain --no-legend 'dzpage-server@*.service' 2>/dev/null | awk '{print $1 " " $4}' | tr '\n' ' ' | sed 's/ $//')"
}

# Sprache dauerhaft umstellen: "lang" in install.json, ohne install.sh neu
# laufen zu lassen (das setzte die gemerkten Optionen auf die eben genannten).
# Gelesen als Dienstbenutzer, weil die Datei in seinem Verzeichnis liegt;
# geschrieben wie in install.sh: Nebendatei in /etc, die root gehoert, dann
# "mv -T", das keinem Verweis folgt.
cmd_language() {
  local wanted json tmp
  declare -F i18n_normalize >/dev/null || die "$(t cli.language_failed)"
  if [ -z "${1:-}" ]; then
    printf '%s\n' "$(t cli.language_current lang="$(i18n_name "$I18N_LOCALE") ($I18N_LOCALE)" locales="${I18N_LOCALES// /, }")"
    return 0
  fi
  wanted=$(i18n_normalize "$1")
  [ -n "$wanted" ] || die "$(t common.lang_unknown lang="$1" locales="${I18N_LOCALES// /, }")"
  [ -x "$NODE" ] || die "$(t cli.node_missing node="$NODE")"
  json=$(setpriv --reuid=dzpage --regid=dzpage --clear-groups -- \
    timeout 5 head -c 65536 "$CONFIG_DIR/install.json" 2>/dev/null || true)
  [ -n "$json" ] || die "$(t cli.language_no_install)"
  tmp=$(mktemp "$(dirname "$CONFIG_DIR")/.dzpage-panel-install.json.XXXXXX") || die "$(t cli.language_failed)"
  # shellcheck disable=SC2086
  if printf '%s' "$json" | "$NODE" $NODE_FLAGS -e '
      const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) process.exit(1);
      data.lang = process.argv[1];
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    ' "$wanted" > "$tmp" 2>/dev/null && chmod 0644 "$tmp" && mv -fT "$tmp" "$CONFIG_DIR/install.json"; then
    i18n_init "$APP_DIR/src/i18n/terminal" "$wanted"
    printf '%s\n' "$(t cli.language_set lang="$(i18n_name "$wanted")")"
  else
    rm -f "$tmp"
    die "$(t cli.language_failed)"
  fi
}

# "--lang" ohne Befehl dahinter ist ein Tippfehler ("--lang status"), keine Bitte um Hilfe.
if [ "$LANG_GIVEN" -eq 1 ] && [ -z "${1:-}" ]; then
  usage >&2
  exit 2
fi

case "${1:-}" in
  status) cmd_status ;;
  language) shift; cmd_language "$@" ;;
  setup-code)
    if [ -s "$CONFIG_DIR/setup-code" ]; then
      cat "$CONFIG_DIR/setup-code"
    else
      printf '%s\n' "$(t cli.setup_code_none)"
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
    # und den liest der Dienst beim Start. 3 heisst schon gekoppelt; 4 (an
    # der Kontofrage verneint) geht unveraendert an install.sh weiter.
    [ "$rc" -eq 0 ] && systemctl restart dzpage-panel
    [ "$rc" -eq 3 ] && exit 0
    exit "$rc"
    ;;
  steam-login) shift; admin steam-login "$@" ;;
  # Fuer uninstall --purge: den Schluessel bei dzpage.com freigeben, bevor die
  # Konfiguration verschwindet. Kein Befehl fuer Menschen, deshalb nicht in usage.
  forget-key) admin forget-key ;;
  https) shift; exec "$APP_DIR/https.sh" "$@" ;;
  logs) exec journalctl -u dzpage-panel -f ;;
  uninstall) shift; exec "$APP_DIR/uninstall.sh" "$@" ;;
  ""|-h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
