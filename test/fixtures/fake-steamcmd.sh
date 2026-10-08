#!/bin/sh
# Nachbau der Eingabeaufforderungen von SteamCMD fuer die Tests.
#
# Das Verhalten haengt am Kontonamen, nicht an Umgebungsvariablen: die
# Pseudo-Konsole startet den Prozess absichtlich mit einer festen, kleinen
# Umgebung, und genau das soll der Test nicht umgehen muessen.
#
#   testkonto*   richtiges Passwort noetig -> Anmeldung gelingt
#   badpass*     Passwort wird immer abgelehnt
#   guard*       fragt zusaetzlich nach dem Steam-Guard-Code (54321)
#   ask*         stellt eine unbekannte Rueckfrage
#   cachedslow*  wie cached*, aber die Installation dauert einige Sekunden
#
# Mit Argumenten (+login KONTO +quit) verhaelt es sich wie die Pruefung des
# gemerkten Sitzungstokens: "cached*" ist angemeldet, alles andere fragt nach
# dem Passwort.
#
# "+login anonymous ... +app_info_print" gibt die mitgelieferte echte Ausgabe
# aus (am Steam-Client vom 2026-08-07 abgenommen) — damit prueft die Suite den
# Leser gegen das Format, das wirklich kommt, und nicht gegen einen Nachbau.
EXPECTED_PASSWORD='panel-test-passwort'

if [ "${1:-}" = '+login' ] && [ "${2:-}" = 'anonymous' ]; then
  for arg in "$@"; do
    if [ "$arg" = '+app_info_print' ]; then
      cat "$(dirname "$0")/steamcmd-app-info-223350.txt"
      exit 0
    fi
  done
  printf 'Connecting anonymously to Steam Public...OK\n'
  exit 0
fi

# Installation der Spieldateien: "+force_install_dir DIR +login KONTO
# +app_update 223350 validate +quit". Mit gemerkter Sitzung (cached*) legt das
# einen ausfuehrbaren DayZServer-Ersatz und das echte Manifest ab, sonst fragt
# es nach dem Passwort wie das Original bei abgelaufener Sitzung.
if [ "${1:-}" = '+force_install_dir' ] && [ "${3:-}" = '+login' ]; then
  dir=$2
  account=${4:-}
  printf 'Steam Console Client (c) Valve Corporation - version 1728594755\n'
  printf 'Loading Steam API...OK\n'
  case "$account" in
    cachedslow*)
      # Wie ein echter Download: einige Sekunden mit Zwischenstaenden.
      printf "Logging in user '%s' [U:1:0] to Steam Public...OK\n" "$account"
      mkdir -p "$dir/steamapps"
      for step in 10.00 35.50 62.25 88.75; do
        printf ' Update state (0x61) downloading, progress: %s (1024 / 4096)\n' "$step"
        sleep 1
      done
      printf '#!/bin/sh\nexit 0\n' > "$dir/DayZServer"
      chmod 0755 "$dir/DayZServer"
      cp "$(dirname "$0")/appmanifest_223350.acf" "$dir/steamapps/appmanifest_223350.acf"
      printf "Success! App '223350' fully installed.\n"
      ;;
    cached*)
      printf "Logging in user '%s' [U:1:0] to Steam Public...OK\n" "$account"
      mkdir -p "$dir/steamapps"
      printf '#!/bin/sh\nexit 0\n' > "$dir/DayZServer"
      chmod 0755 "$dir/DayZServer"
      cp "$(dirname "$0")/appmanifest_223350.acf" "$dir/steamapps/appmanifest_223350.acf"
      printf ' Update state (0x61) downloading, progress: 50.00 (2048 / 4096)\n'
      printf "Success! App '223350' fully installed.\n"
      ;;
    *)
      printf 'Cached credentials not found.\n\n'
      printf 'password: '
      ;;
  esac
  exit 0
fi

if [ "${1:-}" = '+login' ]; then
  printf 'Steam Console Client (c) Valve Corporation - version 1728594755\n'
  printf -- '-- type "quit" to exit --\n'
  printf 'Loading Steam API...OK\n'
  case "${2:-}" in
    cached*)
      printf "Logging in user '%s' [U:1:0] to Steam Public...OK\n" "$2"
      printf 'Waiting for user info...OK\n'
      exit 0
      ;;
    *)
      printf 'Cached credentials not found.\n\n'
      printf 'password: '
      exit 0
      ;;
  esac
fi

printf 'Steam Console Client (c) Valve Corporation - version 1728594755\n'
printf -- '-- type "quit" to exit --\n'
printf 'Loading Steam API...OK\n'

while :; do
  printf 'Steam>'
  IFS= read -r line || exit 0
  case "$line" in
    login\ *)
      account=${line#login }
      printf "\nLogging in user '%s' to Steam Public...\n\n" "$account"
      stty -echo 2>/dev/null
      printf 'password: '
      IFS= read -r password
      stty echo 2>/dev/null
      printf '\n'

      case "$account" in
        badpass*)
          printf 'FAILED (Invalid Password)\n\n'
          continue
          ;;
        ask*)
          printf 'Please confirm the device name: '
          IFS= read -r answer
          printf '\n'
          if [ "$answer" != "heimserver" ]; then
            printf 'FAILED (Unknown device)\n\n'
            continue
          fi
          ;;
        guard*)
          printf 'Two-factor code: '
          IFS= read -r code
          printf '\n'
          if [ "$code" != '54321' ]; then
            printf 'FAILED (Two-factor code mismatch)\n\n'
            continue
          fi
          ;;
        *)
          if [ "$password" != "$EXPECTED_PASSWORD" ]; then
            printf 'FAILED (Invalid Password)\n\n'
            continue
          fi
          ;;
      esac

      printf 'OK\n'
      printf 'Waiting for client config...OK\n'
      printf 'Waiting for user info...OK\n\n'
      ;;
    quit)
      printf '\n'
      exit 0
      ;;
    *) ;;
  esac
done
