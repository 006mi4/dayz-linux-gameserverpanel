#!/usr/bin/env bash
#
# Ein-Befehl-Installation des DZPage Panels.
#
#   curl -fsSL https://raw.githubusercontent.com/006mi4/dayz-linux-gameserverpanel/main/bootstrap.sh | sudo bash
#
# Optionen an install.sh durchreichen:
#
#   curl -fsSL … | sudo bash -s -- --with-docker
#   curl -fsSL … | sudo bash -s -- --lang de
#
# Das Skript holt das Projekt nach /opt/dzpage-panel, checkt die neueste
# veroeffentlichte Fassung aus und startet install.sh. Ein zweiter Lauf
# aktualisiert nur.
#
# Der ganze Inhalt steht in Funktionen, die erst in der letzten Zeile
# aufgerufen werden: Bricht die Uebertragung mitten drin ab, laeuft gar nichts,
# statt der Haelfte.
set -euo pipefail

# Die Sprache wie in install.sh (helper/i18n.sh): --lang, bei der Installation
# gemerkt, aus der Umgebung, sonst Englisch. Die Texte stehen hier selbst und
# nicht im Katalog, weil dieses Skript allein per curl kommt.
bootstrap_norm() {
  local value=${1%%[_.@-]*}
  value=${value,,}
  [[ $value =~ ^[a-z][a-z]$ ]] || return 0
  case " en de fr es it ru pl cs pt zh " in
    *" $value "*) printf '%s' "$value" ;;
  esac
  return 0
}

