# DZPage Panel

A self-hosted game server panel for **DayZ on Linux**, linked to your
[dzpage.com](https://dzpage.com) account with a panel key.

The panel controls the **process** — install, start, stop, files, updates. RCon
controls the **game** — messages, kick, ban. Together they do what RCon alone
cannot: bring a crashed server back up.

*[Diese Anleitung auf Deutsch: **[README.de.md](README.de.md)**]*

---

## Contents

- [What you need](#what-you-need)
- [Install](#install) — [one command](#option-a-one-command-systemd) or [Docker](#option-b-docker), and the [`dzpage-panel` command](#the-dzpage-panel-command)
- [Create your panel key on DZPage](#create-your-panel-key-on-dzpage)
- [The setup wizard](#the-setup-wizard)
- [Game servers](#game-servers)
- [Updates](#updates)
- [Remote control from DZPage](#remote-control-from-dzpage)
- [Reaching the panel from outside](#reaching-the-panel-from-outside)
- [Configuration](#configuration)
- [Security](#security)
- [Uninstall](#uninstall)
- [Development](#development)

---

## What you need

- **Linux with systemd on x86_64**, tested end to end on Ubuntu 22.04, Ubuntu
  24.04 and Debian 12 (also a minimal Debian 12 without sudo, git or xz).
  Debian 13 uses the same packages and should work, but has not been run
  through completely yet. ARM machines are refused: the
  DayZ server and SteamCMD only exist for x86_64. (The Docker install works on
  any x86_64 host that runs Docker.)
- **A Steam account that owns DayZ.** Steam refuses the server download to
  anonymous logins (“No subscription”). No panel can work around that.
- **A DZPage account** for the panel key — free, and the key is what links this
  panel to your account.
- Node.js 24 or newer. If it is missing, the installer puts its own runtime in
  `/usr/lib/dzpage-panel/node` and leaves your system alone.
- About 6 GB of disk per DayZ server, plus ~100 MB for the panel.

Everything else — SteamCMD, the 32-bit libraries it needs, git — is installed
for you.

---

## Install

Two ways in. They are not two products: the **same code, the same update
channel** (git tags in this repository). Pick by how you run your box.

|  | One command (systemd) | Docker |
|---|---|---|
| Panel runs | as its own unprivileged user | as root inside a container |
| Game servers run | as systemd units, **one Linux user each** | as sibling containers |
| Needs | systemd, apt | Docker + Compose |
| Isolation between servers | per user, per cgroup limits | per container |
| Recommended for | a normal server or VPS | hosts where everything already runs in Docker |

The one-command install is the default recommendation. In the Docker install the
panel needs the Docker socket, and **access to the Docker socket is equivalent
to root on that machine** — that is how Docker works, not something the panel
chooses.

### Option A: one command (systemd)

The easiest way starts on dzpage.com: under **RCon → Connect a server**, click
**Get my command**. You get a command with a one-time pairing code in it:

```bash
curl -fsSL https://dzpage.com/panel/install.sh | sudo bash -s -- --pair dzp_pair_…
```

Paste it into the terminal of your server (SSH). It installs the panel, links
it to your DZPage account on its own, and at the end asks for the Steam account
that owns DayZ. Before it links, the terminal shows the DZPage account name and
asks whether that is yours, the same way AirDrop asks before it accepts. That
is all. The pairing code works once and expires after 30 minutes.

Logged in as root on a machine without `sudo` (Debian installed with a root
password has none)? Then leave out `sudo`, everything else stays the same:
`curl -fsSL https://dzpage.com/panel/install.sh | bash -s -- --pair dzp_pair_…`.
With `sudo` there, the command stops at once with "sudo: command not found".

Without that command it works too:

```bash
curl -fsSL https://dzpage.com/panel/install.sh | sudo bash
```

At the end the terminal shows a link like `https://dzpage.com/link?code=K7QF-M2XP`.
Open it, check that name and address are your server, click **Connect**, and
the terminal confirms within seconds. Later, or after a revoked key:
`sudo dzpage-panel link`.

`dzpage.com/panel/install.sh` simply forwards to `bootstrap.sh` in this
repository; `https://raw.githubusercontent.com/006mi4/dayz-linux-gameserverpanel/main/bootstrap.sh`
is the same file. It clones the project to `/opt/dzpage-panel`, checks out the
newest released tag and runs `install.sh`. Options are passed through after `--`:

```bash
curl -fsSL https://dzpage.com/panel/install.sh | sudo bash -s -- --with-docker
```

If you would rather read the script before it runs — a reasonable habit — do it
in two steps:

```bash
sudo git clone https://github.com/006mi4/dayz-linux-gameserverpanel.git /opt/dzpage-panel
sudo /opt/dzpage-panel/install.sh
```

Both give you exactly the same installation, including self-updates.

The installer checks the machine first (x86_64, distribution, memory, free
disk), creates the service user `dzpage`, sets up `/etc/dzpage-panel` and
`/var/lib/dzpage-panel`, copies the program to `/usr/lib/dzpage-panel`, writes
the systemd unit and starts the service. **Running it again only updates** —
configuration and data stay untouched.

The panel is managed from dzpage.com, so it needs no open port and no domain.
Its **local interface** on `127.0.0.1:8410` stays as an optional fallback:
reach it with an SSH tunnel, or give it its own domain with HTTPS (see
[Reaching the panel from outside](#reaching-the-panel-from-outside)). Until an
administrator exists there, only the **setup code** the installer prints opens
its wizard, so nobody else who reaches the port can take the panel over.

```bash
ssh -L 8410:127.0.0.1:8410 you@your-server
```

Options:

| Option | Effect |
|---|---|
| `--pair <code>` | link to DZPage with the pairing code from dzpage.com |
| `--no-link` | do not offer the pairing link at the end |
| `--domain <name>` | HTTPS for the local interface (Caddy, Let’s Encrypt) |
| `--no-steam-deps` | do not add the i386 architecture or 32-bit libraries |
| `--no-node` | do not install a private Node runtime |
| `--with-docker` | allow the Docker runtime for game servers (see below) |

### The `dzpage-panel` command

The installer also puts a command on the machine for everything the web
interface cannot do itself:

| Command | What it does |
|---|---|
| `sudo dzpage-panel link` | link this server to your DZPage account (link and code) |
| `sudo dzpage-panel steam-login <account>` | Steam login for the downloads; you type the password straight into SteamCMD |
| `sudo dzpage-panel status` | service state, version, DZPage link, address, open setup code |
| `sudo dzpage-panel setup-code` | show the setup code of the local interface |
| `sudo dzpage-panel reset-password [name]` | forgot the password: generates a new one, ends all sessions |
| `sudo dzpage-panel https enable <domain>` | HTTPS for the interface, also later |
| `sudo dzpage-panel https disable` | back to `127.0.0.1` only |
| `sudo dzpage-panel logs` | follow the panel log |
| `sudo dzpage-panel uninstall [--purge]` | remove the panel (see [Uninstall](#uninstall)) |

### Option B: Docker

```bash
git clone https://github.com/006mi4/dayz-linux-gameserverpanel.git
cd dayz-linux-gameserverpanel
docker compose up -d
```

The panel is then at **http://127.0.0.1:8410**.

What the compose file sets up, and why:

- `/var/run/docker.sock` is mounted, because that is how the panel starts the
  game server containers. It also means the container is root-equivalent on the
  host.
- `/etc/dzpage-panel` and `/var/lib/dzpage-panel` are bind-mounted **at the same
  paths inside and outside**. That is required: game server containers mount
  their own directory, and the Docker daemon resolves that path on the host.
- The panel’s own code lives in the volume `panel-src`, not in the image. The
  entrypoint clones this repository on first start. That is what lets the panel
  update itself over git in the container too — no image registry, no rebuild.

In the Docker install, **Docker is the only runtime** for game servers; there is
no systemd inside the container to start a unit in.

The setup code is in the bind-mounted configuration directory, so you read it on
the host:

```bash
sudo cat /etc/dzpage-panel/setup-code
```

---

## Create your panel key on DZPage

Only needed if you connect through the local wizard instead of pairing: step 4
asks for it. Pairing creates a key per server by itself.

1. Sign in at [dzpage.com](https://dzpage.com).
2. Open **RCon** (dzpage.com/rcon).
3. In the **Panel keys** section, enter a name (for example the hostname of your
   server) and create the key.
4. The key (`dzp_panel_…`) is shown **exactly once**. Copy it now.

The key lets a panel register itself, report its state and register servers on
your account — nothing else. It does not grant access to your account. We store
only a SHA-256 hash of it, and you can revoke it at any time on the same page.

You can have up to ten active keys, and every panel that uses one shows up on that
page with its version, platform and last contact.

---

## The setup wizard

First the wizard asks for the **setup code** the installer printed (also in
`/etc/dzpage-panel/setup-code`, or `sudo dzpage-panel setup-code`). Wrong
attempts are throttled per address. Once the administrator exists, the code is
deleted and the way in is the normal sign-in.

1. **Database** — SQLite (default, nothing to set up) or MySQL/MariaDB with a
   connection test.
2. **Administrator** — username and password, hashed with scrypt.
3. **Steam login** — account name, password, Steam Guard code if asked. This
   runs live against SteamCMD and reports errors verbatim. You can skip it; then
   only the download is missing later.
4. **DZPage key** — paste the key, the connection is verified immediately.
5. **Done** — on to the dashboard.

After the Steam login the same page offers **“Check the remembered login”**. It
starts SteamCMD once **without a password** and answers the question that
actually matters: will the download work later without anyone typing anything?

The wizard is only reachable while setup is running; afterwards its routes
return 404. From step 3 on it needs a signed-in session, so nobody who finds the
port later can take the panel over.

---

## Game servers

Under **Game servers** you create a server: name, three ports, RCon password,
player count, mission and the resource limits. The panel writes `serverDZ.cfg`,
the BattlEye configuration and the start environment from that; one click on
**Install game files** fetches DayZ through SteamCMD (app 223350).

After that you get start, stop, restart, autostart, the runtime switch and
**“Register with DZPage”** — the last one puts the server, including its RCon
access, into your DZPage account without you typing anything there.

In the systemd install **every server runs as its own user** (`dzsrv_<id>`), in
its own directory, with its own memory and CPU limits. It can read neither the
panel’s configuration nor its neighbours’ files.

**Installing and updating the game files** works the same way whether you press
the button, DZPage sends an update job, or the automatic update kicks in: a
running server is stopped first and started again afterwards. After the
download the panel asks the system loader (`ldd`) whether `DayZServer` finds all
its libraries on this machine and names any that are missing (for Docker
servers this check is skipped: they run with the container’s libraries). If the
download itself fails, a server that was ready stays ready and comes back up
with its old files, because SteamCMD only swaps them at the very end. If a step
after the download fails, for example a missing library, the new files are
already in place: the server is marked failed and stays stopped until the
installation succeeds. A new server is set to start with the machine once its
files are installed.

**Firewall.** Players and DZPage’s RCon reach a server from outside, so its
three UDP ports (game, query, RCon) must be open. If `ufw` or `firewalld` is
active, the panel opens them before every start and closes them when the server
is deleted (ufw rules carry the comment `dzpage-panel <id>`). Hand-written
iptables or nftables rules are left alone. The server page shows the state under
**Firewall**. A firewall at your host (for example a Hetzner Cloud Firewall)
cannot be seen from the machine; open the ports there as well.

**Deleting** a server stops it, removes its user, unit, firewall rules and files,
and switches it off on DZPage, so it does not linger in your account.

### Editing serverDZ.cfg

**Game servers → your server → Configuration** edits the server config, and it
is the only place you should edit it: the panel rewrites `serverDZ.cfg` on every
install and every DayZ update, so a change made on disk would be gone by the
next update. The values live in the panel’s database instead, and the file is
generated from them.

The page has three parts:

- **Basics** — name, player count and mission. These have their own fields
  because the panel needs them elsewhere too (the server list, the registration
  on DZPage). Renaming a registered server updates its name on DZPage as well.
- **serverDZ.cfg** — every other value as a list of key and value. Change one,
  tick “remove” to drop one, or type a new key and value in the last row to add
  a setting the panel does not know. Anything DayZ accepts works here;
  `verifySignatures`, `disable3rdPerson`, `serverTimeAcceleration` and friends
  are pre-filled with the values a fresh server ships with.
- **Preview** — the exact file the panel will write.

Values are written the way you would expect: numbers bare, everything else in
quotes. A value that already starts with `{` or `"` is taken verbatim, which is
how list settings work:

```
motd[]   = {"Welcome","Read the rules"}
respawnTime = 5
serverTime  = SystemTime
```

Ports are not editable here. They are tied to the DZPage registration, to
BattlEye and to the port check against the other servers on this panel — a port
is not a setting, it is the identity of the server.

Changes are written immediately but only take effect when the server restarts;
DayZ reads the file once at start.

### Runtime: systemd or Docker

systemd is the default. Docker is a switch inside the panel, not a second
install path: the game files stay where they are and are mounted into the
container, so switching costs no re-download.

To allow it, run `sudo ./install.sh --with-docker` once. That puts the service
user into the `docker` group, which on that machine is effectively root. If you
do not need this runtime, leave the option out.

The container image is configurable with `DZPAGE_PANEL_DOCKER_IMAGE` (default
`debian:bookworm-slim`); it must provide the libraries the DayZ server expects.

---

## Updates

Two different things are called “update” here, and the panel keeps them apart.

### The panel itself

**Updates/This panel** shows the running version, the newest release and where
it comes from. The panel asks GitHub for the tags of this repository every six
hours — no account, no key, read-only — and treats the highest `vX.Y.Z` as the
newest release. Pre-releases (`v1.2.3-rc1`) are ignored.

| Setting | What happens when a new version appears |
|---|---|
| **Install it automatically** (default) | the panel installs it and restarts itself |
| **Only report it, ask me first** | it shows up here and in the event log; you press the button |
| **Do not look for updates** | nothing, ever |

Installing restarts the panel. **Your game servers keep running** — they are
separate units (or containers) and are not touched.

If the new version does not come up, the previous one is restored automatically:

- systemd install: the update runs as its own short-lived service, waits for
  `/health`, and on failure checks out the previous commit and rolls the old
  files back out. The result survives the restart in
  `/var/lib/dzpage-panel/self-update.json`, with a log next to it in
  `self-update.log`.
- Docker install: the entrypoint counts start attempts. After the third failed
  start it resets the checkout to the last commit that came up, so a bad release
  cannot leave you in a restart loop.

Your fork gets its own releases: the repository address comes from
`/etc/dzpage-panel/install.json`, which the installer writes.

If you installed by copying files by hand, the panel reports new versions but
does not touch anything. Update such an installation yourself, then run
`sudo ./install.sh` again.

### DayZ server files

**Updates/Servers** asks Steam for the state of the DayZ server and compares it
with the installed files. The two numbers being compared both come from Steam’s
own format: `buildid` from `game/steamapps/appmanifest_223350.acf` and
`depots.branches.public.buildid` from `app_info_print`.

**The query signs in anonymously.** Steam does not need an account to talk about
a public app, so the check works before you have signed in to Steam — only
downloading needs your account. It gets its own `HOME`
(`/var/lib/dzpage-panel/steam-info-home`) so the anonymous login never touches
your account’s session token.

Two things are configurable, and the split is deliberate:

| | where | values |
|---|---|---|
| Schedule | once for the panel | off, or every 30 min to 24 h |
| Behaviour | per server | off · only report · update automatically |

“Update automatically” stops the server, fetches the files and starts it again —
with no warning in game. For a server with players on it, “only report” is the
right choice; the in-game warning belongs to the restart schedule on DZPage,
because it goes through RCon.

The schedule ships **off**. A panel that starts SteamCMD unasked is not what
anyone expects on their own machine. “Check now” only ever checks — a button
with that label must not restart a server.

---

## Remote control from DZPage

Once a server is registered, it gets an **Operations** section on dzpage.com
under RCon: start, stop, restart, update files, and a restart schedule. The
in-game warning goes over RCon, the restart over the panel — that combination
needs both halves.

For this the panel holds one outgoing connection open (long poll) and picks up
jobs. **The panel itself needs no open port**, and it works behind CGNAT. (The
game servers do need theirs, see Firewall above: RCon from DZPage connects to
them.) Every job is checked before it runs: known job type, target server
belongs to this panel, a start needs installed game files, result goes back,
everything lands in the event log. Jobs for the same server run one after
another, never at the same time.

---

## Reaching the panel from outside

The panel binds to `127.0.0.1` on purpose. For outside access, put a reverse
proxy with TLS in front — putting a panel on the internet without TLS is the
standard mistake with products like this.

**The easy way** is built in. Point a DNS record (A record) at the machine, then:

```bash
sudo dzpage-panel https enable panel.example.com
```

That installs [Caddy](https://caddyserver.com) from its official package
repository if needed, writes `/etc/caddy/dzpage-panel.caddy`, opens 80 and 443
in ufw or firewalld, and tells the panel that a proxy is in front. Caddy gets the
certificate from Let’s Encrypt and renews it by itself. If something else
already listens on port 80 or 443, the script stops and changes nothing; use
your own proxy then. `sudo dzpage-panel https disable` undoes it (Caddy itself
stays installed).

**Your own proxy**, for example nginx:

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

Then set `"trustProxy": true` in `/etc/dzpage-panel/panel.json` (or
`Environment=DZPAGE_PANEL_TRUST_PROXY=1` in a drop-in for `dzpage-panel.service`)
and restart the service. Only then does the panel read `X-Forwarded-Proto` and
set the Secure flag on the session cookie; without it, the origin check rejects
every form sent over https.

---

## Configuration

`/etc/dzpage-panel/panel.json`, mode 0600, owned by the service user.

| Field | Meaning |
|---|---|
| `bind`, `port` | default `127.0.0.1:8410` |
| `trustProxy` | only turn on if a proxy really is in front |
| `cookieSecure` | `"auto"` (default), `true` or `false` |
| `database` | `{"kind":"sqlite","file":…}` or `{"kind":"mysql",…}` |
| `secrets` | session and encryption keys, generated on first start |
| `dzpage` | address, panel key, name of this panel |
| `steam.steamcmdPath` | the SteamCMD that was found or installed |

`/etc/dzpage-panel/install.json` is written by the installer and says how this
panel was installed (`git`, `docker` or `manual`), from which repository, and
with which options. It is owned by root: the panel reads it, it does not write
it.

Where things live: configuration in `/etc/dzpage-panel/`, data and game files in
`/var/lib/dzpage-panel/`, logs in journald (`journalctl -u dzpage-panel -f`).

**MySQL** needs one more package — only if you actually choose it:

```bash
sudo -u dzpage npm install --omit=dev --prefix /usr/lib/dzpage-panel mysql2
```

---

## Security

- **Never as root.** Service user `dzpage`, systemd unit with
  `ProtectSystem=strict`, an empty `CapabilityBoundingSet` and resource limits.
- **The privileged helper.** Creating services and users is not something an
  unprivileged process can do. Instead of running the panel as root, it sends
  one line to a socket (`/run/dzpage-panel-helper.sock`, openable only by the
  service user) and systemd briefly runs `helper.sh` as root. The helper knows
  exactly thirteen named operations (services, status, logs, firewall ports,
  self-update) and checks every parameter against a pattern; an operation with
  a bad parameter stops and reports an error code. sudo would have been the
  usual answer but does not work here: the panel’s unit sets `NoNewPrivileges`
  implicitly through `PrivateDevices` and `ProtectKernelTunables`, so sudo could
  not raise anything anyway.
- **A setup code instead of first come, first served.** Until an administrator
  exists, only the one-time code from the installer opens the local wizard.
- **Pairing without typing secrets.** The pairing code in the install command
  works once and expires after 30 minutes; the link code expires after 15 minutes,
  and the page on dzpage.com shows the machine’s name and address before you
  confirm. The panel never receives anything but its own revocable key.
- **No shell in the interface.** Every action is a fixed, named operation;
  processes are started with argument lists, never through a shell string.
  Anything that must pass a command line is checked against an allow list.
- **No JavaScript in the browser.** The content policy is accordingly strict
  (`default-src 'none'`), every form carries a CSRF token, plus an origin check.
- Passwords with scrypt (N=2^15, r=8, p=1, 32-byte salt), sessions as an
  HttpOnly cookie with `SameSite=Strict`, login attempts throttled.
- **Your Steam password is never stored.** It goes through a pseudo terminal
  straight to SteamCMD and is discarded; only what SteamCMD itself writes is
  kept. Password and Steam Guard code are on the job’s redaction list and appear
  in no log.
- The DZPage key exists on our side only as a SHA-256 hash and can be revoked at
  any time. The panel only ever calls DZPage — **no port forwarding**.

### SteamCMD: measured behaviour

Measured against client version 1785799152 on Ubuntu 22.04 (2026-08-06), because
three quirks would otherwise produce wrong results:

- The output is **coloured**. Every prompt is followed by a reset sequence
  (`password: \x1b[0m`); without filtering, no pattern matches.
- Startup contains harmless lines like `ILocalize::AddFile() failed to load
  file` — an error pattern that looks for `failed` case-insensitively reports a
  successful login as a failure.
- The result sits **in the middle of a line**:
  `Logging in user 'x' [U:1:0] to Steam Public...ERROR (Invalid Password)`.
  After that `Steam>` returns, so an unknown failure reason would pass as
  success if only the start of the line were checked.

The first run downloads and restarts itself; that takes a minute or two and is
not an error.

---

## Uninstall

```bash
sudo dzpage-panel uninstall
```

That stops the panel and every game server, removes the services, the server
users, the panel’s firewall rules, its Caddy site and the program. Game files,
saves, database and configuration stay in `/var/lib/dzpage-panel` and
`/etc/dzpage-panel`, so a new install picks up where you left off. To remove
those too (not reversible):

```bash
sudo dzpage-panel uninstall --purge
```

Docker install:

```bash
docker compose down -v
sudo rm -rf /etc/dzpage-panel /var/lib/dzpage-panel
```

---

## Development

```bash
npm test                     # no network, no database server, no root
DZPANEL_NET_TESTS=1 npm test # additionally the real SteamCMD installation
```

Two acceptance checks need a real system and therefore run separately:

```bash
sudo ./scripts/verify-runtime.sh   # systemd: own user, limits, crash, cleanup
sudo ./scripts/verify-docker.sh    # Docker and switching between both runtimes
```

Both assume an installed panel and use a stand-in instead of DayZ — the real
game files need a Steam account that owns DayZ.

For the MySQL part, point it at a database:

```bash
DZPANEL_MYSQL_HOST=127.0.0.1 DZPANEL_MYSQL_USER=dzpanel \
DZPANEL_MYSQL_PASSWORD=… DZPANEL_MYSQL_DATABASE=dzpanel_test npm test
```

Run without root (paths redirected):

```bash
DZPAGE_PANEL_CONFIG_DIR=/tmp/panel/etc DZPAGE_PANEL_DATA_DIR=/tmp/panel/lib \
DZPAGE_PANEL_PORT=8411 node bin/dzpage-panel.js
```

`DZPAGE_BASE_URL` redirects the DZPage address (for tests against a stand-in),
`DZPAGE_PANEL_GITHUB_API` the GitHub address (for tests of the update check).

### Releasing a version

The version lives in `src/version.js` and `package.json` — a test keeps them in
sync. It is reported to DZPage on every registration and heartbeat, and it is
what the update check compares against.

```bash
git tag v0.4.0 && git push origin v0.4.0
```

Every panel out there sees that tag within six hours. There is no build step and
no artefact: the tag *is* the release.

### Interface language

The panel speaks English (default) and German. Another language is one file in
`src/i18n/` plus one entry in `src/i18n/index.js`; a test makes sure no language
forgets a key.

The code comments are in German — this started as a German project. Pull
requests are welcome in either language.
