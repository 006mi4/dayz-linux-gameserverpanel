# DZPage Panel

Selbst installierbares Gameserver-Panel für DayZ auf Linux, gekoppelt an ein
DZPage-Konto über einen Panel-Schlüssel.

Das Panel steuert den **Prozess** (installieren, starten, stoppen, Dateien),
RCon steuert das **Spiel** (Nachrichten, Kick, Ban). Beides zusammen ergibt das,
was RCon allein nicht kann: einen abgestürzten Server wieder hochholen.

**Stand: Phase 2 (Panel-Kern).** Enthalten sind Dienst, Einrichtungsassistent,
SQLite/MySQL, Anmeldung mit scrypt, SteamCMD-Installation und der interaktive
Steam-Login. Das Anlegen und Starten von Spielservern kommt mit Phase 3.

---

## Voraussetzungen

- Linux mit systemd (entwickelt und geprüft auf Ubuntu 22.04)
- `util-linux` (liefert `script`), `tar`, `curl` — auf Debian/Ubuntu im Grundsystem
- 32-Bit-Bibliothek `lib32gcc-s1`: SteamCMD ist auch auf 64-Bit-Systemen 32-Bit
- Node.js 24 oder neuer. Fehlt es, installiert der Installer eine eigene
  Laufzeit nach `/usr/lib/dzpage-panel/node` — das System bleibt unberührt.
  Node 22/23 gehen auch, dann startet der Dienst mit `--experimental-sqlite`
  (der Installer prüft das selbst).
- **Ein Steam-Konto, das DayZ besitzt.** Anonym lehnt Steam den Download ab
  („No subscription"). Das kann kein Panel umgehen.

## Installation

```sh
sudo ./install.sh
```

Der Installer legt den Dienstbenutzer `dzpage` an, richtet
`/etc/dzpage-panel` und `/var/lib/dzpage-panel` ein, kopiert das Programm nach
`/usr/lib/dzpage-panel`, schreibt die systemd-Unit und startet den Dienst.
Ein zweiter Lauf aktualisiert nur — Konfiguration und Daten bleiben stehen.

Optionen: `--no-steam-deps` (keine 32-Bit-Bibliotheken), `--no-node` (keine
eigene Node-Laufzeit installieren).

Danach läuft die Oberfläche auf **http://127.0.0.1:8410**.

**Vor dem Assistenten** auf dzpage.com unter `/rcon` einen Panel-Schlüssel
erstellen (`dzp_panel_…`) — der Assistent fragt im vierten Schritt danach.

## Der Assistent

1. **Datenbank** — SQLite (Standard, keine Einrichtung) oder MySQL/MariaDB mit
   Verbindungstest.
2. **Administratorkonto** — Benutzername und Passwort, gehasht mit scrypt.
3. **Steam-Anmeldung** — Kontoname, Passwort, bei Bedarf Steam-Guard-Code.
   Läuft live gegen SteamCMD; Fehler kommen im Klartext zurück. Überspringbar,
   dann fehlt später nur der Download.
4. **DZPage-Schlüssel** — eintragen, die Verbindung wird sofort geprüft.
5. **Fertig** — weiter zur Übersicht.

Der Assistent ist nur erreichbar, solange die Einrichtung läuft; danach liefern
seine Routen 404. Ab Schritt 3 braucht er eine angemeldete Sitzung — wer später
an den Port kommt, kann das Panel nicht übernehmen.

## Von außen erreichbar machen

Das Panel bindet sich absichtlich an `127.0.0.1`. Für den Zugriff von außen
gehört ein Reverse-Proxy mit TLS davor — ein Panel ohne TLS ins Internet zu
stellen ist die Standardfalle bei solchen Produkten.

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

Dazu in `/etc/dzpage-panel/panel.json` `"trustProxy": true` setzen und den
Dienst neu starten. Erst dann wertet das Panel `X-Forwarded-Proto` aus und
setzt das Secure-Flag auf dem Sitzungscookie.

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

Ablageorte: Konfiguration `/etc/dzpage-panel/`, Daten und Spieldateien
`/var/lib/dzpage-panel/`, Protokoll über journald (`journalctl -u dzpage-panel -f`).

**MySQL** braucht ein Paket mehr — nur dann, wenn es auch gewählt wird:

```sh
sudo -u dzpage npm install --omit=dev --prefix /usr/lib/dzpage-panel mysql2
```

## Sicherheit

- Nie als root: Dienstbenutzer `dzpage`, systemd-Unit mit `ProtectSystem=strict`,
  leerem `CapabilityBoundingSet` und Ressourcengrenzen.
- Keine Shell in der Oberfläche. Alle Aktionen sind feste, benannte Operationen;
  Prozesse werden mit Argumentlisten gestartet, nie über eine Shell-Zeichenkette.
  Was doch durch eine Kommandozeile muss, wird gegen eine Positivliste geprüft.
- Kein JavaScript im Browser. Die Inhaltsrichtlinie ist entsprechend streng
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

## SteamCMD: gemessenes Verhalten

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

## Entwicklung

```sh
npm test                     # 43 Tests, ohne Netz und ohne Datenbankserver
DZPANEL_NET_TESTS=1 npm test # zusätzlich die echte SteamCMD-Installation
```

Für den MySQL-Teil eine Datenbank angeben:

```sh
DZPANEL_MYSQL_HOST=127.0.0.1 DZPANEL_MYSQL_USER=dzpanel \
DZPANEL_MYSQL_PASSWORD=… DZPANEL_MYSQL_DATABASE=dzpanel_test npm test
```

Ohne Rootrechte starten (Pfade umbiegen):

```sh
DZPAGE_PANEL_CONFIG_DIR=/tmp/panel/etc DZPAGE_PANEL_DATA_DIR=/tmp/panel/lib \
DZPAGE_PANEL_PORT=8411 node bin/dzpage-panel.js
```

`DZPAGE_BASE_URL` biegt die DZPage-Adresse um (für Tests gegen einen Standhalter).
Die Version steht in `src/version.js` und wird bei jeder Anmeldung an DZPage
gemeldet — bei jeder Änderung erhöhen.

Die Oberfläche gibt es auf Englisch (Standard) und Deutsch. Eine weitere Sprache
ist eine Datei in `src/i18n/` plus ein Eintrag in `src/i18n/index.js`; ein Test
sorgt dafür, dass keine Sprache Schlüssel vergisst.

## Entfernen

```sh
sudo systemctl disable --now dzpage-panel
sudo rm -f /etc/systemd/system/dzpage-panel.service
sudo systemctl daemon-reload
sudo rm -rf /usr/lib/dzpage-panel /etc/dzpage-panel
sudo rm -rf /var/lib/dzpage-panel     # löscht auch Spieldateien und Datenbank
sudo userdel dzpage
```
