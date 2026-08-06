#!/bin/sh
# Liest eine Zeile vom Terminal und gibt sie zurueck — zum Pruefen der
# Pseudo-Konsole selbst.
printf 'ready: '
IFS= read -r line
printf '\nGOT=%s\n' "$line"
