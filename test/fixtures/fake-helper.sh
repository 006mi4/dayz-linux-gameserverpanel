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
    echo stopped > "$STATE_FILE"
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
  *)
    echo "unbekannte Operation: $ACTION" >&2
    exit 64
    ;;
esac
