// dwa — disposable web apps. One Worker hosts every app at /<slug>/.
//   Files (HTML, CSS, images, data) live in R2 under <slug>/; settings, answers, history and live
//   sockets live in that app's Durable Object; the Registry lists the apps.
//   Visitors: shared password per app -> signed cookie scoped to /<slug>/, unless the app is open
//   (no sign-in at all: anyone with the URL can read and write).
//   Private apps: each browser gets a signed visitor cookie and its own set of answers; nobody sees
//   anyone else's. Tom reads them all through the admin API.
//   Admin (the dwa CLI): Authorization: Bearer $ADMIN_TOKEN on /_admin/*.
import { checkPassword, fingerprint, hashPassword, makeToken, readToken, safeEqual } from "./auth.js";
import { enterPage, linkExpiredPage, lockedPage, loginPage, notFoundPage, SEC_HEADERS } from "./pages.js";
import { LIMITS } from "./store.js";
import CLIENT_JS from "./dwa.client.js";

export { AppStore, Registry } from "./store.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Visitors can't upload, but app files must not shadow the Worker's own routes (_login, _api …).
const FILE_RE = /^(?!_)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,300}$/;
const SESSION_DAYS = 30;
const VISITOR_DAYS = 400; // browsers cap cookie lifetimes at about this

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json", ...SEC_HEADERS } });
const err = (msg, status) => json({ error: msg }, status);
const getCookie = (req, name) =>
  (req.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
const appStub = (env, slug) => env.APP.get(env.APP.idFromName(slug));
const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

async function sessionCookie(env, slug, pwHash) {
  const token = await makeToken(env.SESSION_SECRET, { k: "session", s: slug, f: fingerprint(pwHash), e: Date.now() + SESSION_DAYS * 864e5 });
  return `dwa=${token}; Path=/${slug}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function visitorCookie(slug, token) {
  return `dwa_v=${token}; Path=/${slug}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${VISITOR_DAYS * 86400}`;
}
const visitorToken = (env, slug, v) => makeToken(env.SESSION_SECRET, { k: "visitor", s: slug, v, e: Date.now() + VISITOR_DAYS * 864e5 });

async function readVisitor(env, req, slug) {
  const p = await readToken(env.SESSION_SECRET, getCookie(req, "dwa_v"), "visitor");
  return p && p.s === slug ? p.v : null;
}

// A rough, human label for a visitor's browser ("Safari on iPhone"), for Tom's view of who visited.
function deviceLabel(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome"
    : /Version\/.*Safari/.test(ua) ? "Safari" : /Claude\//.test(ua) ? "Claude app" : "";
  return [browser || "a browser", os && `on ${os}`].filter(Boolean).join(" ");
}

function withCookie(res, cookie) {
  const r = new Response(res.body, res);
  r.headers.append("Set-Cookie", cookie);
  return r;
}

async function validSession(env, req, slug, pwHash) {
  const p = await readToken(env.SESSION_SECRET, getCookie(req, "dwa"), "session");
  return Boolean(p && p.s === slug && p.f === fingerprint(pwHash));
}

export default {
  async fetch(req, env) {
    // Refuse everything until both secrets exist: an unset ADMIN_TOKEN would otherwise accept the
    // literal header "Bearer undefined".
    if (!env.ADMIN_TOKEN || !env.SESSION_SECRET) return new Response("Not configured", { status: 503 });
    const url = new URL(req.url);
    // Split before decoding, so an encoded "/" inside a key can't invent extra path segments.
    const parts = url.pathname.split("/").filter(Boolean).map(decode);
    if (parts.includes(null)) return notFoundPage();

    if (parts[0] === "_admin") {
      if (!safeEqual(req.headers.get("Authorization") || "", `Bearer ${env.ADMIN_TOKEN}`)) return err("unauthorised", 401);
      return admin(req, env, url, parts.slice(1));
    }

    const slug = parts[0];
    if (!slug || !SLUG_RE.test(slug)) return notFoundPage();
    if (url.pathname === `/${slug}`) return Response.redirect(`${url.origin}/${slug}/${url.search}`, 302);
    const app = appStub(env, slug);
    const gate = await app.gate();
    if (!gate.exists) return notFoundPage();
    const sub = parts.slice(1).join("/") + (url.pathname.endsWith("/") && parts.length > 1 ? "/" : "");

    // An open app has no sign-in: its login and link routes just lead to the page.
    if (gate.open && sub === "_login") return Response.redirect(`${url.origin}/${slug}/`, 303);

    if (sub === "_login" && req.method === "POST") {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      if (await app.loginBlocked(ip)) return lockedPage(gate.title);
      const form = await req.formData();
      if (!(await checkPassword(String(form.get("password") || ""), gate.pw_hash))) {
        await app.recordLoginFailure(ip);
        await new Promise((r) => setTimeout(r, 750));
        return loginPage(slug, gate.title, "That password isn't right.");
      }
      return new Response(null, { status: 303, headers: { Location: `/${slug}/`, "Set-Cookie": await sessionCookie(env, slug, gate.pw_hash) } });
    }

    // One-time entry link minted by `dwa link`: signs the visitor in without the password.
    // Opening it (GET) only shows a Continue button; pressing that (POST) is what uses the link.
    // Message apps and mail scanners fetch URLs to build previews, and must not use it up.
    if (sub === "_enter") {
      const posted = req.method === "POST";
      const t = posted ? String((await req.formData().catch(() => null))?.get("t") || "") : url.searchParams.get("t");
      const p = await readToken(env.SESSION_SECRET, t, "enter");
      if (!p || p.s !== slug || p.f !== fingerprint(gate.pw_hash)) return linkExpiredPage();
      if (!posted) return (await app.nonceUsed(p.n)) ? linkExpiredPage() : enterPage(slug, gate.title, t);
      if (!(await app.useNonce(p.n, p.e))) return linkExpiredPage();
      const headers = new Headers({ Location: `/${slug}/` });
      headers.append("Set-Cookie", await sessionCookie(env, slug, gate.pw_hash));
      if (p.a) headers.append("Set-Cookie", `dwa_name=${encodeURIComponent(p.a)}; Path=/${slug}/; Secure; SameSite=Lax; Max-Age=600`);
      // A link minted for a visitor (`dwa link --visitor`) opens their private answers, e.g. on another device.
      if (p.v) headers.append("Set-Cookie", visitorCookie(slug, await visitorToken(env, slug, p.v)));
      return new Response(null, { status: 303, headers });
    }

    if (sub === "_logout") {
      return new Response(null, { status: 303, headers: { Location: `/${slug}/`, "Set-Cookie": `dwa=; Path=/${slug}/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
    }

    if (!gate.open && !(await validSession(env, req, slug, gate.pw_hash))) {
      return sub.startsWith("_api") ? err("unauthorised", 401) : loginPage(slug, gate.title);
    }

    // Private apps: find this browser's visitor id, or give it one (the cookie is set on this response).
    let visitor = null;
    let newVisitorCookie = null;
    if (gate.private) {
      visitor = await readVisitor(env, req, slug);
      if (!visitor) {
        if (sub === "_api/live") return err("no visitor", 401);
        visitor = crypto.randomUUID();
        newVisitorCookie = visitorCookie(slug, await visitorToken(env, slug, visitor));
      }
    }
    const res = await serve(env, req, app, slug, sub, visitor);
    return newVisitorCookie ? withCookie(res, newVisitorCookie) : res;
  },
};

