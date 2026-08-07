# Laufzeit-Abbild fuer das DZPage Panel.
#
# Absicht: Das Abbild bringt nur mit, was das Panel zum Laufen braucht — Node,
# git, die 32-Bit-Bibliotheken fuer SteamCMD und den Docker-Klienten. Der
# Programmcode selbst liegt NICHT im Abbild, sondern in einem Datentraeger
# (/opt/dzpage-panel), den der Einstieg beim ersten Start aus Git holt.
#
# Das ist keine Bequemlichkeit, sondern der Grund, warum es eine
# Aktualisierung gibt: So laeuft in beiden Installationsarten derselbe Weg —
# neues Etikett auschecken, neu starten. Sonst braeuchte der Docker-Weg einen
# Abbild-Speicher, ein Anmeldekonto dort und einen zweiten Update-Mechanismus.
FROM debian:bookworm-slim

ARG NODE_VERSION=24.11.1
ARG DOCKER_CLI_VERSION=27.5.1
ARG TARGETARCH=amd64

# SteamCMD ist auch auf 64-Bit-Systemen ein 32-Bit-Programm; util-linux liefert
# script(1), ohne das SteamCMD nicht nach dem Passwort fragen kann.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      tar \
      xz-utils \
      util-linux \
      procps \
      lib32gcc-s1 \
 && rm -rf /var/lib/apt/lists/*

# Node aus dem offiziellen Tarball, mit Pruefsumme aus derselben Quelle: sie
# deckt einen abgebrochenen oder verfaelschten Transport ab.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) node_arch=linux-x64 ;; \
      arm64) node_arch=linux-arm64 ;; \
      *) echo "Nicht unterstuetzte Architektur: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${node_arch}.tar.xz"; \
    sha256sum -c --ignore-missing SHASUMS256.txt; \
    mkdir -p /usr/local/lib/node; \
    tar -xJf "node-v${NODE_VERSION}-${node_arch}.tar.xz" -C /usr/local/lib/node --strip-components=1; \
    ln -s /usr/local/lib/node/bin/node /usr/local/bin/node; \
    rm -rf /tmp/*

# Nur der Klient, nicht der Dienst: Container fuer die Spielserver legt das
# Panel ueber den Socket des Wirts an (siehe docker-compose.yml).
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) docker_arch=x86_64 ;; \
      arm64) docker_arch=aarch64 ;; \
      *) echo "Nicht unterstuetzte Architektur: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/bin/docker; \
    rm -rf /tmp/docker

COPY docker/entrypoint.sh /usr/local/bin/dzpage-panel-entrypoint
RUN chmod 0755 /usr/local/bin/dzpage-panel-entrypoint

ENV DZPAGE_PANEL_INSTALL_METHOD=docker \
    DZPAGE_PANEL_BIND=0.0.0.0 \
    DZPAGE_PANEL_PORT=8410

EXPOSE 8410
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DZPAGE_PANEL_PORT||8410)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/dzpage-panel-entrypoint"]
