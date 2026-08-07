#!/usr/bin/env bash
#
# Abnahme der Docker-Laufzeit und des Wechsels zwischen beiden Laufzeiten.
#
# Der Kern der Phase: Die Spieldateien bleiben liegen, wo sie sind. Ein Wechsel
# der Laufzeit kostet deshalb keinen Neu-Download der 4 GB.
#
#   sudo ./scripts/verify-docker.sh
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
act() { send /server/action "id=$1&action=$2&_csrf=$(page "/server?id=$1" > /dev/null; csrf)"; }

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen."; exit 1; }
docker version >/dev/null 2>&1 || { echo "Docker antwortet nicht."; exit 1; }

echo "== Anmelden und Server anlegen =="
page /login > /dev/null
send /login "username=admin&password=panel-passwort-1&_csrf=$(csrf)" > /dev/null
page /servers/new > /dev/null
LOC=$(send /servers/new "name=Docker-Abnahme&gamePort=2502&queryPort=27216&rconPort=2506&rconPassword=docker-geheim&maxPlayers=10&mission=dayzOffline.chernarusplus&memoryMaxMb=512&cpuQuota=100&_csrf=$(csrf)")
ID=$(echo "$LOC" | sed 's/.*id=//')
check "Server angelegt ($ID)" '[ -n "$ID" ]'
DIR=/var/lib/dzpage-panel/servers/$ID

cat > "$DIR/game/DayZServer" <<'STANDIN'
#!/bin/sh
echo "Stand-in server started in $(pwd)"
echo "marker: $(cat /srv/dayz/marker.txt 2>/dev/null || cat "$(dirname "$0")/../marker.txt" 2>/dev/null || echo keine)"
trap 'echo beende; exit 0' TERM
while :; do sleep 2; done
STANDIN
chmod +x "$DIR/game/DayZServer"
# Eine Datei, die den Wechsel überleben muss — sie steht für die 4 GB.
echo "spieldaten-bleiben" > "$DIR/marker.txt"
/usr/lib/dzpage-panel/helper.sh prepare "$ID" 512 100 > /dev/null

echo
echo "== Unter systemd starten =="
act "$ID" start > /dev/null
sleep 3
check "systemd-Dienst läuft" '[ "$(systemctl is-active dzpage-server@$ID)" = "active" ]'

echo
echo "== Auf Docker umschalten =="
act "$ID" runtime-docker > /dev/null
page "/server?id=$ID" > /dev/null
grep -q "docker" "$PAGE" && ok "Panel meldet die Laufzeit Docker" || bad "Laufzeit nicht umgestellt"
check "systemd-Dienst ist gestoppt" '[ "$(systemctl is-active dzpage-server@$ID)" != "active" ]'

act "$ID" start > /dev/null
for _ in $(seq 1 20); do
  sleep 1
  [ "$(docker inspect -f '{{.State.Status}}' "dzpage-server-$ID" 2>/dev/null)" = "running" ] && break
done
check "Container läuft" '[ "$(docker inspect -f "{{.State.Status}}" dzpage-server-$ID 2>/dev/null)" = "running" ]'
docker logs "dzpage-server-$ID" 2>&1 | grep -q "Stand-in server started" && ok "Container-Protokoll zeigt den Start" || bad "kein Start im Container-Protokoll"
docker logs "dzpage-server-$ID" 2>&1 | grep -q "spieldaten-bleiben" && ok "dieselben Spieldateien im Container" || bad "Spieldateien fehlen im Container"
LIMIT=$(docker inspect -f '{{.HostConfig.Memory}}' "dzpage-server-$ID")
check "Speichergrenze im Container ($LIMIT)" '[ "$LIMIT" = "536870912" ]'
POLICY=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "dzpage-server-$ID")
check "Neustartregel gesetzt ($POLICY)" '[ "$POLICY" = "unless-stopped" ]'

echo
echo "== Oberfläche zeigt den Container-Zustand =="
page "/server?id=$ID" > /dev/null
grep -q "running" "$PAGE" && ok "Detailseite zeigt „running“" || bad "Detailseite zeigt nicht „running“"

echo
echo "== Zurück auf systemd, ohne Neu-Download =="
act "$ID" runtime-systemd > /dev/null
check "Container ist weg" '[ -z "$(docker ps -a -q -f name=dzpage-server-$ID)" ]'
check "Spieldateien liegen noch da" '[ -f "$DIR/marker.txt" ] && [ -x "$DIR/game/DayZServer" ]'
act "$ID" start > /dev/null
sleep 3
check "systemd-Dienst läuft wieder" '[ "$(systemctl is-active dzpage-server@$ID)" = "active" ]'

echo
echo "== Aufräumen =="
act "$ID" delete-confirm > /dev/null
check "Server entfernt" '[ ! -d "$DIR" ]'
rm -f "$JAR" "$PAGE"
echo
if [ "$FAILED" -eq 0 ]; then echo "Alle Prüfungen bestanden."; else echo "Es gab Fehler."; fi
exit "$FAILED"