async function serve(env, req, app, slug, sub, visitor) {
  if (sub === "_dwa.js") {
    return new Response(CLIENT_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "private, no-cache", ...SEC_HEADERS } });
  }
  if (sub === "_api/info") {
    const info = await app.info();
    // Private apps: how many others have answered is none of a visitor's business.
    if (visitor) for (const k of ["answers", "last_at", "visitors", "visited"]) delete info[k];
    return json(info);
  }
  if (sub === "_api/state" && req.method === "GET") {
    if (visitor) {
      const name = decode(req.headers.get("X-DWA-Author") || "");
      await app.recordVisit(visitor, name, deviceLabel(req.headers.get("User-Agent") || ""));
    }
    return json(await app.getState(visitor));
  }
  if (sub.startsWith("_api/state/") && req.method === "PUT") {
    const key = sub.slice("_api/state/".length);
    const body = await req.json().catch(() => null);
    if (!body || !("value" in body)) return err("expected {value}", 400);
    const author = decodeURIComponent(req.headers.get("X-DWA-Author") || "anonymous");
    const result = await app.setState(key, body.value, author, false, visitor);
    if (result.error) return err(result.error, result.error === "closed" ? 423 : 400);
    return json(result.row);
  }
  if (sub === "_api/live") {
    if (req.headers.get("Upgrade") !== "websocket") return err("expected websocket", 426);
    // Never pass on a visitor header the browser made up: only the one from the signed cookie.
    const fwd = new Request(req);
    fwd.headers.delete("X-DWA-Visitor");
    if (visitor) fwd.headers.set("X-DWA-Visitor", visitor);
    return app.fetch(fwd);
  }
  if (sub.startsWith("_")) return notFoundPage();

  return serveFile(env, req, slug, sub);
}

async function serveFile(env, req, slug, sub) {
  const path = !sub || sub.endsWith("/") ? `${sub}index.html` : sub;
  if (!FILE_RE.test(path)) return notFoundPage();
  const obj = await env.FILES.get(`${slug}/${path}`, { onlyIf: req.headers });
  if (obj === null) return notFoundPage();
  const headers = new Headers(SEC_HEADERS);
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "private, no-cache");
  // A failed precondition (If-None-Match matched) comes back without a body.
  if (!("body" in obj) || !obj.body) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers });
}

