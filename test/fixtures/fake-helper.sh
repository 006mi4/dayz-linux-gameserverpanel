#!/bin/sh
# Ersatz fuer das privilegierte Hilfsprogramm.
#
# Er merkt sich seine Aufrufe und fuehrt einen Zustand je Server mit, damit die
# Tests den ganzen Weg pruefen koennen — Start, Stopp, Neustart und was die
# Oberflaeche danach anzeigt — ohne Rootrechte.
STATE_DIR=${DZPANEL_FAKE_STATE:-/tmp/dzpanel-fake-helper}
mkdir -p "$STATE_DIR"
echo "$*" >> "$STATE_DIR/calls.log"

ACTION=$1
ID=$2
STATE_FILE="$STATE_DIR/$ID.state"

case "$ACTION" in
  prepare)
    # Ein Test kann prepare scheitern lassen, um Fehler nach dem Download
    # nachzustellen.
    if [ -f "$STATE_DIR/fail-prepare" ]; then
      echo "prepare gescheitert (Test)" >&2
      exit 1
    fi
    # prepare laesst einen laufenden Server laufen, wie der echte Helfer.
    [ "$(cat "$STATE_FILE" 2>/dev/null)" = running ] || echo stopped > "$STATE_FILE"
    echo "prepared $ID"
    ;;
  start|restart)
    echo running > "$STATE_FILE"
    echo "$ACTION $ID"
    ;;
  stop)
    echo stopped > "$STATE_FILE"
    echo "stop $ID"
    ;;
  enable)
    echo enabled > "$STATE_DIR/$ID.enabled"
    echo "enable $ID"
    ;;
  disable)
    rm -f "$STATE_DIR/$ID.enabled"
    echo "disable $ID"
    ;;
  destroy)
    rm -f "$STATE_FILE" "$STATE_DIR/$ID.enabled"
    echo "destroyed $ID"
    ;;
  status)
    STATE=$(cat "$STATE_FILE" 2>/dev/null || echo inactive)
    if [ "$STATE" = running ]; then
      printf 'ActiveState=active\nSubState=running\nMainPID=4242\nMemoryCurrent=524288000\nNRestarts=1\n'
      printf 'ExecMainStartTimestamp=Mon 2026-01-05 10:00:00 UTC\n'
    elif [ "$STATE" = starting ]; then
      # systemd zwischen zwei Startversuchen eines abstuerzenden Servers
      printf 'ActiveState=activating\nSubState=auto-restart\nMainPID=0\nMemoryCurrent=[not set]\nNRestarts=7\n'
    else
      printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\nMemoryCurrent=[not set]\nNRestarts=0\n'
    fi
    if [ -f "$STATE_DIR/$ID.enabled" ]; then
      printf 'UnitFileState=enabled\n'
    else
      printf 'UnitFileState=disabled\n'
    fi
    printf 'Result=success\n'
    ;;
  logs)
    printf '2026-08-07T00:00:00+0000 dzpage-server-%s[4242]: DayZ server ready\n' "$ID"
    ;;
  firewall-open|firewall-close|firewall-status)
    # Die Suite laeuft ohne Firewall: genau das meldet der echte Helfer dann auch.
    echo "backend=none"
    ;;
  self-update)
    # Im Betrieb startet der Helfer hier einen eigenen Dienst, der die Dateien
    # austauscht und das Panel neu startet. Im Test bleibt der Aufruf in
    # calls.log stehen — mehr soll er auch nicht.
    echo "self-update $ID gestartet"
    ;;
  *)
    echo "unbekannte Operation: $ACTION" >&2
    exit 64
    ;;
esac
