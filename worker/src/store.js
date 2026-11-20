// Durable Objects. One AppStore per app (named by slug) holds its settings, answers, history and
// live sockets; a single Registry lists the apps. Files live in R2, not here: a SQLite row in a
// Durable Object is capped at 2 MB, too small for screenshots.
import { DurableObject } from "cloudflare:workers";

export const LIMITS = {
  keyPattern: /^[A-Za-z0-9_.:\/-]{1,200}$/,
  maxValueBytes: 64 * 1024,
  maxKeys: 5000,
  maxAuthor: 80,
  // Private apps: one set of answers per visitor, so the caps are per visitor plus a ceiling overall.
  maxKeysPerVisitor: 500,
  maxPrivateRows: 20000,
};
const VISITOR_RE = /^[0-9a-f-]{36}$/;
const VISIT_GAP_MS = 30 * 60e3; // loads closer together than this are one visit
const LOCKOUT = { perIp: 10, ipWindowMs: 15 * 60e3, perApp: 200, appWindowMs: 60 * 60e3 };

export class AppStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.#schema();
  }

  // Also re-run after deleteAll(): the instance outlives the wipe, and without its tables every
  // later request to the deleted app's URL would throw instead of showing "Nothing here".
  #schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, author TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, value TEXT, author TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS login_failures (ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS used_nonces (nonce TEXT PRIMARY KEY, exp INTEGER);
      CREATE TABLE IF NOT EXISTS pstate (visitor TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, author TEXT,
                                         at TEXT NOT NULL, PRIMARY KEY (visitor, key));
      CREATE TABLE IF NOT EXISTS visits (visitor TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
                                         visits INTEGER NOT NULL, name TEXT, device TEXT);
      CREATE TABLE IF NOT EXISTS aliases (visitor TEXT PRIMARY KEY, target TEXT NOT NULL, at TEXT NOT NULL);
    `);
    // history.visitor arrived with private apps; older apps' tables need the column added.
    if (!this.sql.exec("PRAGMA table_info(history)").toArray().some((c) => c.name === "visitor")) {
      this.sql.exec("ALTER TABLE history ADD COLUMN visitor TEXT");
    }
  }

  #meta() {
    return Object.fromEntries(this.sql.exec("SELECT k, v FROM meta").toArray().map((r) => [r.k, r.v]));
  }

  // A merged visitor's old id (still in a browser cookie somewhere) resolves to the id it was merged into.
  #canon(visitor) {
    if (!visitor) return visitor;
    const row = this.sql.exec("SELECT target FROM aliases WHERE visitor = ?", visitor).toArray()[0];
    return row ? row.target : visitor;
  }

  #isClosed(meta) {
    return meta.closed === "1" || (meta.expires_at && Date.parse(meta.expires_at) < Date.now());
  }

  // visitor: send only to that visitor's own sockets (private apps). Otherwise to everyone.
  #broadcast(msg, visitor) {
    const text = JSON.stringify(msg);
    for (const ws of visitor ? this.ctx.getWebSockets(visitor) : this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  // What the Worker needs to gate a request. Includes the password hash, so never return it to a client.
  gate() {
    const m = this.#meta();
    return { exists: Boolean(m.pw_hash), pw_hash: m.pw_hash, title: m.title, closed: this.#isClosed(m), open: m.open === "1", private: m.private === "1" };
  }

  info() {
    const { pw_hash, ...m } = this.#meta();
    const priv = m.private === "1";
    const stats = this.sql.exec(`SELECT count(*) AS answers, max(at) AS last_at FROM ${priv ? "pstate" : "state"}`).one();
    const visitors = this.sql.exec("SELECT count(DISTINCT visitor) AS n FROM pstate").one().n;
    const visited = this.sql.exec("SELECT count(*) AS n FROM visits").one().n;
    return {
      title: m.title,
      created_at: m.created_at,
      expires_at: m.expires_at || null,
      closed: Boolean(this.#isClosed(m)),
      closed_manually: m.closed === "1",
      open: m.open === "1",
      private: priv,
      visitors,
      visited,
      answers: stats.answers,
      last_at: stats.last_at,
    };
  }

  configure(patch) {
    const allowed = ["title", "pw_hash", "expires_at", "closed", "open", "private", "created_at"];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k) || v === undefined) continue;
      if (v === null) this.sql.exec("DELETE FROM meta WHERE k = ?", k);
      else this.sql.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", k, String(v));
    }
    if (!this.#meta().created_at) this.sql.exec("INSERT INTO meta VALUES ('created_at', ?)", new Date().toISOString());
    this.#broadcast({ type: "info" });
    return this.info();
  }

  // visitor: that visitor's own answers (private apps); otherwise the shared answers.
  getState(visitor) {
    visitor = this.#canon(visitor);
    const rows = visitor
      ? this.sql.exec("SELECT key, value, author, at FROM pstate WHERE visitor = ? ORDER BY key", visitor).toArray()
      : this.sql.exec("SELECT key, value, author, at FROM state ORDER BY key").toArray();
    return rows.map((r) => ({ ...r, value: JSON.parse(r.value) }));
  }

  // force: admin writes go through even when the app is closed. visitor: write to that visitor's
  // private answers, seen and pushed live only to them.
  setState(key, value, author, force = false, visitor = null) {
    if (!force && this.#isClosed(this.#meta())) return { error: "closed" };
    if (!LIMITS.keyPattern.test(key)) return { error: "bad key" };
    if (visitor !== null && !VISITOR_RE.test(visitor)) return { error: "bad visitor" };
    visitor = this.#canon(visitor);
    const v = JSON.stringify(value === undefined ? null : value);
    if (v.length > LIMITS.maxValueBytes) return { error: "value too large" };
    if (visitor) {
      const exists = this.sql.exec("SELECT 1 FROM pstate WHERE visitor = ? AND key = ?", visitor, key).toArray().length > 0;
      if (!exists) {
        if (this.sql.exec("SELECT count(*) AS n FROM pstate WHERE visitor = ?", visitor).one().n >= LIMITS.maxKeysPerVisitor) return { error: "too many keys" };
        if (this.sql.exec("SELECT count(*) AS n FROM pstate").one().n >= LIMITS.maxPrivateRows) return { error: "too many keys" };
      }
    } else {
      const exists = this.sql.exec("SELECT 1 FROM state WHERE key = ?", key).toArray().length > 0;
      if (!exists && this.sql.exec("SELECT count(*) AS n FROM state").one().n >= LIMITS.maxKeys) return { error: "too many keys" };
    }
    const at = new Date().toISOString();
    const who = String(author || "anonymous").slice(0, LIMITS.maxAuthor);
    if (visitor) this.sql.exec("INSERT OR REPLACE INTO pstate VALUES (?, ?, ?, ?, ?)", visitor, key, v, who, at);
    if (visitor && !force) this.sql.exec("UPDATE visits SET name = ? WHERE visitor = ?", who, visitor);
    else this.sql.exec("INSERT OR REPLACE INTO state VALUES (?, ?, ?, ?)", key, v, who, at);
    this.sql.exec("INSERT INTO history (key, value, author, at, visitor) VALUES (?, ?, ?, ?, ?)", key, v, who, at, visitor);
    const row = { key, value: JSON.parse(v), author: who, at };
    this.#broadcast({ type: "set", row }, visitor);
    return { row };
  }

  // Clears answers and history, shared and private (e.g. after testing, before sharing). Settings and files stay.
  clearState() {
    this.sql.exec("DELETE FROM state; DELETE FROM pstate; DELETE FROM history; DELETE FROM visits; DELETE FROM aliases;");
    this.#broadcast({ type: "reset" });
    return { ok: true };
  }

  exportAll() {
    const parse = (r) => ({ ...r, value: JSON.parse(r.value) });
    const history = this.sql.exec("SELECT id, key, value, author, at, visitor FROM history ORDER BY id").toArray().map(parse);
    const private_state = this.sql.exec("SELECT visitor, key, value, author, at FROM pstate ORDER BY visitor, key").toArray().map(parse);
    const visits = this.sql.exec("SELECT visitor, first_at, last_at, visits, name, device FROM visits ORDER BY first_at").toArray();
    const merged = this.sql.exec("SELECT visitor, target, at FROM aliases ORDER BY at").toArray();
    return { info: this.info(), state: this.getState(), private_state, visits, history, merged };
  }

  // Private apps: one person who used two browsers (phone and laptop) shows up as two visitors.
  // Folds `from` into `into`: answers (the newer one wins where both answered), history and visits.
  // `from`'s browser keeps its cookie, so its id becomes an alias and that browser sees the merged answers.
  mergeVisitors(from, into) {
    if (!VISITOR_RE.test(from) || !VISITOR_RE.test(into)) return { error: "bad visitor" };
    into = this.#canon(into);
    if (from === into || this.#canon(from) === into) return { error: "those are already the same visitor" };
    const known = (v) => this.sql.exec("SELECT 1 FROM visits WHERE visitor = ? UNION SELECT 1 FROM pstate WHERE visitor = ?", v, v).toArray().length > 0;
    if (!known(from) || !known(into)) return { error: "no such visitor" };
    this.sql.exec(
      `INSERT INTO pstate (visitor, key, value, author, at) SELECT ?, key, value, author, at FROM pstate WHERE visitor = ? AND true
       ON CONFLICT (visitor, key) DO UPDATE SET value = excluded.value, author = excluded.author, at = excluded.at WHERE excluded.at > pstate.at`,
      into, from);
    this.sql.exec("DELETE FROM pstate WHERE visitor = ?", from);
    this.sql.exec("UPDATE history SET visitor = ? WHERE visitor = ?", into, from);
    const a = this.sql.exec("SELECT * FROM visits WHERE visitor = ?", from).toArray()[0];
    const b = this.sql.exec("SELECT * FROM visits WHERE visitor = ?", into).toArray()[0];
    if (a && b) {
      this.sql.exec("UPDATE visits SET first_at = ?, last_at = ?, visits = ?, name = coalesce(name, ?), device = coalesce(device, ?) WHERE visitor = ?",
        a.first_at < b.first_at ? a.first_at : b.first_at, a.last_at > b.last_at ? a.last_at : b.last_at, a.visits + b.visits, a.name, a.device, into);
    } else if (a) {
      this.sql.exec("INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?)", into, a.first_at, a.last_at, a.visits, a.name, a.device);
    }
    this.sql.exec("DELETE FROM visits WHERE visitor = ?", from);
    this.sql.exec("UPDATE aliases SET target = ? WHERE target = ?", into, from);
    this.sql.exec("INSERT OR REPLACE INTO aliases VALUES (?, ?, ?)", from, into, new Date().toISOString());
    // Open tabs: both reload their answers; `from`'s sockets close so they reconnect under the merged id.
    this.#broadcast({ type: "reset" }, into);
    this.#broadcast({ type: "reset" }, from);
    for (const ws of this.ctx.getWebSockets(from)) {
      try {
        ws.close(1012, "visitor merged");
      } catch {}
    }
    return { ok: true, into, answers: this.sql.exec("SELECT count(*) AS n FROM pstate WHERE visitor = ?", into).one().n };
  }

  // Private apps: a visitor's browser loaded their answers (so a person with the page open, not a
  // link preview). Loads within VISIT_GAP_MS of the last one belong to the same visit.
  recordVisit(visitor, name, device) {
    if (!VISITOR_RE.test(visitor)) return;
    visitor = this.#canon(visitor);
    const now = new Date();
    const row = this.sql.exec("SELECT last_at FROM visits WHERE visitor = ?", visitor).toArray()[0];
    const nm = name ? String(name).slice(0, LIMITS.maxAuthor) : null;
    const dev = device ? String(device).slice(0, 60) : null;
    if (!row) {
      if (this.sql.exec("SELECT count(*) AS n FROM visits").one().n >= LIMITS.maxPrivateRows) return;
      this.sql.exec("INSERT INTO visits VALUES (?, ?, ?, 1, ?, ?)", visitor, now.toISOString(), now.toISOString(), nm, dev);
    } else {
      const bump = now - Date.parse(row.last_at) > VISIT_GAP_MS ? 1 : 0;
      this.sql.exec("UPDATE visits SET last_at = ?, visits = visits + ?, name = coalesce(?, name), device = coalesce(?, device) WHERE visitor = ?",
        now.toISOString(), bump, nm, dev, visitor);
    }
  }

  // Login throttling: per IP, plus a ceiling per app against guessing spread over many IPs.
  loginBlocked(ip) {
    const now = Date.now();
    this.sql.exec("DELETE FROM login_failures WHERE at < ?", now - LOCKOUT.appWindowMs);
    const ipCount = this.sql.exec("SELECT count(*) AS n FROM login_failures WHERE ip = ? AND at > ?", ip, now - LOCKOUT.ipWindowMs).one().n;
    const appCount = this.sql.exec("SELECT count(*) AS n FROM login_failures").one().n;
    return ipCount >= LOCKOUT.perIp || appCount >= LOCKOUT.perApp;
  }

  recordLoginFailure(ip) {
    this.sql.exec("INSERT INTO login_failures VALUES (?, ?)", ip, Date.now());
  }

  // One-time entry links: true the first time a nonce is seen, false after.
  useNonce(nonce, exp) {
    this.sql.exec("DELETE FROM used_nonces WHERE exp < ?", Date.now());
    if (this.sql.exec("SELECT 1 FROM used_nonces WHERE nonce = ?", nonce).toArray().length) return false;
    this.sql.exec("INSERT INTO used_nonces VALUES (?, ?)", nonce, exp);
    return true;
  }

  async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1001, "app deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.#schema();
  }

  // Live updates. The Worker checks the session cookie before forwarding the upgrade here, and for
  // private apps sets X-DWA-Visitor (overwriting anything the browser sent): the socket is tagged
  // with it so that visitor's changes reach only their own tabs.
  // Hibernatable sockets: an idle app with open tabs costs nothing.
  async fetch(req) {
    const visitor = this.#canon(req.headers.get("X-DWA-Visitor"));
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, visitor && VISITOR_RE.test(visitor) ? [visitor] : []);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (msg === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code, "closing");
    } catch {}
  }
}

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS apps (slug TEXT PRIMARY KEY, created_at TEXT)");
  }

  add(slug) {
    this.sql.exec("INSERT OR IGNORE INTO apps VALUES (?, ?)", slug, new Date().toISOString());
  }

  remove(slug) {
    this.sql.exec("DELETE FROM apps WHERE slug = ?", slug);
  }

  list() {
    return this.sql.exec("SELECT slug FROM apps ORDER BY created_at DESC").toArray().map((r) => r.slug);
  }
}