bootstrap_lang() {
  local prev="" arg wanted="" json="" value
  for arg in "$@"; do
    case "$arg" in --lang=*) wanted=${arg#--lang=} ;; esac
    if [ "$prev" = --lang ]; then
      case "$arg" in -*) ;; *) wanted=$arg ;; esac
    fi
    prev=$arg
  done
  wanted=$(bootstrap_norm "$wanted")
  if [ -z "$wanted" ] && [ "$(id -u)" -eq 0 ] && id -u dzpage >/dev/null 2>&1; then
    json=$(setpriv --reuid=dzpage --regid=dzpage --clear-groups -- \
      timeout 5 head -c 8192 /etc/dzpage-panel/install.json 2>/dev/null || true)
    wanted=$(bootstrap_norm "$(printf '%s\n' "$json" | sed -n 's/^ *"lang": *"\([^"]*\)".*/\1/p' | head -1 || true)")
  fi
  if [ -z "$wanted" ]; then
    for value in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
      [ -n "$value" ] || continue
      wanted=$(bootstrap_norm "$value")
      break
    done
  fi
  printf '%s' "${wanted:-en}"
}

# Je Sprache dieselben Namen; %s steht fuer den einen eingesetzten Wert.
bootstrap_texts() {
  T_ERROR="Error:"
  T_ROOT="Please run as root (sudo)."
  T_SYSTEMD="This system does not use systemd. For other systems there is the Docker way (see README)."
  T_ARCH="This machine is %s. The DayZ server only exists for x86_64 (amd64)."
  T_GIT="Providing git"
  T_GIT_NO_APT="git is missing, and without apt it cannot be installed here."
  T_APT_BUSY="The package manager is busy right now (usually automatic updates after boot). Waiting until it is free …"
  T_APT_LOCKED="The package manager was busy for %s seconds. Try again later."
  T_FETCH="Fetching the project"
  T_CHECKOUT_THERE="%s is already there, fetching new versions"
  T_CHECKOUT_FOREIGN="%s already exists but is not a Git working directory."
  T_VERSION="Version %s"
  T_NO_VERSION="No version released yet, using the main branch."
  T_INSTALL="Installation"
  case "$1" in
    de)
      T_ERROR="Fehler:"
      T_ROOT="Bitte als root ausführen (sudo)."
      T_SYSTEMD="Dieses System benutzt kein systemd. Für andere Systeme gibt es den Docker-Weg (siehe README)."
      T_ARCH="Diese Maschine ist %s. Den DayZ-Server gibt es nur für x86_64 (amd64)."
      T_GIT="Git bereitstellen"
      T_GIT_NO_APT="git fehlt, und ohne apt lässt es sich hier nicht nachinstallieren."
      T_APT_BUSY="Die Paketverwaltung ist gerade belegt (meist automatische Updates nach dem Start). Warte, bis sie frei ist …"
      T_APT_LOCKED="Die Paketverwaltung war %s Sekunden lang belegt. Später erneut versuchen."
      T_FETCH="Projekt holen"
      T_CHECKOUT_THERE="%s ist schon da, hole neue Fassungen"
      T_CHECKOUT_FOREIGN="%s gibt es schon, ist aber kein Git-Arbeitsverzeichnis."
      T_VERSION="Fassung %s"
      T_NO_VERSION="Noch keine Fassung veröffentlicht, nehme den Hauptzweig."
      T_INSTALL="Installation"
      ;;
    fr)
      T_ERROR="Erreur :"
      T_ROOT="À exécuter en root (sudo)."
      T_SYSTEMD="Ce système n'utilise pas systemd. Pour les autres systèmes, il existe la variante Docker (voir README)."
      T_ARCH="Cette machine est en %s. Le serveur DayZ n'existe qu'en x86_64 (amd64)."
      T_GIT="Préparation de git"
      T_GIT_NO_APT="git est absent, et sans apt il ne peut pas être installé ici."
      T_APT_BUSY="Le gestionnaire de paquets est occupé (souvent des mises à jour automatiques après le démarrage). J'attends qu'il soit libre …"
      T_APT_LOCKED="Le gestionnaire de paquets est resté occupé pendant %s secondes. Réessaie plus tard."
      T_FETCH="Récupération du projet"
      T_CHECKOUT_THERE="%s est déjà présent, récupération des nouvelles versions"
      T_CHECKOUT_FOREIGN="%s existe déjà mais n'est pas un répertoire de travail Git."
      T_VERSION="Version %s"
      T_NO_VERSION="Aucune version publiée pour l'instant, utilisation de la branche principale."
      T_INSTALL="Installation"
      ;;
    es)
      T_ERROR="Error:"
      T_ROOT="Ejecútalo como root (sudo)."
      T_SYSTEMD="Este sistema no usa systemd. Para otros sistemas existe la vía de Docker (ver README)."
      T_ARCH="Esta máquina es %s. El servidor de DayZ solo existe para x86_64 (amd64)."
      T_GIT="Preparando git"
      T_GIT_NO_APT="Falta git y, sin apt, no se puede instalar aquí."
      T_APT_BUSY="El gestor de paquetes está ocupado ahora mismo (normalmente actualizaciones automáticas tras el arranque). Esperando a que quede libre …"
      T_APT_LOCKED="El gestor de paquetes estuvo ocupado durante %s segundos. Vuelve a intentarlo más tarde."
      T_FETCH="Descargando el proyecto"
      T_CHECKOUT_THERE="%s ya existe, descargando versiones nuevas"
      T_CHECKOUT_FOREIGN="%s ya existe, pero no es un directorio de trabajo de Git."
      T_VERSION="Versión %s"
      T_NO_VERSION="Todavía no hay ninguna versión publicada, se usa la rama principal."
      T_INSTALL="Instalación"
      ;;
    it)
      T_ERROR="Errore:"
      T_ROOT="Esegui come root (sudo)."
      T_SYSTEMD="Questo sistema non usa systemd. Per altri sistemi c'è la via Docker (vedi README)."
      T_ARCH="Questa macchina è %s. Il server di DayZ esiste solo per x86_64 (amd64)."
      T_GIT="Preparazione di git"
      T_GIT_NO_APT="git manca, e senza apt qui non si può installare."
      T_APT_BUSY="Il gestore dei pacchetti è occupato (di solito aggiornamenti automatici dopo l'avvio). Attendo che si liberi …"
      T_APT_LOCKED="Il gestore dei pacchetti è rimasto occupato per %s secondi. Riprova più tardi."
      T_FETCH="Recupero del progetto"
      T_CHECKOUT_THERE="%s è già presente, recupero le nuove versioni"
      T_CHECKOUT_FOREIGN="%s esiste già, ma non è una cartella di lavoro Git."
      T_VERSION="Versione %s"
      T_NO_VERSION="Nessuna versione ancora pubblicata, uso il branch principale."
      T_INSTALL="Installazione"
      ;;
    ru)
      T_ERROR="Ошибка:"
      T_ROOT="Запусти от имени root (sudo)."
      T_SYSTEMD="Эта система не использует systemd. Для других систем есть вариант с Docker (см. README)."
      T_ARCH="Архитектура этой машины: %s. Сервер DayZ есть только для x86_64 (amd64)."
      T_GIT="Подготовка git"
      T_GIT_NO_APT="git не найден, а без apt его здесь не установить."
      T_APT_BUSY="Менеджер пакетов сейчас занят (обычно автоматические обновления после запуска). Жду, пока он освободится …"
      T_APT_LOCKED="Менеджер пакетов был занят %s с. Попробуй позже."
      T_FETCH="Загрузка проекта"
      T_CHECKOUT_THERE="%s уже на месте, загружаю новые версии"
      T_CHECKOUT_FOREIGN="%s уже существует, но это не рабочий каталог Git."
      T_VERSION="Версия %s"
      T_NO_VERSION="Ни одной версии ещё не выпущено, беру основную ветку."
      T_INSTALL="Установка"
      ;;
    pl)
      T_ERROR="Błąd:"
      T_ROOT="Uruchom jako root (sudo)."
      T_SYSTEMD="Ten system nie używa systemd. Dla innych systemów jest instalacja przez Docker (zobacz README)."
      T_ARCH="Ta maszyna to %s. Serwer DayZ istnieje tylko dla x86_64 (amd64)."
      T_GIT="Przygotowanie narzędzia git"
      T_GIT_NO_APT="Brakuje narzędzia git, a bez apt nie da się go tu zainstalować."
      T_APT_BUSY="Menedżer pakietów jest teraz zajęty (zwykle automatyczne aktualizacje po starcie). Czekam, aż się zwolni …"
      T_APT_LOCKED="Menedżer pakietów był zajęty przez %s s. Spróbuj ponownie później."
      T_FETCH="Pobieranie projektu"
      T_CHECKOUT_THERE="%s już istnieje, pobieranie nowych wersji"
      T_CHECKOUT_FOREIGN="%s już istnieje, ale nie jest katalogiem roboczym Git."
      T_VERSION="Wersja %s"
      T_NO_VERSION="Nie wydano jeszcze żadnej wersji, używana jest gałąź main."
      T_INSTALL="Instalacja"
      ;;
    cs)
      T_ERROR="Chyba:"
      T_ROOT="Spusť to prosím jako root (sudo)."
      T_SYSTEMD="Tento systém nepoužívá systemd. Pro jiné systémy je tu cesta přes Docker (viz README)."
      T_ARCH="Tento stroj má architekturu %s. DayZ server existuje jen pro x86_64 (amd64)."
      T_GIT="Zajišťuji git"
      T_GIT_NO_APT="git chybí a bez apt ho tu nejde nainstalovat."
      T_APT_BUSY="Správce balíčků je právě zaneprázdněný (obvykle automatické aktualizace po startu). Čekám, až se uvolní …"
      T_APT_LOCKED="Správce balíčků byl zaneprázdněný %s s. Zkus to později znovu."
      T_FETCH="Stahuji projekt"
      T_CHECKOUT_THERE="%s už existuje, stahuji nové verze"
      T_CHECKOUT_FOREIGN="%s už existuje, ale není to pracovní adresář Gitu."
      T_VERSION="Verze %s"
      T_NO_VERSION="Zatím nevyšla žádná verze, používám hlavní větev."
      T_INSTALL="Instalace"
      ;;
    pt)
      T_ERROR="Erro:"
      T_ROOT="Executa como root (sudo)."
      T_SYSTEMD="Este sistema não usa systemd. Para outros sistemas existe a via Docker (ver README)."
      T_ARCH="Esta máquina é %s. O servidor de DayZ só existe para x86_64 (amd64)."
      T_GIT="A preparar o git"
      T_GIT_NO_APT="O git não está instalado e, sem apt, não pode ser instalado aqui."
      T_APT_BUSY="O gestor de pacotes está ocupado neste momento (normalmente atualizações automáticas após o arranque). À espera de que fique livre …"
      T_APT_LOCKED="O gestor de pacotes esteve ocupado durante %s segundos. Tenta de novo mais tarde."
      T_FETCH="A obter o projeto"
      T_CHECKOUT_THERE="%s já existe, a obter versões novas"
      T_CHECKOUT_FOREIGN="%s já existe, mas não é um diretório de trabalho Git."
      T_VERSION="Versão %s"
      T_NO_VERSION="Ainda não há nenhuma versão publicada, a usar o ramo principal."
      T_INSTALL="Instalação"
      ;;
    zh)
      T_ERROR="错误："
      T_ROOT="请以 root 身份运行（sudo）。"
      T_SYSTEMD="此系统未使用 systemd。其他系统可以使用 Docker 方式（见 README）。"
      T_ARCH="本机架构为 %s。DayZ 服务端只有 x86_64（amd64）版本。"
      T_GIT="准备 git"
      T_GIT_NO_APT="缺少 git，而且没有 apt 无法在这里安装。"
      T_APT_BUSY="软件包管理器正忙（通常是开机后的自动更新）。正在等待其空闲……"
      T_APT_LOCKED="软件包管理器被占用了 %s 秒。请稍后再试。"
      T_FETCH="获取项目"
      T_CHECKOUT_THERE="%s 已存在，正在获取新版本"
      T_CHECKOUT_FOREIGN="%s 已存在，但不是 Git 工作目录。"
      T_VERSION="版本 %s"
      T_NO_VERSION="尚未发布任何版本，将使用 main 分支。"
      T_INSTALL="安装"
      ;;
  esac
}

