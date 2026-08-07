#!/bin/sh
#
# Einstieg des Containers.
#
# Drei Aufgaben, in dieser Reihenfolge:
#   1. Programmcode besorgen (beim ersten Start klonen, sonst so lassen — das
#      Panel verwaltet seinen Stand danach selbst).
#   2. Fehlstart einer neuen Fassung abfangen: Nach drei Anlaeufen zurueck auf
#      den letzten Stand, der nachweislich hochgekommen ist.
#   3. Hinterlegen, wie dieses Panel installiert wurde, und starten.
set -eu

CHECKOUT=${DZPAGE_PANEL_CHECKOUT:-/opt/dzpage-panel}
REPO=${DZPAGE_PANEL_REPO:-https://github.com/006mi4/dayz-linux-gameserverpanel.git}
DATA_DIR=${DZPAGE_PANEL_DATA_DIR:-/var/lib/dzpage-panel}
CONFIG_DIR=${DZPAGE_PANEL_CONFIG_DIR:-/etc/dzpage-panel}
ATTEMPTS=$DATA_DIR/boot-attempts
GOOD_REF=$DATA_DIR/good-ref

say() { echo "entrypoint: $*"; }

mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$DATA_DIR/servers"

if [ ! -d "$CHECKOUT/.git" ]; then
  say "hole $REPO nach $CHECKOUT"
  git clone --quiet "$REPO" "$CHECKOUT"
  # Die neueste veroeffentlichte Fassung, nicht der Entwicklungsstand von main:
  # -V sortiert nach Zahlen, sonst stuende v0.9.0 ueber v0.10.0.
  tag=$(git -C "$CHECKOUT" tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)
  if [ -n "$tag" ]; then
    git -C "$CHECKOUT" -c advice.detachedHead=false checkout --quiet "$tag"
    say "Fassung $tag"
  else
    say "noch keine Fassung veroeffentlicht — nehme den Hauptzweig"
  fi
fi
git config --global --add safe.directory "$CHECKOUT" 2>/dev/null || true

# Startversuche zaehlen. Das Panel setzt den Zaehler zurueck, sobald es steht
# (siehe markBootSuccessful) — bleibt er stehen, ist die Fassung unbrauchbar,
# und ohne diesen Rueckfall wuerde der Container endlos neu starten.
attempts=$(cat "$ATTEMPTS" 2>/dev/null || echo 0)
case "$attempts" in *[!0-9]*) attempts=0 ;; esac
attempts=$((attempts + 1))
echo "$attempts" > "$ATTEMPTS"
if [ "$attempts" -ge 3 ] && [ -s "$GOOD_REF" ]; then
  good=$(cat "$GOOD_REF")
  say "dritter Startversuch — zurueck auf $good"
  git -C "$CHECKOUT" reset --hard --quiet "$good" || say "Ruecknahme fehlgeschlagen"
  echo 0 > "$ATTEMPTS"
fi

cat > "$CONFIG_DIR/install.json" <<EOF
{
  "method": "docker",
  "checkout": "$CHECKOUT",
  "repository": "$REPO",
  "args": [],
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 0644 "$CONFIG_DIR/install.json"

exec node "$CHECKOUT/bin/dzpage-panel.js" "$@"
