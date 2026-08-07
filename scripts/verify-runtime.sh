#!/usr/bin/env bash
#
# Abnahme der systemd-Laufzeit gegen ein echtes systemd — mit einem Ersatz für
# das Spielbinary, weil die Spieldateien ein Steam-Konto mit DayZ brauchen.
#
# Geprüft wird alles, was das Panel selbst verantwortet: eigener Benutzer je
# Server, Ressourcengrenzen, Start, Stopp, Neustart, Wiederbelebung nach einem
# Absturz, Protokoll und das Aufräumen beim Löschen.
#
#   sudo ./scripts/verify-runtime.sh
#
set -uo pipefail
BASE=http://127.0.0.1:8410
JAR=$(mktemp)
PAGE=$(mktemp)
FAILED=0

ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad() { printf '  \033[31mFEHLER\033[0m %s\n' "$*"; FAILED=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

csrf() { grep -oE 'name="_csrf" value="[^"]+"' "$PAGE" | head -1 | sed 's/.*value="//;s/"$//'; }
page() { curl -sS -b "$JAR" -c "$JAR" "$BASE$1" -o "$PAGE" -w '%{http_code}'; }
send() { curl -sS -b "$JAR" -c "$JAR" -X POST "$BASE$1" --data "$2" -o "$PAGE" -w '%{redirect_url}'; }

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen."; exit 1; }

echo "== Assistent bis zum Administrator =="
page /setup/database > /dev/null
send /setup/database "kind=sqlite&action=save&_csrf=$(csrf)" > /dev/null
page /setup/admin > /dev/null
send /setup/admin "username=admin&password=panel-passwort-1&password2=panel-passwort-1&_csrf=$(csrf)" > /dev/null
check "angemeldet" '[ "$(page /servers)" = "200" ]'

echo
echo "== Server anlegen =="
page /servers/new > /dev/null
LOCATION=$(send /servers/new "name=Abnahmeserver&gamePort=2302&queryPort=27016&rconPort=2306&rconPassword=abnahme-geheim&maxPlayers=20&mission=dayzOffline.chernarusplus&memoryMaxMb=512&cpuQuota=100&_csrf=$(csrf)")
ID=$(echo "$LOCATION" | sed 's/.*id=//')
check "Kennung erhalten ($ID)" '[ -n "$ID" ]'
DIR=/var/lib/dzpage-panel/servers/$ID
check "Konfiguration geschrieben" '[ -f "$DIR/serverDZ.cfg" ]'
check "BattlEye-Datei geschrieben" '[ -f "$DIR/profiles/battleye/beserver_x64.cfg" ]'

echo
echo "== Ersatz für das Spielbinary =="
mkdir -p "$DIR/game"
cat > "$DIR/game/DayZServer" <<'STANDIN'
#!/bin/sh
# Steht hier für den echten DayZ-Server: meldet sich, laeuft, reagiert auf
# SIGTERM — und kann auf Wunsch abstuerzen.
echo "Stand-in server started: $*"
echo "user=$(id -un) home=$HOME cwd=$(pwd)"
trap 'echo "SIGTERM erhalten, beende"; exit 0' TERM
while :; do sleep 2; done
STANDIN
chmod +x "$DIR/game/DayZServer"
touch "$DIR/game/steamclient.so"

echo
echo "== Laufzeit einrichten (Benutzer, Grenzen, Rechte) =="
/usr/lib/dzpage-panel/helper.sh prepare "$ID" 512 100 > /dev/null
check "eigener Benutzer dzsrv_$ID existiert" 'id -u dzsrv_$ID >/dev/null 2>&1'
check "Ergänzung mit Grenzwerten liegt vor" '[ -f /etc/systemd/system/dzpage-server@$ID.service.d/panel.conf ]'
grep -q "MemoryMax=512M" "/etc/systemd/system/dzpage-server@$ID.service.d/panel.conf" && ok "MemoryMax gesetzt" || bad "MemoryMax fehlt"
check "Verzeichnis gehört dem Serverbenutzer als Gruppe" '[ "$(stat -c %G "$DIR")" = "dzsrv_'$ID'" ]'
check "Nachbarn nicht lesbar (0751 auf servers/)" '[ "$(stat -c %a /var/lib/dzpage-panel/servers)" = "751" ]'

echo
echo "== Starten =="
send /server/action "id=$ID&action=start&_csrf=$(page /server?id=$ID > /dev/null; csrf)" > /dev/null
sleep 3
STATE=$(systemctl is-active "dzpage-server@$ID")
check "Dienst läuft ($STATE)" '[ "$STATE" = "active" ]'
# ps kuerzt lange Benutzernamen — deshalb ueber die Kennung vergleichen.
RUNUID=$(ps -o uid= -p "$(systemctl show "dzpage-server@$ID" -p MainPID --value)" 2>/dev/null | tr -d ' ')
WANTUID=$(id -u "dzsrv_$ID" 2>/dev/null)
check "läuft als dzsrv_$ID (uid ${RUNUID:-keine} statt ${WANTUID:-?})" '[ -n "$RUNUID" ] && [ "$RUNUID" = "$WANTUID" ]'
MEMMAX=$(systemctl show "dzpage-server@$ID" -p MemoryMax --value)
check "Speichergrenze aktiv ($MEMMAX)" '[ "$MEMMAX" = "536870912" ]'
journalctl -u "dzpage-server@$ID" -n 20 --no-pager | grep -q "Stand-in server started" && ok "Protokoll enthält die Startzeile" || bad "Startzeile fehlt im Protokoll"

echo
echo "== Oberfläche zeigt den Zustand =="
page "/server?id=$ID" > /dev/null
grep -q "running" "$PAGE" && ok "Detailseite zeigt „running“" || bad "Detailseite zeigt nicht „running“"
grep -q "Stand-in server started" "$PAGE" && ok "Detailseite zeigt das Protokoll" || bad "Protokoll fehlt auf der Detailseite"

echo
echo "== Neu starten =="
BEFORE=$(systemctl show "dzpage-server@$ID" -p MainPID --value)
send /server/action "id=$ID&action=restart&_csrf=$(page /server?id=$ID > /dev/null; csrf)" > /dev/null
sleep 3
AFTER=$(systemctl show "dzpage-server@$ID" -p MainPID --value)
check "neue Prozesskennung ($BEFORE → $AFTER)" '[ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]'

echo
echo "== Absturz wird aufgefangen =="
BEFORE_RESTARTS=$(systemctl show "dzpage-server@$ID" -p NRestarts --value)
systemctl kill --signal=SIGKILL "dzpage-server@$ID"
# RestartSec steht auf 10 Sekunden — nicht raten, sondern warten, bis der
# Dienst von selbst wieder da ist.
for _ in $(seq 1 30); do
  sleep 1
  [ "$(systemctl is-active "dzpage-server@$ID")" = "active" ] && break
done
check "Dienst ist von selbst wieder da" '[ "$(systemctl is-active dzpage-server@$ID)" = "active" ]'
RESTARTS=$(systemctl show "dzpage-server@$ID" -p NRestarts --value)
check "systemd hat neu gestartet ($BEFORE_RESTARTS → $RESTARTS)" '[ "${RESTARTS:-0}" -gt "${BEFORE_RESTARTS:-0}" ]'

echo
echo "== Stoppen =="
send /server/action "id=$ID&action=stop&_csrf=$(page /server?id=$ID > /dev/null; csrf)" > /dev/null
sleep 2
check "Dienst gestoppt" '[ "$(systemctl is-active dzpage-server@$ID)" != "active" ]'

echo
echo "== Löschen räumt auf =="
send /server/action "id=$ID&action=delete-confirm&_csrf=$(page /server?id=$ID > /dev/null; csrf)" > /dev/null
sleep 1
check "Benutzer entfernt" '! id -u dzsrv_$ID >/dev/null 2>&1'
check "Ergänzung entfernt" '[ ! -d /etc/systemd/system/dzpage-server@$ID.service.d ]'
check "Spieldateien entfernt" '[ ! -d "$DIR" ]'

rm -f "$JAR" "$PAGE"
echo
if [ "$FAILED" -eq 0 ]; then echo "Alle Prüfungen bestanden."; else echo "Es gab Fehler."; fi
exit "$FAILED"
