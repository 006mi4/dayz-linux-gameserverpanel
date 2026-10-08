# DZPage Panel

Selbst gehostetes Gameserver-Panel für **DayZ auf Linux**, über einen
Panel-Schlüssel an dein Konto bei [dzpage.com](https://dzpage.com) gekoppelt.

Das Panel steuert den **Prozess** — installieren, starten, stoppen, Dateien,
Aktualisierungen. RCon steuert das **Spiel** — Nachrichten, Kick, Ban. Beides
zusammen ergibt das, was RCon allein nicht kann: einen abgestürzten Server
wieder hochholen.

*[This guide in English: **[README.md](README.md)**]*

---

## Was du brauchst

- **Linux mit systemd auf x86_64**, entwickelt und von Anfang bis Ende geprüft
  auf Ubuntu 22.04. Ubuntu 24.04 und Debian 12/13 haben dieselben Pakete und
  sollten laufen, sind aber noch nicht vollständig durchgetestet. ARM-Rechner
  lehnt der Installer ab: DayZ-Server und SteamCMD gibt es nur für x86_64. (Der
  Docker-Weg läuft auf jedem x86_64-Wirt, auf dem Docker läuft.)
- **Ein Steam-Konto, das DayZ besitzt.** Anonym lehnt Steam den Download ab
  („No subscription"). Das kann kein Panel umgehen.
- **Ein DZPage-Konto** für den Panel-Schlüssel — kostenlos, und der Schlüssel
  ist das, was dieses Panel mit deinem Konto verbindet.
- Node.js 24 oder neuer. Fehlt es, installiert der Installer eine eigene
  Laufzeit nach `/usr/lib/dzpage-panel/node` — das System bleibt unberührt.
- Etwa 6 GB Plattenplatz je DayZ-Server, dazu ~100 MB für das Panel.

Alles andere — SteamCMD, die 32-Bit-Bibliotheken dafür, git — wird mitinstalliert.

---

## Installation

Zwei Wege hinein. Es sind nicht zwei Produkte: **derselbe Code, derselbe
Aktualisierungskanal** (Git-Etiketten in diesem Repository). Die Wahl richtet
sich danach, wie deine Maschine betrieben wird.

|  | Ein Befehl (systemd) | Docker |
|---|---|---|
| Panel läuft | als eigener, unprivilegierter Benutzer | als root im Container |
| Spielserver laufen | als systemd-Units, **je ein Linux-Benutzer** | als Nachbar-Container |
| Braucht | systemd, apt | Docker + Compose |
| Trennung der Server | je Benutzer, je cgroup-Grenzen | je Container |
| Empfohlen für | einen normalen Server oder VPS | Wirte, auf denen ohnehin alles in Docker läuft |

Der Ein-Befehl-Weg ist die Standardempfehlung. Beim Docker-Weg braucht das Panel
den Docker-Socket, und **wer Zugriff auf diesen Socket hat, ist auf dieser
Maschine faktisch root** — das liegt an Docker, nicht am Panel.

### Weg A: ein Befehl (systemd)

Am einfachsten beginnt es auf dzpage.com: unter **RCon → Server verbinden** auf
**Meinen Befehl holen** klicken. Du bekommst einen Befehl mit einem
Einmal-Kopplungscode darin:

```bash
curl -fsSL https://dzpage.com/panel/install.sh | sudo bash -s -- --pair dzp_pair_…
```

Den fügst du ins Terminal deines Servers ein (SSH). Er installiert das Panel,
verbindet es von selbst mit deinem DZPage-Konto und fragt am Ende nach dem
Steam-Konto, das DayZ besitzt. Das war es. Der Kopplungscode gilt einmal und
eine Stunde.

Ohne diesen Befehl geht es auch:

```bash
curl -fsSL https://dzpage.com/panel/install.sh | sudo bash
```

Am Ende zeigt das Terminal einen Link wie `https://dzpage.com/link?code=K7QF-M2XP`.
Öffnen, prüfen, dass Name und Adresse dein Server sind, **Verbinden** klicken,
und das Terminal bestätigt binnen Sekunden. Später oder nach einem widerrufenen
Schlüssel: `sudo dzpage-panel link`.

`dzpage.com/panel/install.sh` leitet nur auf `bootstrap.sh` in diesem
Repository weiter; `https://raw.githubusercontent.com/006mi4/dayz-linux-gameserverpanel/main/bootstrap.sh`
ist dieselbe Datei. Sie holt das Projekt nach `/opt/dzpage-panel`, checkt die
neueste veröffentlichte Fassung aus und startet `install.sh`. Optionen werden
nach `--` durchgereicht:

```bash
curl -fsSL https://dzpage.com/panel/install.sh | sudo bash -s -- --with-docker
```

Wer das Skript lieber erst liest — eine vernünftige Gewohnheit — macht es in
zwei Schritten:

```bash
sudo git clone https://github.com/006mi4/dayz-linux-gameserverpanel.git /opt/dzpage-panel
sudo /opt/dzpage-panel/install.sh
```

Beides ergibt genau dieselbe Installation, samt Selbstaktualisierung.

Der Installer prüft zuerst die Maschine (x86_64, Verteilung, Arbeitsspeicher,
freier Platz), legt den Dienstbenutzer `dzpage` an, richtet `/etc/dzpage-panel`
und `/var/lib/dzpage-panel` ein, kopiert das Programm nach
`/usr/lib/dzpage-panel`, schreibt die systemd-Unit und startet den Dienst.
**Ein zweiter Lauf aktualisiert nur** — Konfiguration und Daten bleiben stehen.

Verwaltet wird über dzpage.com, deshalb braucht das Panel weder einen offenen
Port noch eine Domain. Seine **lokale Oberfläche** auf `127.0.0.1:8410` bleibt
als optionaler Notzugang: über einen SSH-Tunnel, oder mit eigener Domain und
HTTPS (siehe [Von außen erreichbar machen](#von-außen-erreichbar-machen)).
Solange es dort keinen Administrator gibt, öffnet nur der **Einrichtungscode**,
den der Installer ausgibt, ihren Assistenten. So kann niemand sonst, der den
Port erreicht, das Panel übernehmen.

```bash
ssh -L 8410:127.0.0.1:8410 du@dein-server
```

| Option | Wirkung |
|---|---|
| `--pair <code>` | mit dem Kopplungscode von dzpage.com verbinden |
| `--no-link` | am Ende keinen Kopplungslink anbieten |
| `--domain <name>` | HTTPS für die lokale Oberfläche (Caddy, Let’s Encrypt) |
| `--no-steam-deps` | keine i386-Architektur, keine 32-Bit-Bibliotheken |
| `--no-node` | keine eigene Node-Laufzeit installieren |
| `--with-docker` | Docker-Laufzeit für Spielserver freischalten |

### Der Befehl `dzpage-panel`

Der Installer legt außerdem einen Befehl auf die Maschine, für alles, was die
Weboberfläche selbst nicht kann:

| Befehl | Was er tut |
|---|---|
| `sudo dzpage-panel link` | diesen Server mit deinem DZPage-Konto verbinden (Link und Code) |
| `sudo dzpage-panel steam-login <konto>` | Steam-Anmeldung für die Downloads; das Passwort tippst du direkt in SteamCMD |
| `sudo dzpage-panel status` | Dienst, Fassung, DZPage-Verbindung, Adresse, offener Einrichtungscode |
| `sudo dzpage-panel setup-code` | Einrichtungscode der lokalen Oberfläche |
| `sudo dzpage-panel reset-password [name]` | Passwort vergessen: erzeugt ein neues, beendet alle Sitzungen |
| `sudo dzpage-panel https enable <domain>` | HTTPS für die Oberfläche, auch nachträglich |
| `sudo dzpage-panel https disable` | zurück auf nur `127.0.0.1` |
| `sudo dzpage-panel logs` | Protokoll des Panels mitlesen |
| `sudo dzpage-panel uninstall [--purge]` | Panel entfernen (siehe [Entfernen](#entfernen)) |

### Weg B: Docker

```bash
git clone https://github.com/006mi4/dayz-linux-gameserverpanel.git
cd dayz-linux-gameserverpanel
docker compose up -d
```

Danach läuft die Oberfläche auf **http://127.0.0.1:8410**.

Was die Compose-Datei einrichtet, und warum:

- `/var/run/docker.sock` ist eingehängt, weil das Panel darüber die
  Spielserver-Container startet. Damit ist der Container auf dem Wirt
  root-gleichwertig.
- `/etc/dzpage-panel` und `/var/lib/dzpage-panel` liegen **innen wie außen auf
  demselben Pfad**. Das muss so sein: Die Spielserver-Container hängen ihr
  eigenes Verzeichnis ein, und diesen Pfad löst der Docker-Dienst auf dem Wirt
  auf.
- Der Programmcode des Panels liegt im Datenträger `panel-src`, nicht im Abbild.
  Der Einstieg klont dieses Repository beim ersten Start. Genau das erlaubt dem
  Panel, sich auch im Container über Git zu aktualisieren — ohne Abbild-Speicher
  und ohne Neubau.

Im Docker-Weg ist **Docker die einzige Laufzeit** für Spielserver; im Container
gibt es kein systemd, in das eine Unit gestartet werden könnte.

Der Einrichtungscode liegt im eingehängten Konfigurationsverzeichnis und wird
deshalb auf dem Wirt gelesen:

```bash
sudo cat /etc/dzpage-panel/setup-code
```

---

## Panel-Schlüssel bei DZPage anlegen

Nur nötig, wenn du über den lokalen Assistenten verbindest statt zu koppeln:
Schritt 4 fragt danach. Die Kopplung legt je Server selbst einen Schlüssel an.

1. Bei [dzpage.com](https://dzpage.com) anmelden.
2. **RCon** öffnen (dzpage.com/rcon).
3. Im Abschnitt **Panel-Schlüssel** einen Namen eintragen (zum Beispiel den
   Hostnamen des Servers) und den Schlüssel anlegen.
4. Der Schlüssel (`dzp_panel_…`) erscheint **genau einmal**. Jetzt kopieren.

Der Schlüssel darf ein Panel anmelden, dessen Zustand melden und Server
registrieren — mehr nicht. Kontozugang gibt er nicht. Bei uns liegt er nur als
SHA-256-Hash und ist auf derselben Seite jederzeit widerrufbar.

Bis zu zehn aktive Schlüssel sind möglich, und jedes Panel, das einen benutzt, steht
auf derselben Seite mit Fassung, Plattform und letztem Kontakt.

---

## Der Assistent

Zuerst fragt der Assistent nach dem **Einrichtungscode**, den der Installer
ausgegeben hat (er steht auch in `/etc/dzpage-panel/setup-code`, oder
`sudo dzpage-panel setup-code`). Falsche Versuche werden je Adresse gedrosselt.
Sobald der Administrator existiert, ist der Code gelöscht, und der Weg hinein
führt über die normale Anmeldung.

1. **Datenbank** — SQLite (Standard, keine Einrichtung) oder MySQL/MariaDB mit
   Verbindungstest.
2. **Administratorkonto** — Benutzername und Passwort, gehasht mit scrypt.
3. **Steam-Anmeldung** — Kontoname, Passwort, bei Bedarf Steam-Guard-Code.
   Läuft live gegen SteamCMD; Fehler kommen im Klartext zurück. Überspringbar,
   dann fehlt später nur der Download.
4. **DZPage-Schlüssel** — eintragen, die Verbindung wird sofort geprüft.
5. **Fertig** — weiter zur Übersicht.

Nach der Steam-Anmeldung steht auf derselben Seite „Gemerkte Anmeldung prüfen".
Das startet SteamCMD einmal **ohne Passwort** und beantwortet damit die Frage,
auf die es ankommt: Läuft der Download später ohne Zutun?

Der Assistent ist nur erreichbar, solange die Einrichtung läuft; danach liefern
seine Routen 404. Ab Schritt 3 braucht er eine angemeldete Sitzung — wer später
an den Port kommt, kann das Panel nicht übernehmen.

---

## Spielserver

Unter „Spielserver" wird ein Server angelegt: Name, drei Ports, RCon-Passwort,
Spielerzahl, Mission und die Ressourcengrenzen. Das Panel schreibt daraus
`serverDZ.cfg`, die BattlEye-Konfiguration und die Startumgebung; ein Klick auf
„Spieldateien installieren" holt DayZ über SteamCMD (App 223350).

Danach gibt es Starten, Stoppen, Neustarten, Autostart, den Laufzeitwechsel und
„Bei DZPage anmelden" — letzteres trägt den Server mitsamt RCon-Zugang in dein
DZPage-Konto ein, ohne dass du dort etwas abtippst.

Im systemd-Weg läuft **jeder Server unter einem eigenen Benutzer**
(`dzsrv_<kennung>`), in seinem eigenen Verzeichnis, mit eigenen Speicher- und
CPU-Grenzen. Er kann weder die Konfiguration des Panels lesen noch die Dateien
der Nachbarn.

**Spieldateien installieren und aktualisieren** läuft immer gleich, ob über die
Schaltfläche, einen Auftrag von DZPage oder die automatische Aktualisierung: Ein
laufender Server wird vorher angehalten und danach wieder gestartet. Nach dem
Download fragt das Panel den Lader des Systems (`ldd`), ob `DayZServer` auf
dieser Maschine alle Bibliotheken findet, und nennt fehlende beim Namen.
(Bei Docker-Servern entfällt diese Prüfung: Sie laufen mit den Bibliotheken
des Containers.) Scheitert der Download selbst, bleibt ein vorher fertiger
Server fertig und läuft mit den alten Dateien wieder an, denn SteamCMD tauscht
sie erst ganz am Ende. Scheitert ein Schritt nach dem Download, etwa an einer
fehlenden Bibliothek, liegen die neuen Dateien schon da: Der Server steht dann
auf „fehlgeschlagen“ und bleibt angehalten, bis die Installation gelingt. Ein
neuer Server startet ab der ersten Installation mit der Maschine.

**Firewall.** Spieler und das RCon von DZPage erreichen einen Server von außen,
deshalb müssen seine drei UDP-Ports (Spiel, Query, RCon) offen sein. Ist `ufw`
oder `firewalld` aktiv, öffnet das Panel sie vor jedem Start und schließt sie
beim Löschen wieder (ufw-Regeln tragen den Kommentar `dzpage-panel <kennung>`).
Von Hand gepflegte iptables- oder nftables-Regeln bleiben unberührt. Die
Serverseite zeigt den Stand unter **Firewall**. Eine Firewall beim Hoster (etwa
die Hetzner Cloud Firewall) sieht die Maschine nicht; dort die Ports ebenfalls
freigeben.

**Löschen** hält den Server an, entfernt Benutzer, Unit, Firewall-Regeln und
Dateien und schaltet ihn bei DZPage ab, damit er dort nicht als Leiche stehen
bleibt.

### serverDZ.cfg bearbeiten

**Spielserver → dein Server → Konfiguration** bearbeitet die Serverkonfiguration,
und das ist auch der einzige Ort, an dem man sie bearbeiten sollte: Das Panel
schreibt `serverDZ.cfg` bei jeder Installation und jedem DayZ-Update neu, eine
Änderung auf der Platte wäre spätestens beim nächsten Update weg. Die Werte
stehen deshalb in der Datenbank des Panels, und die Datei entsteht daraus.

Die Seite hat drei Teile:

- **Grundwerte** — Name, Spielerzahl und Mission. Sie haben eigene Felder, weil
  das Panel sie auch anderswo braucht (Übersicht, Anmeldung bei DZPage). Wird
  ein angemeldeter Server umbenannt, zieht der Name bei DZPage mit.
- **serverDZ.cfg** — alle übrigen Werte als Liste aus Schlüssel und Wert. Wert
  ändern, „Entfernen" ankreuzen, oder in der letzten Zeile einen neuen Schlüssel
  samt Wert eintragen — auch einen, den dieses Panel nicht kennt. Alles, was
  DayZ versteht, geht hier; `verifySignatures`, `disable3rdPerson`,
  `serverTimeAcceleration` und die anderen sind mit den Werten vorbelegt, mit
  denen ein frischer Server startet.
- **Vorschau** — genau die Datei, die das Panel schreiben wird.

Geschrieben wird so, wie man es erwartet: Zahlen nackt, alles andere in
Anführungszeichen. Ein Wert, der schon mit `{` oder `"` beginnt, wird unverändert
übernommen — so gehen Listen:

```
motd[]   = {"Willkommen","Regeln lesen"}
respawnTime = 5
serverTime  = SystemTime
```

Ports lassen sich hier nicht ändern. Sie hängen an der Anmeldung bei DZPage, an
BattlEye und an der Portprüfung gegen die anderen Server dieses Panels — ein
Port ist keine Einstellung, sondern die Identität des Servers.

Änderungen werden sofort geschrieben, wirken aber erst beim nächsten Neustart
des Servers; DayZ liest die Datei genau einmal, beim Start.

### Laufzeit: systemd oder Docker

Standard ist systemd. Docker ist eine Umschaltung im Panel, kein zweiter
Installationsweg: Die Spieldateien bleiben, wo sie sind, und werden in den
Container eingehängt — ein Wechsel kostet keinen Neu-Download.

Zum Freischalten einmalig `sudo ./install.sh --with-docker`. Damit kommt der
Dienstbenutzer in die Gruppe `docker`, und das entspricht auf dieser Maschine
faktisch Rootrechten. Wer diese Laufzeit nicht braucht, lässt die Option weg.

Das Container-Abbild ist über `DZPAGE_PANEL_DOCKER_IMAGE` einstellbar (Standard
`debian:bookworm-slim`); es muss die Bibliotheken mitbringen, die der
DayZ-Server erwartet.

---

## Aktualisierungen

Zwei verschiedene Dinge heißen hier „Update", und das Panel hält sie auseinander.

### Das Panel selbst

Unter **Aktualisierungen/Dieses Panel** stehen die laufende Fassung, die neueste
Freigabe und die Quelle. Das Panel fragt alle sechs Stunden bei GitHub nach den
Etiketten dieses Repositorys — ohne Konto, ohne Schlüssel, nur lesend — und
nimmt das höchste `vX.Y.Z` als neueste Fassung. Vorabfassungen (`v1.2.3-rc1`)
bleiben außen vor.

| Einstellung | Was bei einer neuen Fassung passiert |
|---|---|
| **selbst einspielen** (Standard) | das Panel spielt sie ein und startet neu |
| **nur melden, ich entscheide** | sie steht hier und im Ereignisprotokoll; du drückst den Knopf |
| **gar nicht nachsehen** | nichts |

Beim Einspielen startet das Panel neu. **Die Spielserver laufen weiter** — sie
sind eigene Units (oder Container) und werden nicht angefasst.

Kommt die neue Fassung nicht hoch, wird die vorherige selbsttätig
wiederhergestellt:

- systemd-Weg: Die Aktualisierung läuft als eigener, kurzlebiger Dienst, wartet
  auf `/health` und nimmt bei einem Fehlstart den vorherigen Stand zurück. Das
  Ergebnis überlebt den Neustart in `/var/lib/dzpage-panel/self-update.json`,
  das ausführliche Protokoll liegt daneben in `self-update.log`.
- Docker-Weg: Der Einstieg zählt die Startversuche. Nach dem dritten
  gescheiterten Start setzt er das Arbeitsverzeichnis auf den letzten Stand
  zurück, der nachweislich hochkam — eine kaputte Fassung kann also keine
  Neustartschleife hinterlassen.

Ein Fork bekommt seine eigenen Fassungen gemeldet: Die Adresse steht in
`/etc/dzpage-panel/install.json`, die der Installer schreibt.

Wer die Dateien von Hand kopiert hat, bekommt neue Fassungen gemeldet, aber
nichts überschrieben. Solche Installationen selbst aktualisieren und danach
`sudo ./install.sh` erneut laufen lassen.

### Die DayZ-Spieldateien

Unter **Aktualisierungen/Server** fragt das Panel Steam nach dem Stand des
DayZ-Servers und vergleicht ihn mit den installierten Dateien. Verglichen werden
zwei Zahlen aus Steams eigenem Format: die `buildid` aus
`game/steamapps/appmanifest_223350.acf` und `depots.branches.public.buildid` aus
`app_info_print`.

**Die Abfrage meldet sich anonym an.** Für die Auskunft über eine öffentliche
App braucht Steam kein Konto — die Prüfung läuft also auch, bevor du dich bei
Steam angemeldet hast. Nur das Herunterladen braucht dein Konto. Sie bekommt ein
eigenes HOME (`/var/lib/dzpage-panel/steam-info-home`), damit die anonyme
Anmeldung das Sitzungstoken deines Kontos nicht anfasst.

Einstellbar ist zweierlei, und die Trennung ist Absicht:

| | wo | Werte |
|---|---|---|
| Zeitplan | einmal für das Panel | aus, oder alle 30 min bis 24 h |
| Verhalten | je Server | aus · nur melden · automatisch aktualisieren |

„Automatisch aktualisieren" hält den Server an, holt die Dateien und startet ihn
wieder — ohne Vorwarnung im Spiel. Für einen Server mit Leuten darauf ist „nur
melden" die richtige Wahl; die Vorwarnung gehört zum Neustartzeitplan über
DZPage, weil sie über RCon geht.

Der Zeitplan ist im Auslieferungszustand **aus**. Ein Panel, das ungefragt
SteamCMD startet, ist nicht das, was jemand auf seiner Maschine erwartet.
„Jetzt prüfen" prüft immer nur — eine Schaltfläche mit dieser Aufschrift darf
keinen Server neu starten.

---

## Fernsteuerung über DZPage

Sobald ein Server registriert ist, hat er auf dzpage.com unter RCon den
Abschnitt „Betrieb": starten, stoppen, neu starten, Dateien aktualisieren und
einen Neustartzeitplan. Die Vorwarnung im Spiel geht über RCon, der Neustart
über das Panel — diese Kombination braucht beide Hälften.

Das Panel hält dafür eine ausgehende Verbindung offen (Long-Poll) und holt sich
Aufträge ab. **Für das Panel selbst muss kein Port geöffnet werden**, und es
funktioniert hinter CGNAT. (Die Spielserver brauchen ihre Ports, siehe Firewall
oben: Das RCon von DZPage verbindet sich mit ihnen.) Jeder Auftrag wird geprüft,
bevor er ausgeführt wird: bekannte Auftragsart, Zielserver gehört zu diesem
Panel, ein Start braucht installierte Spieldateien, Ergebnis geht zurück, alles
landet im Ereignisprotokoll. Aufträge für denselben Server laufen nacheinander,
nie gleichzeitig.

---

## Von außen erreichbar machen

Das Panel bindet sich absichtlich an `127.0.0.1`. Für den Zugriff von außen
gehört ein Reverse-Proxy mit TLS davor — ein Panel ohne TLS ins Internet zu
stellen ist die Standardfalle bei solchen Produkten.

**Der bequeme Weg** ist eingebaut. Einen DNS-Eintrag (A-Eintrag) auf die
Maschine zeigen lassen, dann:

```bash
sudo dzpage-panel https enable panel.example.com
```

Das installiert bei Bedarf [Caddy](https://caddyserver.com) aus dem offiziellen
Paketarchiv, schreibt `/etc/caddy/dzpage-panel.caddy`, öffnet 80 und 443 in ufw
oder firewalld und sagt dem Panel, dass ein Proxy davorsteht. Caddy holt das
Zertifikat bei Let’s Encrypt und erneuert es selbst. Lauscht auf Port 80 oder
443 schon etwas anderes, bricht das Skript ab und ändert nichts; dann den
eigenen Proxy nehmen. `sudo dzpage-panel https disable` macht es rückgängig
(Caddy selbst bleibt installiert).

**Ein eigener Proxy**, zum Beispiel nginx:

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8410;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Dazu in `/etc/dzpage-panel/panel.json` `"trustProxy": true` setzen (oder
`Environment=DZPAGE_PANEL_TRUST_PROXY=1` als Ergänzung zu `dzpage-panel.service`)
und den Dienst neu starten. Erst dann wertet das Panel `X-Forwarded-Proto` aus
und setzt das Secure-Flag auf dem Sitzungscookie; ohne das weist die
Herkunftsprüfung jedes Formular ab, das über https kommt.

---

## Konfiguration

`/etc/dzpage-panel/panel.json`, Rechte 0600, gehört dem Dienstbenutzer.

| Feld | Bedeutung |
|---|---|
| `bind`, `port` | Standard `127.0.0.1:8410` |
| `trustProxy` | nur einschalten, wenn wirklich ein Proxy davorsteht |
| `cookieSecure` | `"auto"` (Standard), `true` oder `false` |
| `database` | `{"kind":"sqlite","file":…}` oder `{"kind":"mysql",…}` |
| `secrets` | Sitzungs- und Verschlüsselungsschlüssel, beim ersten Start erzeugt |
| `dzpage` | Adresse, Panel-Schlüssel, Name dieses Panels |
| `steam.steamcmdPath` | gefundenes oder installiertes SteamCMD |

`/etc/dzpage-panel/install.json` schreibt der Installer. Darin steht, wie dieses
Panel installiert wurde (`git`, `docker` oder `manual`), aus welchem Repository
und mit welchen Optionen. Sie gehört root: Das Panel liest sie, ändern darf es
sie nicht.

Ablageorte: Konfiguration `/etc/dzpage-panel/`, Daten und Spieldateien
`/var/lib/dzpage-panel/`, Protokoll über journald
(`journalctl -u dzpage-panel -f`).

**MySQL** braucht ein Paket mehr — nur dann, wenn es auch gewählt wird:

```bash
sudo -u dzpage npm install --omit=dev --prefix /usr/lib/dzpage-panel mysql2
```

---

## Sicherheit

- **Nie als root.** Dienstbenutzer `dzpage`, systemd-Unit mit
  `ProtectSystem=strict`, leerem `CapabilityBoundingSet` und Ressourcengrenzen.
- **Der privilegierte Helfer.** Dienste anlegen und Benutzer erzeugen kann kein
  unprivilegierter Prozess. Statt das Panel als root laufen zu lassen, schickt
  es eine Zeile an einen Socket (`/run/dzpage-panel-helper.sock`, nur für den
  Dienstbenutzer zu öffnen), und systemd startet dafür kurz `helper.sh` als
  root. Der Helfer kennt genau dreizehn Operationen (Dienste, Zustand,
  Protokoll, Firewall-Ports, Selbstaktualisierung) und prüft jeden Parameter
  gegen ein Muster; eine Operation mit einem falschen Parameter bricht ab und
  meldet einen Fehlercode. sudo wäre der übliche Weg, funktioniert hier aber
  nicht: Die Unit des Panels setzt über `PrivateDevices` und
  `ProtectKernelTunables` implizit `NoNewPrivileges`, und damit kann sudo keine
  Rechte mehr erhöhen.
- **Einrichtungscode statt „wer zuerst kommt“.** Solange es keinen
  Administrator gibt, öffnet nur der Einmal-Code aus dem Installer den lokalen
  Assistenten.
- **Koppeln, ohne Geheimnisse abzutippen.** Der Kopplungscode im
  Installationsbefehl gilt einmal und eine Stunde, der Code im Link 15 Minuten,
  und die Seite auf dzpage.com zeigt Name und Adresse der Maschine, bevor du
  bestätigst. Das Panel bekommt nie etwas anderes als seinen eigenen,
  widerrufbaren Schlüssel.
- **Keine Shell in der Oberfläche.** Alle Aktionen sind feste, benannte
  Operationen; Prozesse werden mit Argumentlisten gestartet, nie über eine
  Shell-Zeichenkette. Was doch durch eine Kommandozeile muss, wird gegen eine
  Positivliste geprüft.
- **Kein JavaScript im Browser.** Die Inhaltsrichtlinie ist entsprechend streng
  (`default-src 'none'`), jedes Formular trägt einen CSRF-Wert, dazu kommt eine
  Origin-Prüfung.
- Passwörter mit scrypt (N=2^15, r=8, p=1, 32 Byte Salt), Sitzungen als
  HttpOnly-Cookie mit `SameSite=Strict`, Anmeldeversuche gedrosselt.
- **Das Steam-Passwort wird nirgends gespeichert.** Es geht durch eine
  Pseudo-Konsole direkt an SteamCMD und wird danach verworfen; gespeichert wird
  nur, was SteamCMD selbst ablegt. Passwort und Steam-Guard-Code stehen auf der
  Streichliste des Vorgangs und erscheinen in keinem Protokoll.
- Der DZPage-Schlüssel liegt bei uns nur als SHA-256-Hash und ist jederzeit
  widerrufbar. Das Panel ruft immer nur bei DZPage an — **keine Portfreigabe**.

### SteamCMD: gemessenes Verhalten

Gegen Client-Version 1785799152 auf Ubuntu 22.04 gemessen (2026-08-06), weil
drei Eigenheiten sonst zu falschen Ergebnissen führen:

- Die Ausgabe ist **eingefärbt**. Hinter jeder Eingabeaufforderung steht eine
  Rückstellsequenz (`password: \x1b[0m`); ohne Filter trifft kein Muster.
- Der Start enthält harmlose Zeilen wie `ILocalize::AddFile() failed to load
  file` — ein Fehlermuster, das `failed` ohne Rücksicht auf Groß-/Kleinschreibung
  sucht, meldet eine Anmeldung fälschlich als gescheitert.
- Das Ergebnis steht **mitten in der Zeile**:
  `Logging in user 'x' [U:1:0] to Steam Public...ERROR (Invalid Password)`.
  Danach kehrt `Steam>` zurück — ein unbekannter Fehlergrund würde also als
  Erfolg durchgehen, wenn nur der Zeilenanfang geprüft wird.

Der erste Start lädt sich selbst nach und startet sich neu; das dauert ein bis
zwei Minuten und ist kein Fehler.

---

## Entfernen

```bash
sudo dzpage-panel uninstall
```

Das hält das Panel und alle Spielserver an und entfernt Dienste,
Serverbenutzer, die Firewall-Regeln des Panels, seine Caddy-Seite und das
Programm. Spieldateien, Speicherstände, Datenbank und Konfiguration bleiben in
`/var/lib/dzpage-panel` und `/etc/dzpage-panel` liegen; eine neue Installation
setzt dort wieder auf. Auch das löschen (nicht umkehrbar):

```bash
sudo dzpage-panel uninstall --purge
```

Docker-Weg:

```bash
docker compose down -v
sudo rm -rf /etc/dzpage-panel /var/lib/dzpage-panel
```

---

## Entwicklung

```bash
npm test                     # ohne Netz, ohne Datenbankserver, ohne Rootrechte
DZPANEL_NET_TESTS=1 npm test # zusätzlich die echte SteamCMD-Installation
```

Zwei Abnahmen brauchen ein echtes System und laufen deshalb getrennt:

```bash
sudo ./scripts/verify-runtime.sh   # systemd: eigener Benutzer, Grenzen, Absturz, Aufräumen
sudo ./scripts/verify-docker.sh    # Docker und der Wechsel zwischen beiden Laufzeiten
```

Beide setzen ein installiertes Panel voraus und benutzen an Stelle von DayZ ein
Ersatzprogramm — die echten Spieldateien brauchen ein Steam-Konto mit DayZ.

Für den MySQL-Teil eine Datenbank angeben:

```bash
DZPANEL_MYSQL_HOST=127.0.0.1 DZPANEL_MYSQL_USER=dzpanel \
DZPANEL_MYSQL_PASSWORD=… DZPANEL_MYSQL_DATABASE=dzpanel_test npm test
```

Ohne Rootrechte starten (Pfade umbiegen):

```bash
DZPAGE_PANEL_CONFIG_DIR=/tmp/panel/etc DZPAGE_PANEL_DATA_DIR=/tmp/panel/lib \
DZPAGE_PANEL_PORT=8411 node bin/dzpage-panel.js
```

`DZPAGE_BASE_URL` biegt die DZPage-Adresse um (für Tests gegen einen
Standhalter), `DZPAGE_PANEL_GITHUB_API` die GitHub-Adresse (für Tests der
Update-Prüfung).

### Eine Fassung veröffentlichen

Die Fassung steht in `src/version.js` und `package.json` — ein Test hält beide
zusammen. Sie wird bei jeder Anmeldung und jedem Herzschlag an DZPage gemeldet
und ist die Zahl, gegen die die Update-Prüfung vergleicht.

```bash
git tag v0.4.0 && git push origin v0.4.0
```

Jedes Panel da draußen sieht dieses Etikett binnen sechs Stunden. Es gibt keinen
Bauschritt und kein Artefakt: Das Etikett *ist* die Freigabe.

### Sprache der Oberfläche

Die Oberfläche gibt es auf Englisch (Standard) und Deutsch. Eine weitere Sprache
ist eine Datei in `src/i18n/` plus ein Eintrag in `src/i18n/index.js`; ein Test
sorgt dafür, dass keine Sprache Schlüssel vergisst.
