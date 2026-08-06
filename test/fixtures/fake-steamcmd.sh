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
EXPECTED_PASSWORD='panel-test-passwort'

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
