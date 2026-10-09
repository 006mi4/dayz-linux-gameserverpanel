#!/usr/bin/env bash
#
# Ein-Befehl-Installation des DZPage Panels.
#
#   curl -fsSL https://raw.githubusercontent.com/006mi4/dayz-linux-gameserverpanel/main/bootstrap.sh | sudo bash
#
# Optionen an install.sh durchreichen:
#
#   curl -fsSL … | sudo bash -s -- --with-docker
#
# Das Skript holt das Projekt nach /opt/dzpage-panel, checkt die neueste
# veroeffentlichte Fassung aus und startet install.sh. Ein zweiter Lauf
# aktualisiert nur.
#
# Der ganze Inhalt steht in einer Funktion, die erst in der letzten Zeile
# aufgerufen wird: Bricht die Uebertragung mitten drin ab, laeuft gar nichts —
# statt der Haelfte.
set -euo pipefail

bootstrap_main() {
  local repo=${DZPAGE_PANEL_REPO:-https://github.com/006mi4/dayz-linux-gameserverpanel.git}
  local checkout=${DZPAGE_PANEL_CHECKOUT:-/opt/dzpage-panel}

  say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
  note() { printf '  %s\n' "$*"; }
  die() { printf '\n\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

  # apt-get, das auf eine belegte Paketverwaltung wartet, statt sofort mit 100
  # abzubrechen: Auf einem frisch gestarteten Server laufen oft gerade die
  # automatischen Updates. DPkg::Lock::Timeout allein deckt "apt-get update"
  # nicht ab (gemessen mit apt 2.4 und 2.8); mehr dazu in install.sh.
  local apt_wait_seconds=600
  apt_get() {
    local deadline=$((SECONDS + apt_wait_seconds)) out rc locked waited=0 left
    while :; do
      left=$((deadline - SECONDS))
      [ "$left" -ge 1 ] || left=1
      rc=0
      out=$(LC_ALL=C apt-get -o "DPkg::Lock::Timeout=$left" "$@" 2>&1) || rc=$?
      locked=0
      if [ "$rc" -ne 0 ] && grep -qE 'Could not get lock|Unable to lock|Unable to acquire' <<<"$out"; then
        locked=1
      fi
      if [ "$locked" -eq 0 ] || [ "$SECONDS" -ge "$deadline" ]; then
        if [ "$rc" -eq 0 ]; then
          [ -z "$out" ] || printf '%s\n' "$out"
        else
          printf '%s\n' "$out" >&2
        fi
        [ "$locked" -eq 0 ] || note "Die Paketverwaltung war $apt_wait_seconds Sekunden lang belegt. Spaeter erneut ausfuehren." >&2
        return "$rc"
      fi
      [ "$waited" -eq 1 ] || note "Die Paketverwaltung ist gerade belegt (meist automatische Updates nach dem Start). Warte, bis sie frei ist ..." >&2
      waited=1
      sleep 10
    done
  }

  [ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo)."
  [ -d /run/systemd/system ] || die "Dieses System benutzt kein systemd. Fuer andere Systeme gibt es den Docker-Weg (siehe README)."
  # Vor dem Klonen pruefen, nicht erst in install.sh: DayZServer und SteamCMD
  # gibt es nur fuer x86_64, auf allem anderen waere das Panel nutzlos.
  [ "$(uname -m)" = "x86_64" ] || die "Diese Maschine ist $(uname -m). Den DayZ-Server gibt es nur fuer x86_64 (amd64)."

  say "Git bereitstellen"
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt_get update -qq
      apt_get install -y -qq git ca-certificates
    else
      die "git fehlt und ohne apt kann ich es nicht nachinstallieren."
    fi
  fi
  note "$(git --version)"

  say "Projekt holen"
  if [ -d "$checkout/.git" ]; then
    note "$checkout ist schon da, hole neue Fassungen"
    git -C "$checkout" remote set-url origin "$repo"
    git -C "$checkout" fetch --tags --prune --quiet origin
  else
    [ -e "$checkout" ] && die "$checkout gibt es schon, ist aber kein Git-Arbeitsverzeichnis."
    git clone --quiet "$repo" "$checkout"
  fi

  # Die neueste veroeffentlichte Fassung, nicht der Entwicklungsstand: -V
  # sortiert nach Zahlen, sonst stuende v0.9.0 ueber v0.10.0.
  local tag
  tag=$(git -C "$checkout" tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)
  if [ -n "$tag" ]; then
    git -C "$checkout" -c advice.detachedHead=false checkout --quiet "$tag"
    note "Fassung $tag"
  else
    note "Noch keine Fassung veroeffentlicht, nehme den Hauptzweig."
  fi

  say "Installation"
  exec "$checkout/install.sh" "$@"
}

bootstrap_main "$@"