async function admin(req, env, url, parts) {
  const [resource, slug, sub, ...rest] = parts;
  if (resource !== "apps") return err("not found", 404);
  const m = req.method;

  if (!slug) {
    if (m !== "GET") return err("method not allowed", 405);
    const slugs = await registry(env).list();
    const apps = await Promise.all(slugs.map(async (s) => ({ slug: s, url: `${url.origin}/${s}/`, ...(await appStub(env, s).info()) })));
    return json(apps);
  }
  if (!SLUG_RE.test(slug)) return err("bad slug: lowercase letters, digits and hyphens, 2–41 chars", 400);
  const app = appStub(env, slug);

  if (!sub) {
    if (m === "GET") {
      const g = await app.gate();
      return g.exists ? json({ slug, url: `${url.origin}/${slug}/`, ...(await app.info()) }) : err("no such app", 404);
    }
    if (m === "PUT") {
      // Create or update: {title, password, expires_at, closed, open}. A new app needs a password, even an
      // open one: it is what the app falls back to when it stops being open.
      const body = (await req.json().catch(() => null)) || {};
      const g = await app.gate();
      if (!g.exists && !body.password) return err("a new app needs a password", 400);
      const patch = { title: body.title ?? (g.exists ? undefined : slug), expires_at: body.expires_at };
      if (body.password) patch.pw_hash = await hashPassword(String(body.password));
      if (body.closed !== undefined) patch.closed = body.closed ? "1" : null;
      if (body.open !== undefined) patch.open = body.open ? "1" : null;
      if (body.private !== undefined) patch.private = body.private ? "1" : null;
      const info = await app.configure(patch);
      await registry(env).add(slug);
      return json({ slug, url: `${url.origin}/${slug}/`, ...info });
    }
    if (m === "DELETE") {
      let deleted = 0;
      let cursor;
      do {
        const page = await env.FILES.list({ prefix: `${slug}/`, cursor });
        if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
        deleted += page.objects.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      await app.destroy();
      await registry(env).remove(slug);
      return json({ ok: true, files_deleted: deleted });
    }
    return err("method not allowed", 405);
  }

  const g = await app.gate();
  if (!g.exists) return err("no such app", 404);

  if (sub === "files") {
    const path = rest.join("/");
    if (!path && m === "GET") {
      const files = [];
      let cursor;
      do {
        const page = await env.FILES.list({ prefix: `${slug}/`, cursor });
        for (const o of page.objects) files.push({ path: o.key.slice(slug.length + 1), size: o.size, etag: o.etag });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return json(files);
    }
    if (!FILE_RE.test(path)) return err("bad path: no leading underscore, no '..'", 400);
    if (m === "PUT") {
      const obj = await env.FILES.put(`${slug}/${path}`, req.body, {
        httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" },
      });
      return json({ ok: true, path, size: obj.size, etag: obj.etag });
    }
    if (m === "DELETE") {
      await env.FILES.delete(`${slug}/${path}`);
      return json({ ok: true });
    }
    return err("method not allowed", 405);
  }

  if (sub === "export" && m === "GET") return json(await app.exportAll());

  if (sub === "state") {
    if (!rest.length && m === "DELETE") return json(await app.clearState());
    if (rest.length && m === "PUT") {
      // Admin write (seeding, or answering as Tom). Works even when the app is closed.
      const body = (await req.json().catch(() => null)) || {};
      if (g.private && !body.visitor) return err("private app: say which visitor (visitor id)", 400);
      const result = await app.setState(rest.join("/"), body.value, body.author || "Tom", true, body.visitor || null);
      return result.error ? err(result.error, 400) : json(result.row);
    }
    return err("method not allowed", 405);
  }

  if (sub === "visitors" && rest[0] === "merge" && m === "POST") {
    // Private apps: {from, into} visitor ids. One person, two browsers, becomes one visitor.
    if (!g.private) return err("only private apps have visitors", 400);
    const body = (await req.json().catch(() => null)) || {};
    const result = await app.mergeVisitors(String(body.from || ""), String(body.into || ""));
    return result.error ? err(result.error, 400) : json(result);
  }

  if (sub === "links" && m === "POST") {
    // One-time sign-in link: {name?, minutes?}. Dies on first use, after `minutes`, or on a password change.
    const body = (await req.json().catch(() => null)) || {};
    const minutes = Math.min(Math.max(Number(body.minutes) || 30, 1), 7 * 24 * 60);
    const payload = { k: "enter", s: slug, f: fingerprint(g.pw_hash), n: crypto.randomUUID(), e: Date.now() + minutes * 60e3 };
    if (body.name) payload.a = String(body.name).slice(0, LIMITS.maxAuthor);
    if (body.visitor) {
      if (!/^[0-9a-f-]{36}$/.test(body.visitor)) return err("bad visitor id", 400);
      payload.v = body.visitor;
    }
    const t = await makeToken(env.SESSION_SECRET, payload);
    return json({ url: `${url.origin}/${slug}/_enter?t=${t}`, expires_at: new Date(payload.e).toISOString() });
  }

  return err("not found", 404);
}