bootstrap_main() {
  local repo=${DZPAGE_PANEL_REPO:-https://github.com/006mi4/dayz-linux-gameserverpanel.git}
  local checkout=${DZPAGE_PANEL_CHECKOUT:-/opt/dzpage-panel}

  bootstrap_texts "$(bootstrap_lang "$@")"
  say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
  note() { printf '  %s\n' "$*"; }
  die() { printf '\n\033[31m%s\033[0m %s\n' "$T_ERROR" "$*" >&2; exit 1; }

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
        # shellcheck disable=SC2059
        [ "$locked" -eq 0 ] || note "$(printf "$T_APT_LOCKED" "$apt_wait_seconds")" >&2
        return "$rc"
      fi
      [ "$waited" -eq 1 ] || note "$T_APT_BUSY" >&2
      waited=1
      sleep 10
    done
  }

  [ "$(id -u)" -eq 0 ] || die "$T_ROOT"
  [ -d /run/systemd/system ] || die "$T_SYSTEMD"
  # Vor dem Klonen pruefen, nicht erst in install.sh: DayZServer und SteamCMD
  # gibt es nur fuer x86_64, auf allem anderen waere das Panel nutzlos.
  # shellcheck disable=SC2059
  [ "$(uname -m)" = "x86_64" ] || die "$(printf "$T_ARCH" "$(uname -m)")"

  say "$T_GIT"
  if ! command -v git >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt_get update -qq
      apt_get install -y -qq git ca-certificates
    else
      die "$T_GIT_NO_APT"
    fi
  fi
  note "$(git --version)"

  say "$T_FETCH"
  # shellcheck disable=SC2059
  if [ -d "$checkout/.git" ]; then
    note "$(printf "$T_CHECKOUT_THERE" "$checkout")"
    git -C "$checkout" remote set-url origin "$repo"
    git -C "$checkout" fetch --tags --prune --quiet origin
  else
    [ -e "$checkout" ] && die "$(printf "$T_CHECKOUT_FOREIGN" "$checkout")"
    git clone --quiet "$repo" "$checkout"
  fi

  # Die neueste veroeffentlichte Fassung, nicht der Entwicklungsstand: -V
  # sortiert nach Zahlen, sonst stuende v0.9.0 ueber v0.10.0.
  local tag
  tag=$(git -C "$checkout" tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)
  if [ -n "$tag" ]; then
    git -C "$checkout" -c advice.detachedHead=false checkout --quiet "$tag"
    # shellcheck disable=SC2059
    note "$(printf "$T_VERSION" "$tag")"
  else
    note "$T_NO_VERSION"
  fi

  say "$T_INSTALL"
  exec "$checkout/install.sh" "$@"
}

bootstrap_main "$@"
