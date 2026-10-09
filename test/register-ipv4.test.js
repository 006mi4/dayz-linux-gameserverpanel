import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { isIP } from "node:net";
import dns from "node:dns/promises";
import { Client, launchPanel, prepareEnv, startDzpageStub, unlockSetup } from "../test-support/helper.js";

/**
 * Server-Anmeldung ueber IPv4. dzpage.com nimmt die Quelladresse als
 * RCon-Adresse, BattlEye-RCon spricht nur IPv4, und global fetch nimmt auf
 * Maschinen mit IPv6 meist IPv6. Hier: die Anmeldung geht ueber IPv4, ohne
 * IPv4 ueber IPv6 mit sichtbarer Warnung, und einmal nach dem Update werden
 * alle angemeldeten Server neu angemeldet.
 */

const env = prepareEnv("ipv4");
process.on("exit", () => env.cleanup());

const { DzpageClient, fetchIpv4 } = await import("../src/dzpage/client.js");
const { registerServerWithDzpage, reregisterServersOnce } = await import("../src/dzpage/servers.js");
const { checkServerInput, createServer: createPanelServer, getServer, updateServer } = await import(
  "../src/store/servers.js"
);
const { deleteSetting, getSetting, KEYS } = await import("../src/store/settings.js");
const { listEvents } = await import("../src/store/events.js");

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

/** Gibt es hier eine IPv6-Schleife? Ohne sie laesst sich IPv6 nicht pruefen. */
async function hasIpv6Loopback() {
  const probe = createServer();
  try {
    await listen(probe, "::1");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}
const IPV6 = await hasIpv6Loopback();

const isIpv4Source = (address) => isIP(address) === 4 || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(address);

/** Ein Name, den die echte Aufloesung auf ::1 UND 127.0.0.1 abbildet (z. B. per /etc/hosts). */
async function dualStackName() {
  for (const name of [process.env.DZPAGE_TEST_DUAL_HOST, "localhost"].filter(Boolean)) {
    const found = await dns.lookup(name, { all: true }).catch(() => []);
    const addresses = found.map((entry) => entry.address);
    if (addresses.includes("::1") && addresses.includes("127.0.0.1")) return name;
  }
  return null;
}

/**
 * Ein Name, den fetch zu ::1 aufloest. Ueber IPv4 zeigt er auf 127.0.0.1 oder
 * nirgendwohin (glibc bildet ::1 aus /etc/hosts fuer IPv4 auf 127.0.0.1 ab);
 * beides verbindet nicht, solange dort niemand lauscht.
 */
async function ipv6Name() {
  const found = await dns.lookup("ip6-localhost", { all: true }).catch(() => []);
  return found.length && found.every((entry) => entry.address === "::1") ? "ip6-localhost" : null;
}

// Der Standhalter lauscht auf beiden Familien, damit er sieht, woher eine
// Anfrage kommt. Das Panel spricht ihn ueber 127.0.0.1 an, ausser ein Test
// stellt die Adresse um.
const stub = await startDzpageStub(IPV6 ? { host: "::", urlHost: "127.0.0.1" } : {});
process.env.DZPAGE_BASE_URL = stub.url;
const panel = await launchPanel();
const client = new Client(panel.url);

test.after(async () => {
  panel.app.heartbeat.stop();
  panel.app.poller.stop();
  await panel.app.dzpageReregistering?.catch(() => undefined);
  await panel.stop();
  await stub.stop();
});

async function waitFor(check, { timeoutMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Bedingung wurde nicht erreicht.");
}

let nextPort = 2400;
async function newServer(name) {
  const base = (nextPort += 10);
  const checked = checkServerInput({
    name,
    gamePort: String(base),
    queryPort: String(base + 1),
    rconPort: String(base + 2),
    rconPassword: "rcon-ipv4-geheim",
    maxPlayers: "10",
    mission: "dayzOffline.chernarusplus",
  });
  assert.ok(checked.ok, checked.code);
  return createPanelServer(panel.app.db, checked.value, panel.app.config.secrets.encryption);
}

/** Antwort eines Echo-Servers: woher die Anfrage kam und was ankam. */
function echoServer() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          from: req.socket.remoteAddress,
          method: req.method,
          body,
          length: req.headers["content-length"] ?? null,
          headers: req.headers,
        }),
      );
    });
  });
}

