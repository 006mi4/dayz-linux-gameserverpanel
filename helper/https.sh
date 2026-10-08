#!/usr/bin/env bash
#
# HTTPS fuer die Oberflaeche des Panels, ueber Caddy.
#
#   https.sh enable <domain>   Caddy einrichten, Zertifikat von Let's Encrypt
#   https.sh disable           wieder abbauen (Caddy selbst bleibt installiert)
#   https.sh status
#
# Aufruf als root, ueber install.sh --domain oder "sudo dzpage-panel https".
#
# Das Panel selbst bleibt auf 127.0.0.1. Caddy nimmt die Verbindungen auf 443
# an, holt und erneuert das Zertifikat selbst und reicht an das Panel weiter.
# Das Panel erfaehrt ueber eine Ergaenzung seiner Unit, dass ein Proxy
# davorsteht: ohne das saehe es jede Anfrage als http von 127.0.0.1, und die
# Herkunftspruefung wiese jedes Formular ab.
#
# Fremde Webserver werden nicht angefasst. Belegt schon etwas anderes Port 80
# oder 443, bricht das Skript ab und sagt, was stattdessen zu tun ist.
set -euo pipefail

CONFIG_DIR=/etc/dzpage-panel
DOMAIN_FILE=$CONFIG_DIR/https-domain
SITE=/etc/caddy/dzpage-panel.caddy
CADDYFILE=/etc/caddy/Caddyfile
IMPORT_LINE="import $SITE"
MARK="# Eingerichtet von dzpage-panel"
DROPIN_DIR=/etc/systemd/system/dzpage-panel.service.d
DROPIN=$DROPIN_DIR/https.conf
UFW_COMMENT="dzpage-panel https"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33mAchtung:\033[0m %s\n' "$*"; }
die() { printf '\n\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo)."

# Nur der Schluessel der obersten Ebene: panel.json schreibt das Panel mit zwei
# Leerzeichen Einzug, und bei MySQL steht unter "database" ein zweiter "port"
# (3306). Ohne diese Einschraenkung kamen beide Zahlen heraus.
panel_port() {
  local port
  port=$(sed -n 's/^  "port": *\([0-9][0-9]*\).*/\1/p' "$CONFIG_DIR/panel.json" 2>/dev/null | head -1 || true)
  echo "${port:-8410}"
}

valid_domain() {
  local d=$1
  [ "${#d}" -le 253 ] && [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

# Was ausser Caddy auf 80 oder 443 lauscht. Leer heisst: frei.
foreign_listeners() {
  ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    note "Caddy ist schon da ($(caddy version 2>/dev/null | cut -d' ' -f1))"
    return
  fi
  command -v apt-get >/dev/null 2>&1 \
    || die "Caddy fehlt, und ohne apt kann ich es nicht installieren. Anleitung: https://caddyserver.com/docs/install"
  note "installiere Caddy aus dem offiziellen Paketarchiv"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq gnupg curl ca-certificates >/dev/null
  # Die Befehle stehen so in https://caddyserver.com/docs/install (Debian, Ubuntu).
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  note "$(caddy version 2>/dev/null | cut -d' ' -f1) installiert"
}

# Die Paketfassung der Caddyfile liefert nur die Willkommensseite auf :80 aus.
# Die darf ersetzt werden; alles andere hat jemand geschrieben und bleibt.
is_package_caddyfile() {
  [ -f "$CADDYFILE" ] || return 1
  grep -q '^:80 {' "$CADDYFILE" || return 1
  grep -q 'root \* /usr/share/caddy' "$CADDYFILE" || return 1
  [ "$(grep -cvE '^[[:space:]]*(#|$)' "$CADDYFILE")" -le 6 ]
}

# Die Caddyfile, wie sie mit dem Import aussaehe, in eine Kandidatendatei.
# Erst wenn Caddy sie annimmt, ersetzt sie die echte: Eine Caddyfile mit einem
# kaputten Import legte beim naechsten Neustart von Caddy auch alle anderen
# Seiten auf dieser Maschine lahm.
candidate_caddyfile() {
  local out=$1
  if [ ! -f "$CADDYFILE" ] || is_package_caddyfile; then
    printf '%s. Eigene Seiten koennen hier dazukommen.\n%s\n' "$MARK" "$IMPORT_LINE" > "$out"
  else
    cat "$CADDYFILE" > "$out"
    grep -qxF "$IMPORT_LINE" "$out" || printf '\n%s\n%s\n' "$MARK" "$IMPORT_LINE" >> "$out"
  fi
}

remove_import() {
  [ -f "$CADDYFILE" ] || return 0
  local tmp
  tmp=$(mktemp)
  grep -vxF "$IMPORT_LINE" "$CADDYFILE" | grep -v "^$MARK" > "$tmp" || true
  cat "$tmp" > "$CADDYFILE"
  rm -f "$tmp"
}

firewall_web() {
  local action=$1
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
    for port in 80 443; do
      if [ "$action" = open ]; then
        ufw allow "$port/tcp" comment "$UFW_COMMENT" >/dev/null
      else
        ufw --force delete allow "$port/tcp" >/dev/null 2>&1 || true
      fi
    done
    note "ufw: 80/tcp und 443/tcp $([ "$action" = open ] && echo freigegeben || echo entfernt)"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    for service in http https; do
      if [ "$action" = open ]; then
        firewall-cmd --quiet --permanent --add-service="$service"
        firewall-cmd --quiet --add-service="$service"
      else
        firewall-cmd --quiet --permanent --remove-service="$service" >/dev/null 2>&1 || true
        firewall-cmd --quiet --remove-service="$service" >/dev/null 2>&1 || true
      fi
    done
    note "firewalld: http und https $([ "$action" = open ] && echo freigegeben || echo entfernt)"
  fi
}

panel_proxy_mode() {
  local on=$1
  if [ "$on" = 1 ]; then
    install -d -m 0755 "$DROPIN_DIR"
    printf '# Von dzpage-panel (https.sh) erzeugt: Caddy steht davor.\n[Service]\nEnvironment=DZPAGE_PANEL_TRUST_PROXY=1\n' \
      > "$DROPIN"
    chmod 0644 "$DROPIN"
  else
    rm -f "$DROPIN"
    rmdir "$DROPIN_DIR" 2>/dev/null || true
  fi
  systemctl daemon-reload
  # try-restart, nicht restart: Bei der Deinstallation ist das Panel schon
  # angehalten, und dieser Schritt darf es nicht wieder aufwecken.
  systemctl try-restart dzpage-panel
}

# Zeigt die Domain auf diese Maschine? Nur ein Hinweis: hinter NAT stehen hier
# private Adressen, und dann stimmt es trotzdem.
check_dns() {
  local domain=$1 resolved locals ip
  # "|| true": Eine Domain, die noch nicht aufloest, ist hier der haeufigste
  # Fall; unter set -e und pipefail beendete getent sonst das ganze Skript.
  resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | xargs || true)
  if [ -z "$resolved" ]; then
    warn "$domain zeigt noch auf keine Adresse. Erst beim DNS-Anbieter einen A-Eintrag auf diese Maschine setzen; Caddy versucht es so lange weiter."
    return
  fi
  locals=$(hostname -I 2>/dev/null | xargs || true)
  for ip in $resolved; do
    case " $locals " in *" $ip "*) note "$domain zeigt auf $ip, das ist diese Maschine"; return ;; esac
  done
  note "$domain zeigt auf $resolved, diese Maschine hat ${locals:-keine erkennbare Adresse}."
  note "Hinter NAT ist das normal. Sonst bekommt Caddy kein Zertifikat, bis der DNS-Eintrag stimmt."
}

wait_for_https() {
  local domain=$1 insecure=()
  # .localhost-Namen bekommen von Caddy ein Zertifikat der eigenen, lokalen
  # Stelle; das kennt curl nicht. Nur fuer Tests auf der eigenen Maschine.
  [[ "$domain" == *.localhost ]] && insecure=(-k)
  for _ in $(seq 1 45); do
    if curl -fsS "${insecure[@]}" --max-time 5 "https://$domain/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd_enable() {
  local domain=${1:-}
  domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
  valid_domain "$domain" || die "\"$1\" ist kein gueltiger Domainname (zum Beispiel panel.example.com)."
  systemctl cat dzpage-panel.service >/dev/null 2>&1 || die "Das Panel ist hier nicht installiert."

  say "HTTPS fuer $domain"
  local foreign
  foreign=$(foreign_listeners)
  if [ -n "$foreign" ]; then
    printf '%s\n' "$foreign" | sed 's/^/    /'
    die "Port 80 oder 443 ist schon von einem anderen Webserver belegt. Den kann ich nicht ersetzen. Stattdessen dort einen Reverse-Proxy auf http://127.0.0.1:$(panel_port) einrichten und in der Panel-Unit DZPAGE_PANEL_TRUST_PROXY=1 setzen (README, Abschnitt \"Von aussen erreichbar machen\")."
  fi

  # Mit Proxy glaubt das Panel den Kopfzeilen X-Forwarded-*. Das ist nur
  # richtig, solange ausser Caddy niemand direkt an den Port kommt.
  local bind
  bind=$(sed -n 's/^  "bind": *"\([^"]*\)".*/\1/p' "$CONFIG_DIR/panel.json" 2>/dev/null | head -1 || true)
  case "${bind:-127.0.0.1}" in
    127.0.0.1|::1|localhost) ;;
    *) die "Das Panel lauscht auf $bind. Hinter Caddy muss es auf 127.0.0.1 stehen (\"bind\" in $CONFIG_DIR/panel.json), sonst koennte jeder die Proxy-Angaben faelschen." ;;
  esac

  check_dns "$domain"
  install_caddy

  install -d -m 0755 /etc/caddy
  # Vorherige Seite merken, damit ein Fehlschlag sie zurueckbringt.
  local previous_site="" candidate
  [ -f "$SITE" ] && previous_site=$(cat "$SITE")
  cat > "$SITE" <<EOF
# Von dzpage-panel erzeugt (https.sh). Wird bei jeder Aenderung ueberschrieben.
$domain {
	encode gzip
	reverse_proxy 127.0.0.1:$(panel_port)
}
EOF
  chmod 0644 "$SITE"
  candidate=$(mktemp /etc/caddy/.Caddyfile.dzpage.XXXXXX)
  candidate_caddyfile "$candidate"
  if ! caddy validate --config "$candidate" --adapter caddyfile >/dev/null 2>&1; then
    caddy validate --config "$candidate" --adapter caddyfile 2>&1 | tail -5 | sed 's/^/    /' || true
    rm -f "$candidate"
    if [ -n "$previous_site" ]; then printf '%s\n' "$previous_site" > "$SITE"; else rm -f "$SITE"; fi
    die "Caddy lehnt die Konfiguration ab (siehe oben). Nichts geaendert."
  fi
  chmod 0644 "$candidate"
  mv "$candidate" "$CADDYFILE"

  # Ab hier ist etwas eingerichtet: Den Merker zuerst schreiben, damit
  # "https disable" und die Deinstallation aufraeumen, auch wenn ein spaeterer
  # Schritt scheitert.
  printf '%s\n' "$domain" > "$DOMAIN_FILE"
  chmod 0644 "$DOMAIN_FILE"
  firewall_web open
  panel_proxy_mode 1
  systemctl enable --quiet caddy
  systemctl reload-or-restart caddy

  note "warte auf das Zertifikat (bis zu 90 Sekunden)"
  if wait_for_https "$domain"; then
    note "Oberflaeche: https://$domain"
  else
    warn "https://$domain antwortet noch nicht. Haeufigste Gruende: der DNS-Eintrag zeigt noch nicht hierher, oder eine Firewall beim Hoster sperrt 80/443. Caddy versucht es selbst weiter; Protokoll: journalctl -u caddy -e"
  fi
}

cmd_disable() {
  say "HTTPS abbauen"
  local domain=""
  [ -f "$DOMAIN_FILE" ] && domain=$(cat "$DOMAIN_FILE")
  rm -f "$SITE"
  remove_import
  if systemctl is-active --quiet caddy 2>/dev/null; then
    systemctl reload-or-restart caddy || true
  fi
  firewall_web close
  panel_proxy_mode 0
  rm -f "$DOMAIN_FILE"
  note "${domain:-HTTPS} abgebaut. Die Oberflaeche ist wieder nur ueber 127.0.0.1 erreichbar."
}

cmd_status() {
  if [ -f "$DOMAIN_FILE" ]; then
    echo "https://$(cat "$DOMAIN_FILE")"
  else
    echo "aus"
  fi
}

case "${1:-}" in
  enable) shift; cmd_enable "$@" ;;
  disable) cmd_disable ;;
  status) cmd_status ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
