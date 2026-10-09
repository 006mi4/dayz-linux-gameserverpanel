# shellcheck shell=bash
#
# Texte im Terminal in der Sprache der Installation. Wird von install.sh,
# dzpage-panel, uninstall.sh und https.sh eingebunden; die Texte selbst stehen
# in src/i18n/terminal/<sprache>.txt, eine Zeile je Text: schluessel=text.
# Das Verwaltungsprogramm (Node) liest dieselben Dateien, siehe
# src/i18n/terminal.js. Beide muessen die Sprache gleich bestimmen.
#
#   i18n_init <katalogverzeichnis> [sprache]
#   t <schluessel> [name=wert ...]     Text mit {name} ersetzt, ohne Zeilenende
#
# Die Sprache, in dieser Reihenfolge: ausdruecklich angegeben (--lang oder
# DZPAGE_PANEL_LANG), bei der Installation gemerkt (install.json), aus der
# Umgebung (LC_ALL, LC_MESSAGES, LANG), sonst Englisch. Auf gemieteten Servern
# steht LANG meist auf C.UTF-8, dann bleibt es bei Englisch.

I18N_LOCALES="en de fr es it ru pl cs pt zh"
I18N_LOCALE=en
I18N_STORED=""
# Ausdruecklich verlangt, aber keine der Sprachen (fuer eine Warnung).
I18N_REJECTED=""
declare -gA I18N_TEXT=()

# Der Wert von --lang aus den Argumenten, ohne sie zu verbrauchen: Die Sprache
# muss feststehen, bevor die Argumente geprueft werden und etwas gemeldet wird.
# Wie bei den anderen Optionen gilt die letzte Angabe. Was mit "-" beginnt, ist
# die naechste Option und kein Wert ("--lang --purge").
i18n_arg() {
  local prev="" arg wanted=""
  for arg in "$@"; do
    case "$arg" in --lang=*) wanted=${arg#--lang=} ;; esac
    if [ "$prev" = --lang ]; then
      case "$arg" in -*) ;; *) wanted=$arg ;; esac
    fi
    prev=$arg
  done
  printf '%s' "$wanted"
}

# Eine der Sprachen oder nichts. Nimmt auch de_DE.UTF-8, pt-BR und DE, aber
# nur genau zwei Buchstaben: "de fr" fände sonst " de fr " in der Liste.
i18n_normalize() {
  local value=${1:-}
  value=${value%%[_.@-]*}
  value=${value,,}
  [[ $value =~ ^[a-z][a-z]$ ]] || return 0
  case " $I18N_LOCALES " in
    *" $value "*) printf '%s' "$value" ;;
  esac
  return 0
}

# Name einer Sprache in ihr selbst, fuer "dzpage-panel language".
i18n_name() {
  case "${1:-}" in
    en) printf 'English' ;; de) printf 'Deutsch' ;; fr) printf 'Français' ;;
    es) printf 'Español' ;; it) printf 'Italiano' ;; ru) printf 'Русский' ;;
    pl) printf 'Polski' ;; cs) printf 'Čeština' ;; pt) printf 'Português' ;;
    zh) printf '中文' ;; *) printf '%s' "${1:-}" ;;
  esac
}

# Die bei der Installation gemerkte Sprache. install.json gehoert root, liegt
# aber in einem Verzeichnis des Dienstes; als Dienstbenutzer gelesen und mit
# Frist, wie die anderen Lesezugriffe dort (Verweis oder FIFO statt der Datei).
i18n_stored() {
  local json=""
  [ "$(id -u)" -eq 0 ] || return 0
  id -u dzpage >/dev/null 2>&1 || return 0
  json=$(setpriv --reuid=dzpage --regid=dzpage --clear-groups -- \
    timeout 5 head -c 8192 /etc/dzpage-panel/install.json 2>/dev/null || true)
  i18n_normalize "$(printf '%s\n' "$json" | sed -n 's/^ *"lang": *"\([^"]*\)".*/\1/p' | head -1 || true)"
}

# Nur die erste gesetzte Variable zaehlt, wie bei gettext: LC_ALL=C heisst
# Englisch, auch wenn LANG etwas anderes sagt.
i18n_from_env() {
  local value
  for value in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    [ -n "$value" ] || continue
    i18n_normalize "$value"
    return 0
  done
}

i18n_load() {
  local file=$1 line
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in ''|'#'*) continue ;; esac
    [ "${line%%=*}" != "$line" ] || continue
    I18N_TEXT[${line%%=*}]=${line#*=}
  done < "$file"
}

i18n_init() {
  local dir=$1 wanted=${2:-${DZPAGE_PANEL_LANG:-}} explicit
  explicit=$(i18n_normalize "$wanted")
  [ -n "$explicit" ] || I18N_REJECTED=$wanted
  I18N_STORED=$(i18n_stored)
  I18N_LOCALE=${explicit:-${I18N_STORED:-$(i18n_from_env)}}
  I18N_LOCALE=${I18N_LOCALE:-en}
  # Was dieses Skript aufruft (dzpage-panel, https.sh, das Verwaltungsprogramm),
  # spricht dieselbe Sprache, ohne sie noch einmal zu bestimmen.
  export DZPAGE_PANEL_LANG=$I18N_LOCALE
  # Englisch zuerst: Fehlt ein Text in der Sprache, steht er wenigstens dort.
  i18n_load "$dir/en.txt"
  [ "$I18N_LOCALE" = en ] || i18n_load "$dir/$I18N_LOCALE.txt"
}

# Von links nach rechts in einem Durchgang: Ein Wert, der selbst wie {name}
# aussieht (etwa ein Kontoname von DZPage), wird nicht noch einmal ersetzt.
t() {
  local rest=${I18N_TEXT[$1]-$1} out="" name pair found
  shift
  while [[ $rest == *"{"* ]]; do
    out+=${rest%%"{"*}
    rest=${rest#*"{"}
    name=${rest%%"}"*}
    found=0
    if [[ $rest == *"}"* && $name =~ ^[a-z_]+$ ]]; then
      for pair in "$@"; do
        if [ "${pair%%=*}" = "$name" ]; then
          out+=${pair#*=}
          rest=${rest#*"}"}
          found=1
          break
        fi
      done
    fi
    [ "$found" -eq 1 ] || out+="{"
  done
  printf '%s' "$out$rest"
}