/* ----------------------------------------------------------- fetchIpv4 */

test("fetchIpv4 verbindet über IPv4, auch wo die Auflösung zuerst IPv6 liefert", { skip: !IPV6 && "keine IPv6-Schleife" }, async () => {
  const echo = echoServer();
  const port = await listen(echo, "::");
  try {
    // Wie ein Name mit A- und AAAA-Eintrag: ohne Vorgabe zuerst ::1.
    const asked = [];
    const lookup = (hostname, options, callback) => {
      asked.push(options.family);
      const v4 = { address: "127.0.0.1", family: 4 };
      const v6 = { address: "::1", family: 6 };
      const list = options.family === 4 ? [v4] : options.family === 6 ? [v6] : [v6, v4];
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    };

    // Gegenprobe: Dieselbe Aufloesung ohne Vorgabe landet bei IPv6.
    const plain = await new Promise((resolve, reject) => {
      const req = request(`http://dzpage.test:${port}/`, { lookup, agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(JSON.parse(text)));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(plain.from, "::1");

    asked.length = 0;
    const body = JSON.stringify({ name: "Grüße" });
    const response = await fetchIpv4(`http://dzpage.test:${port}/api/panel/v1/servers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dzp_panel_x" },
      body,
      lookup,
    });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    const seen = await response.json();
    assert.ok(isIpv4Source(seen.from), seen.from);
    assert.deepEqual(asked, [4]);
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, body);
    assert.equal(Number(seen.length), Buffer.byteLength(body));
    assert.equal(seen.headers.authorization, "Bearer dzp_panel_x");
  } finally {
    echo.close();
  }
});

test("fetchIpv4 sagt bei Fehlern, ob die Verbindung schon stand", async () => {
  // Abgewiesen: DZPage hat nichts gesehen.
  const closed = createServer();
  const freePort = await listen(closed, "127.0.0.1");
  await new Promise((resolve) => closed.close(resolve));
  const refused = await fetchIpv4(`http://127.0.0.1:${freePort}/`).catch((err) => err);
  assert.equal(refused.code, "ECONNREFUSED");
  assert.equal(refused.connected, false);

  // Angekommen, dann abgebrochen: koennte verarbeitet worden sein.
  const dropping = createServer((req) => req.socket.destroy());
  const dropPort = await listen(dropping, "127.0.0.1");
  const silent = createServer(() => undefined);
  const silentPort = await listen(silent, "127.0.0.1");
  try {
    const dropped = await fetchIpv4(`http://127.0.0.1:${dropPort}/`, { method: "POST", body: "{}" }).catch((err) => err);
    assert.ok(dropped instanceof Error);
    assert.equal(dropped.connected, true);

    // Zeitlimit wie bei fetch: TimeoutError.
    const late = await fetchIpv4(`http://127.0.0.1:${silentPort}/`, { signal: AbortSignal.timeout(150) }).catch(
      (err) => err,
    );
    assert.equal(late.name, "TimeoutError");
    assert.equal(late.connected, true);
  } finally {
    dropping.close();
    silent.closeAllConnections();
    silent.close();
  }
});

/* --------------------------------------------- DzpageClient.registerServer */

const answer = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const unreachable = () => {
  throw new Error("dieser Weg darf nicht benutzt werden");
};

test("Nur die Server-Anmeldung geht über IPv4, mit denselben Kopfzeilen wie sonst", async () => {
  const seen = [];
  const dzpage = new DzpageClient({
    baseUrl: "https://dzpage.example/",
    key: "dzp_panel_testkey0123456789abcdef",
    fetchImpl: async (url, init) => {
      seen.push({ via: "fetch", url, init });
      return answer(200, { ok: true, heartbeatSeconds: 60 });
    },
    ipv4FetchImpl: async (url, init) => {
      seen.push({ via: "ipv4", url, init });
      return answer(200, { ok: true, serverId: "rcon1", host: "203.0.113.7", rcon: true });
    },
  });

  const registered = await dzpage.registerServer({ panelId: "p1", serverId: "abcdefabcdef" });
  assert.equal(registered.ok, true);
  assert.equal(registered.via, "ipv4");
  assert.equal(registered.host, "203.0.113.7");
  await dzpage.heartbeat({ panelId: "p1" });

  assert.deepEqual(
    seen.map((entry) => [entry.via, entry.url]),
    [
      ["ipv4", "https://dzpage.example/api/panel/v1/servers"],
      ["fetch", "https://dzpage.example/api/panel/v1/heartbeat"],
    ],
  );
  const [ipv4, plain] = seen.map((entry) => entry.init);
  assert.equal(ipv4.method, "POST");
  assert.deepEqual(JSON.parse(ipv4.body), { panelId: "p1", serverId: "abcdefabcdef" });
  assert.ok(ipv4.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(ipv4.headers).sort(), Object.keys(plain.headers).sort());
  assert.equal(ipv4.headers.authorization, "Bearer dzp_panel_testkey0123456789abcdef");
});

test("Rückfall auf den normalen Weg nur, wenn IPv4 gar nicht verbindet", async () => {
  const key = "dzp_panel_testkey0123456789abcdef";
  let fallbacks = 0;
  const viaIpv6 = async () => {
    fallbacks += 1;
    return answer(200, { ok: true, serverId: "rcon1", host: "2001:db8::7", rcon: false, warning: "ipv6_source" });
  };
  const failing = (connected) => async () => {
    throw Object.assign(new Error("connect ENETUNREACH 104.21.0.1:443"), { code: "ENETUNREACH", connected });
  };

  // Keine IPv4-Verbindung: wie bisher, mit der Warnung von DZPage.
  const noIpv4 = new DzpageClient({ baseUrl: "https://dzpage.example", key, fetchImpl: viaIpv6, ipv4FetchImpl: failing(false) });
  const fell = await noIpv4.registerServer({ panelId: "p1" });
  assert.equal(fell.ok, true);
  assert.equal(fell.via, "fallback");
  assert.equal(fell.warning, "ipv6_source");
  assert.match(fell.ipv4Error, /ENETUNREACH/);
  assert.equal(fallbacks, 1);

  // Verbindung stand schon: kein zweiter Versuch, der die Adresse ueberschreiben koennte.
  const cut = new DzpageClient({ baseUrl: "https://dzpage.example", key, fetchImpl: unreachable, ipv4FetchImpl: failing(true) });
  const cutResult = await cut.registerServer({ panelId: "p1" });
  assert.equal(cutResult.ok, false);
  assert.equal(cutResult.code, "network");
  assert.equal(cutResult.via, "ipv4");

  // DZPage hat ueber IPv4 geantwortet: dessen Antwort gilt, auch eine Ablehnung.
  for (const [status, payload, code] of [
    [400, { ok: false, error: "host_mismatch" }, "host_mismatch"],
    [503, { ok: false, error: "unavailable" }, "server"],
    [403, { ok: false, error: "revoked" }, "revoked"],
  ]) {
    const refused = new DzpageClient({
      baseUrl: "https://dzpage.example",
      key,
      fetchImpl: unreachable,
      ipv4FetchImpl: async () => answer(status, payload),
    });
    const result = await refused.registerServer({ panelId: "p1" });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
});

/* ------------------------------------------------ Durch das echte Panel */

test("Einrichten und mit DZPage verbinden", async () => {
  await unlockSetup(client, env);
  await client.get("/setup/database");
  await client.submit("/setup/database", { kind: "sqlite", action: "save" });
  await client.get("/setup/admin");
  await client.submit("/setup/admin", { username: "admin", password: "panel-passwort-1", password2: "panel-passwort-1" });
  await client.get("/steam");
  await client.submit("/steam", { action: "skip" });
  await client.get("/dzpage");
  await client.submit("/dzpage", { key: stub.key, name: "Testpanel" });
  await client.get("/setup/done");
  await client.submit("/setup/done", {});
  assert.equal(stub.calls.register.length, 1);
  // Takt selbst bestimmen: Herzschlag und Abholer nur, wenn ein Test sie braucht.
  panel.app.heartbeat.stop();
  panel.app.poller.stop();
});

test("Die Anmeldung kommt bei DZPage über IPv4 an, RCon ist an", async () => {
  const server = await newServer("Vierer");
  const result = await registerServerWithDzpage(panel.app, server);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.rcon, true);
  assert.equal(result.host, "203.0.113.7");
  assert.ok(isIpv4Source(stub.calls.serverSources.at(-1)), stub.calls.serverSources.at(-1));
  assert.equal((await getServer(panel.app.db, server.id)).dzpage_server_id, "rcon123456");
  const [event] = await listEvents(panel.app.db, 1);
  assert.equal(event.kind, "server.register");
  assert.match(event.message, /Vierer bei DZPage angemeldet \(203\.0\.113\.7\)/);
});

const dual = IPV6 ? await dualStackName() : null;
test(
  "Gleicher Name mit IPv4 und IPv6: Herzschlag nimmt IPv6, die Anmeldung IPv4",
  { skip: !dual && "kein Name mit A- und AAAA-Eintrag (DZPAGE_TEST_DUAL_HOST)" },
  async () => {
    const saved = panel.app.config.dzpage.baseUrl;
    panel.app.config.dzpage.baseUrl = `http://${dual}:${stub.port}`;
    try {
      const dzpage = new DzpageClient({ baseUrl: panel.app.config.dzpage.baseUrl, key: stub.key });
      const beat = await dzpage.heartbeat({ panelId: "panel123456" });
      assert.equal(beat.ok, true);
      assert.equal(stub.calls.heartbeatSources.at(-1), "::1");

      const result = await registerServerWithDzpage(panel.app, await newServer("Doppelname"));
      assert.equal(result.ok, true, result.message);
      assert.equal(stub.calls.serverSources.at(-1), "::ffff:127.0.0.1");
      assert.equal(result.rcon, true);
    } finally {
      panel.app.config.dzpage.baseUrl = saved;
    }
  },
);

const v6name = IPV6 ? await ipv6Name() : null;
test(
  "Ohne IPv4: Anmeldung über IPv6, Warnung im Ereignisprotokoll und auf der Startseite",
  { skip: !v6name && "kein Name fuer ::1 (ip6-localhost)" },
  async () => {
    // DZPage nur ueber IPv6 erreichbar: Auf 127.0.0.1 lauscht an diesem Port niemand.
    const only6 = await startDzpageStub({ host: "::1", ipv6Only: true });
    const saved = panel.app.config.dzpage.baseUrl;
    panel.app.config.dzpage.baseUrl = `http://${v6name}:${only6.port}`;
    try {
      const server = await newServer("Nur Sechs");
      const result = await registerServerWithDzpage(panel.app, server);
      assert.equal(result.ok, true, result.message);
      assert.equal(result.rcon, false);
      assert.equal(result.warning, "ipv6_source");
      assert.deepEqual(only6.calls.serverSources, ["::1"]);
      // Angemeldet ist er trotzdem: Starten und Stoppen von dzpage.com aus gehen.
      assert.equal((await getServer(panel.app.db, server.id)).dzpage_server_id, "rcon123456");

      const [event] = await listEvents(panel.app.db, 1);
      assert.equal(event.kind, "server.register.ipv6");
      assert.match(event.message, /Nur Sechs bei DZPage angemeldet, aber nur mit der IPv6-Adresse ::1\./);
      assert.match(event.message, /RCon von dzpage\.com aus braucht IPv4/);
      assert.match(event.message, /Über IPv4 kam keine Verbindung zustande/);
      assert.doesNotMatch(event.message, /[–—]/);

      await client.get("/");
      assert.match(
        client.lastBody,
        /<span class="dot warn"><\/span><span class="txt">Nur Sechs bei DZPage angemeldet, aber nur mit der IPv6-Adresse ::1/,
      );
    } finally {
      panel.app.config.dzpage.baseUrl = saved;
      await only6.stop();
    }
  },
);

test("Bricht die Verbindung nach dem Absenden ab, gibt es keinen zweiten Versuch", async () => {
  const server = await newServer("Abbruch");
  const before = stub.calls.servers.length;
  stub.state.dropServers = 1;
  const dropped = await registerServerWithDzpage(panel.app, server);
  assert.equal(dropped.ok, false);
  assert.equal(dropped.code, "network");
  assert.equal(stub.calls.servers.length, before + 1);
  assert.equal((await getServer(panel.app.db, server.id)).dzpage_server_id, null);

  // DZPage antwortet mit einem Fehler: ebenfalls kein zweiter Weg.
  stub.state.failServers = 1;
  const failed = await registerServerWithDzpage(panel.app, server);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "server");
  assert.equal(stub.calls.servers.length, before + 1);
  assert.equal(stub.state.failServers, 0);
});

/* ------------------------------------------- Einmal nach dem Update */

test("Nach dem Update: angemeldete Server einmal neu anmelden, Störungen später wiederholen", async () => {
  // Wie von 0.5.3 angemeldet (womoeglich ueber IPv6), und einer nie angemeldet.
  const old = await newServer("Altanmeldung");
  await updateServer(panel.app.db, old.id, { dzpage_server_id: "rcon-alt" });
  const never = await newServer("Nie angemeldet");
  await deleteSetting(panel.app.db, KEYS.dzpageServersIpv4At);

  const before = stub.calls.servers.length;
  stub.state.failServers = 1;
  const first = await reregisterServersOnce(panel.app);
  assert.equal(first.done, false);
  assert.equal(await getSetting(panel.app.db, KEYS.dzpageServersIpv4At), null);

  const second = await reregisterServersOnce(panel.app);
  assert.equal(second.done, true);
  assert.equal(second.registered, 1);
  const sent = stub.calls.servers.slice(before);
  assert.deepEqual(
    sent.map((call) => call.serverId),
    [old.id],
    "nur der alte Server, nicht die in diesem Lauf schon angemeldeten und nicht der nie angemeldete",
  );
  assert.ok(isIpv4Source(stub.calls.serverSources.at(-1)));
  assert.equal(sent[0].rconPassword, "rcon-ipv4-geheim");
  assert.equal((await getServer(panel.app.db, old.id)).dzpage_server_id, "rcon123456");
  assert.equal((await getServer(panel.app.db, never.id)).dzpage_server_id, null);
  assert.ok(Number(await getSetting(panel.app.db, KEYS.dzpageServersIpv4At)) > 0);

  // Danach nie wieder.
  const third = await reregisterServersOnce(panel.app);
  assert.deepEqual(third, { done: true, registered: 0 });
  assert.equal(stub.calls.servers.length, before + 1);
});

test("Der Herzschlag stößt die einmalige Neuanmeldung an", async () => {
  const old = await newServer("Herzschlag alt");
  await updateServer(panel.app.db, old.id, { dzpage_server_id: "rcon-alt" });
  await deleteSetting(panel.app.db, KEYS.dzpageServersIpv4At);
  const before = stub.calls.servers.length;

  panel.app.heartbeat.restart({ immediate: true });
  try {
    await waitFor(() => getSetting(panel.app.db, KEYS.dzpageServersIpv4At));
  } finally {
    panel.app.heartbeat.stop();
  }
  assert.deepEqual(
    stub.calls.servers.slice(before).map((call) => call.serverId),
    [old.id],
  );
});
