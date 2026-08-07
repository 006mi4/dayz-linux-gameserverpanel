#!/bin/sh
#
# Startet einen DayZ-Server. Wird ausschliesslich von der systemd-Vorlage
# dzpage-server@.service aufgerufen und laeuft als der Benutzer des Servers.
#
# Die Werte kommen ueber EnvironmentFile aus server.env. Das liest systemd
# selbst ein — hier wird nichts von einer Shell ausgewertet, damit auch ein
# manipulierter Wert nur ein Argument bleibt und kein Befehl wird.
set -eu

ID=${1:?Server-Kennung fehlt}
case "$ID" in
  *[!a-f0-9]* | "") echo "Ungueltige Server-Kennung: $ID" >&2; exit 64 ;;
esac

DIR="/var/lib/dzpage-panel/servers/$ID"
GAME="$DIR/game"
BINARY="$GAME/DayZServer"

if [ ! -x "$BINARY" ]; then
  echo "DayZServer fehlt oder ist nicht ausfuehrbar: $BINARY" >&2
  echo "Der Server wurde noch nicht installiert." >&2
  exit 78
fi

mkdir -p "$DIR/profiles/battleye"

# Ohne diesen Verweis startet der DayZ-Server nicht — er sucht die
# Steam-Bibliothek fest unter ~/.steam/sdk64/. HOME zeigt auf das
# Serververzeichnis, der Verweis bleibt also innerhalb des Servers.
if [ -f "$GAME/steamclient.so" ]; then
  mkdir -p "$HOME/.steam/sdk64"
  ln -sf "$GAME/steamclient.so" "$HOME/.steam/sdk64/steamclient.so"
fi

cd "$GAME"

# DayZ liefert eigene Bibliotheken im Installationsverzeichnis mit.
LD_LIBRARY_PATH="$GAME:${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH

exec "$BINARY" \
  "-config=$DIR/serverDZ.cfg" \
  "-port=${DZ_PORT:?Port fehlt}" \
  "-profiles=$DIR/profiles" \
  "-BEpath=$DIR/profiles/battleye" \
  "-cpuCount=${DZ_CPU_COUNT:-2}" \
  -dologs -adminlog -netlog -freezecheck
