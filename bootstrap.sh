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

  [ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo)."
  [ -d /run/systemd/system ] || die "Dieses System benutzt kein systemd. Fuer andere Systeme gibt es den Docker-Weg (siehe README)."
  # Vor dem Klonen pruefen, nicht erst in install.sh: DayZServer und SteamCMD
  # gibt es nur fuer x86_64, auf allem anderen waere das Panel nutzlos.
  [ "$(uname -m)" = "x86_64" ] || die "Diese Maschine ist $(uname -m). Den DayZ-Server gibt es nur fuer x86_64 (amd64)."

  say "Git bereitstellen"
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq git ca-certificates
    else
      die "git fehlt und ohne apt kann ich es nicht nachinstallieren."
    fi
  fi
  note "$(git --version)"

  say "Projekt holen"
  if [ -d "$checkout/.git" ]; then
    note "$checkout ist schon da — hole neue Fassungen"
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
    note "Noch keine Fassung veroeffentlicht — nehme den Hauptzweig."
  fi

  say "Installation"
  exec "$checkout/install.sh" "$@"
}

bootstrap_main "$@"
