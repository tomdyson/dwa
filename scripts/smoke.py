#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""End-to-end check of every gate in the dwa Worker. Creates two throwaway apps, exercises them over
plain HTTP and a raw WebSocket, then deletes them.

  scripts/smoke.py --local            # against `dwa dev`
  scripts/smoke.py                    # against production (DWA_BASE_URL)
  scripts/smoke.py --ip 104.21.14.108 # production, pinning the IP (stale local DNS)
"""

import argparse
import base64
import http.client
import json
import os
import secrets
import socket
import ssl
import sys
import time
import urllib.parse
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def read_env(path: Path) -> dict:
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


class Site:
    def __init__(self, base: str, token: str, ip: str | None):
        u = urllib.parse.urlsplit(base)
        self.https = u.scheme == "https"
        self.host = u.hostname
        self.port = u.port or (443 if self.https else 80)
        self.netloc = u.netloc
        self.ip = ip
        self.token = token

    def _sock(self):
        s = socket.create_connection((self.ip or self.host, self.port), timeout=30)
        return ssl.create_default_context().wrap_socket(s, server_hostname=self.host) if self.https else s

    def req(self, method, path, body=None, headers=None, admin=False, form=None):
        h = {"User-Agent": "dwa-smoke/0.1", **(headers or {})}
        if admin:
            h["Authorization"] = f"Bearer {self.token}"
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        elif body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn = (http.client.HTTPSConnection if self.https else http.client.HTTPConnection)(self.host, self.port)
        conn.sock = self._sock()
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, r, data

    def ws(self, path, cookie=None, extra=None):
        sock = self._sock()
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f"GET {path} HTTP/1.1", f"Host: {self.netloc}", "Upgrade: websocket", "Connection: Upgrade",
                 f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        if cookie:
            lines.append(f"Cookie: {cookie}")
        lines += [f"{k}: {v}" for k, v in (extra or {}).items()]
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = sock.recv(1)
            if not chunk:
                break
            head += chunk
        return sock, int(head.split(b" ")[1])


def ws_read_text(sock, timeout=10) -> str:
    sock.settimeout(timeout)

    def exact(n):
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("socket closed")
            buf += chunk
        return buf

    b0, b1 = exact(2)
    n = b1 & 0x7F
    if n == 126:
        n = int.from_bytes(exact(2), "big")
    elif n == 127:
        n = int.from_bytes(exact(8), "big")
    return exact(n).decode()


failures = []


def check(label, ok, detail=""):
    print(f"  {'ok ' if ok else 'FAIL'}  {label}{'' if ok else f'  ({detail})'}")
    if not ok:
        failures.append(label)


def cookie_from(resp, name="dwa"):
    for k, v in resp.getheaders():
        if k.lower() == "set-cookie" and v.startswith(name + "="):
            return v
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--ip")
    a = ap.parse_args()
    if a.local:
        site = Site("http://127.0.0.1:8799", read_env(REPO / "worker/.dev.vars")["ADMIN_TOKEN"], None)
    else:
        env = read_env(Path.home() / ".config/dwa/.env")
        site = Site(env["DWA_BASE_URL"], env["DWA_ADMIN_TOKEN"], a.ip)

    tag = secrets.token_hex(3)
    s1, s2 = f"smoke-{tag}", f"smoke-{tag}-b"
    pw, pw2 = f"pw-{secrets.token_hex(8)}", f"pw-{secrets.token_hex(8)}"
    print(f"Smoke test against {site.netloc}{' via ' + site.ip if site.ip else ''}: apps {s1}, {s2}")
    try:
        print("admin gate")
        check("no token -> 401", site.req("GET", "/_admin/apps")[0] == 401)
        check("'Bearer undefined' -> 401", site.req("GET", "/_admin/apps", headers={"Authorization": "Bearer undefined"})[0] == 401)
        check("wrong token -> 401", site.req("GET", "/_admin/apps", headers={"Authorization": "Bearer nope"})[0] == 401)
        check("new app without password -> 400", site.req("PUT", f"/_admin/apps/{s1}", {"title": "x"}, admin=True)[0] == 400)
        check("bad slug -> 400", site.req("PUT", "/_admin/apps/Bad_Slug", {"password": "x"}, admin=True)[0] == 400)

        print("create + files")
        st, _, _ = site.req("PUT", f"/_admin/apps/{s1}", {"title": "Smoke", "password": pw}, admin=True)
        check("create app", st == 200, st)
        site.req("PUT", f"/_admin/apps/{s2}", {"title": "Smoke B", "password": pw2}, admin=True)
        html = b"<!doctype html><title>smoke</title><p>smoke page</p>"
        check("upload index.html", site.req("PUT", f"/_admin/apps/{s1}/files/index.html", html, admin=True,
                                            headers={"Content-Type": "text/html; charset=utf-8"})[0] == 200)
        check("upload to reserved _name -> 400", site.req("PUT", f"/_admin/apps/{s1}/files/_dwa.js", b"x", admin=True)[0] == 400)
        check("upload with .. -> 400", site.req("PUT", f"/_admin/apps/{s1}/files/a/..%2F..%2Fx", b"x", admin=True)[0] in (400, 404))

        print("visitor gate")
        st, _, body = site.req("GET", f"/{s1}/")
        check("page without cookie shows login form", st == 200 and b'name="password"' in body and b"smoke page" not in body)
        check("api without cookie -> 401", site.req("GET", f"/{s1}/_api/state")[0] == 401)
        st, r, _ = site.req("GET", f"/{s1}/_dwa.js")
        check("_dwa.js without cookie is not served", b"javascript" not in (r.getheader("Content-Type") or "").encode())
        check("unknown app -> 404", site.req("GET", "/no-such-app-here/")[0] == 404)
        st, _, _ = site.req("POST", f"/{s1}/_login", form={"password": "wrong"})
        check("wrong password -> 401", st == 401, st)
        st, r, _ = site.req("POST", f"/{s1}/_login", form={"password": pw})
        raw = cookie_from(r)
        check("right password -> 303 + cookie", st == 303 and raw, st)
        check("cookie is path-scoped, HttpOnly, Secure",
              f"Path=/{s1}/" in raw and "HttpOnly" in raw and "Secure" in raw, raw[:80])
        cookie = {"Cookie": raw.split(";")[0]}

        st, r, body = site.req("GET", f"/{s1}/", headers=cookie)
        check("page with cookie serves the file", st == 200 and b"smoke page" in body, st)
        check("noindex + DENY framing headers", r.getheader("X-Robots-Tag", "").startswith("noindex") and r.getheader("X-Frame-Options") == "DENY")
        # Cloudflare drops ETags from HTML on tomd.org (an HTML-rewriting zone feature), so test on CSS.
        site.req("PUT", f"/_admin/apps/{s1}/files/app.css", b"body{color:red}", admin=True, headers={"Content-Type": "text/css"})
        st, r, _ = site.req("GET", f"/{s1}/app.css", headers=cookie)
        etag = r.getheader("ETag")
        check("CSS served with an ETag", st == 200 and bool(etag), f"{st} etag={etag}")
        if etag:
            check("If-None-Match -> 304", site.req("GET", f"/{s1}/app.css", headers={**cookie, "If-None-Match": etag})[0] == 304)
        check("cookie for one app is refused by another", site.req("GET", f"/{s2}/_api/state", headers=cookie)[0] == 401)
        site.req("PUT", f"/_admin/apps/{s2}/files/secret.html", b"other app's file", admin=True)
        check("encoded ../ can't reach another app's files",
              site.req("GET", f"/{s1}/..%2F{s2}%2Fsecret.html", headers=cookie)[0] == 404)
        check("no directory listing", site.req("GET", f"/{s1}/nope/", headers=cookie)[0] == 404)

        print("answers")
        put = lambda key, body, extra=None: site.req("PUT", f"/{s1}/_api/state/{urllib.parse.quote(key, safe='')}", body,
                                                     headers={**cookie, "X-DWA-Author": "Smoke", **(extra or {})})
        st, _, body = put("A1.choice", {"value": "a"})
        check("save answer", st == 200 and json.loads(body)["author"] == "Smoke", st)
        check("bad key -> 400", put("has space", {"value": 1})[0] == 400)
        check("missing value -> 400", put("A1.x", {"nope": 1})[0] == 400)
        check("oversized value -> 400", put("A1.big", {"value": "x" * 70_000})[0] == 400)
        st, _, body = site.req("GET", f"/{s1}/_api/state", headers=cookie)
        check("read answers", st == 200 and json.loads(body)[0]["value"] == "a")

        print("live updates")
        sock, st = site.ws(f"/{s1}/_api/live")
        check("socket without cookie -> 401", st == 401, st)
        sock.close()
        sock, st = site.ws(f"/{s1}/_api/live", cookie["Cookie"])
        check("socket with cookie -> 101", st == 101, st)
        t0 = time.time()
        site.req("PUT", f"/_admin/apps/{s1}/state/A2.choice", {"value": "b", "author": "Other"}, admin=True)
        try:
            msg = json.loads(ws_read_text(sock))
            check(f"change pushed to socket ({(time.time() - t0) * 1000:.0f} ms)", msg.get("row", {}).get("key") == "A2.choice", msg)
        except Exception as e:
            check("change pushed to socket", False, e)
        sock.close()

        print("entry links")
        st, _, body = site.req("POST", f"/_admin/apps/{s1}/links", {"name": "Linked"}, admin=True)
        link = urllib.parse.urlsplit(json.loads(body)["url"])
        path = f"{link.path}?{link.query}"
        st, r, _ = site.req("GET", path)
        check("link signs in (303 + cookie)", st == 303 and cookie_from(r), st)
        check("link sets the visitor's name", "dwa_name=Linked" in cookie_from(r, "dwa_name"))
        check("link is single-use (second use -> 410)", site.req("GET", path)[0] == 410)
        tampered = path[:-3] + ("AAA" if not path.endswith("AAA") else "BBB")
        check("tampered link -> 410", site.req("GET", tampered)[0] == 410)
        st, _, body = site.req("POST", f"/_admin/apps/{s1}/links", {}, admin=True)
        stale = urllib.parse.urlsplit(json.loads(body)["url"])

        print("open access")
        site.req("PUT", f"/_admin/apps/{s1}", {"open": True}, admin=True)
        st, _, body = site.req("GET", f"/{s1}/")
        check("open app: page without cookie", st == 200 and b"smoke page" in body, st)
        st, r, _ = site.req("GET", f"/{s1}/_dwa.js")
        check("open app: _dwa.js without cookie", st == 200 and "javascript" in (r.getheader("Content-Type") or ""), st)
        check("open app: api without cookie", site.req("GET", f"/{s1}/_api/state")[0] == 200)
        check("open app: write without cookie",
              site.req("PUT", f"/{s1}/_api/state/O1.x", {"value": 1}, headers={"X-DWA-Author": "Anon"})[0] == 200)
        sock, st = site.ws(f"/{s1}/_api/live")
        check("open app: socket without cookie -> 101", st == 101, st)
        sock.close()
        check("open app: _login leads to the page", site.req("POST", f"/{s1}/_login", form={"password": "x"})[0] == 303)
        check("open app: noindex still sent", site.req("GET", f"/{s1}/")[1].getheader("X-Robots-Tag", "").startswith("noindex"))
        check("other apps still need a password", site.req("GET", f"/{s2}/_api/state")[0] == 401)
        st, _, body = site.req("GET", f"/_admin/apps/{s1}", admin=True)
        check("info reports open", json.loads(body).get("open") is True)
        site.req("PUT", f"/_admin/apps/{s1}", {"open": False}, admin=True)
        check("closed again: api without cookie -> 401", site.req("GET", f"/{s1}/_api/state")[0] == 401)
        check("closed again: old cookie still works", site.req("GET", f"/{s1}/_api/state", headers=cookie)[0] == 200)

        print("private answers")
        site.req("PUT", f"/_admin/apps/{s1}", {"private": True}, admin=True)
        sess = cookie["Cookie"]

        def visitor_jar():
            st, r, _ = site.req("GET", f"/{s1}/", headers={"Cookie": sess})
            v = cookie_from(r, "dwa_v").split(";")[0]
            return st, v, {"Cookie": f"{sess}; {v}"} if v else None

        st, va, jar_a = visitor_jar()
        check("first visit sets a visitor cookie (path-scoped, HttpOnly)", st == 200 and bool(va), st)
        _, vb, jar_b = visitor_jar()
        check("each browser gets its own visitor", bool(vb) and va != vb)
        pput = lambda jar, key, value, who: site.req("PUT", f"/{s1}/_api/state/{key}", {"value": value},
                                                     headers={**jar, "X-DWA-Author": who})
        check("visitor A saves", pput(jar_a, "P1.x", "from A", "A")[0] == 200)
        check("visitor B saves the same key", pput(jar_b, "P1.x", "from B", "B")[0] == 200)
        state = lambda jar: {r["key"]: r["value"] for r in json.loads(site.req("GET", f"/{s1}/_api/state", headers=jar)[2])}
        sa, sb = state(jar_a), state(jar_b)
        check("A sees only A's answers (no shared ones)", sa == {"P1.x": "from A"}, sa)
        check("B sees only B's answers", sb == {"P1.x": "from B"}, sb)
        st, r, _ = site.req("GET", f"/{s1}/_api/state", headers={"Cookie": f"{sess}; {va[:-3]}xyz"})
        check("tampered visitor cookie -> a fresh, empty visitor", st == 200 and json.loads(_) == [] and bool(cookie_from(r, "dwa_v")))
        info = json.loads(site.req("GET", f"/{s1}/_api/info", headers=jar_a)[2])
        check("visitor-facing info hides visitor counts", info.get("private") is True and "visitors" not in info and "answers" not in info, info)
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        ids = {r["author"]: r["visitor"] for r in x["private_state"]}
        check("export has each visitor's answers", set(ids) == {"A", "B"} and x["info"]["visitors"] == 2, x.get("private_state"))
        check("socket without a visitor cookie -> 401", site.ws(f"/{s1}/_api/live", sess)[1] == 401)
        sock_a, st_a = site.ws(f"/{s1}/_api/live", jar_a["Cookie"])
        sock_b, st_b = site.ws(f"/{s1}/_api/live", jar_b["Cookie"], {"X-DWA-Visitor": ids.get("A", "")})
        check("visitor sockets -> 101", st_a == 101 and st_b == 101, (st_a, st_b))
        pput(jar_a, "P2.x", "live A", "A")
        try:
            msg = json.loads(ws_read_text(sock_a))
            check("A's change reaches A's socket", msg.get("row", {}).get("key") == "P2.x", msg)
        except Exception as e:
            check("A's change reaches A's socket", False, e)
        try:
            leaked = ws_read_text(sock_b, timeout=2)
            check("A's change does not reach B (even with a forged visitor header)", False, leaked)
        except Exception:
            check("A's change does not reach B (even with a forged visitor header)", True)
        sock_a.close()
        sock_b.close()
        check("admin write without a visitor -> 400",
              site.req("PUT", f"/_admin/apps/{s1}/state/P3.x", {"value": 1}, admin=True)[0] == 400)
        check("admin write to a visitor",
              site.req("PUT", f"/_admin/apps/{s1}/state/P3.x", {"value": "hi A", "visitor": ids.get("A")}, admin=True)[0] == 200
              and state(jar_a).get("P3.x") == "hi A" and "P3.x" not in state(jar_b))
        st, _, body = site.req("POST", f"/_admin/apps/{s1}/links", {"visitor": ids.get("A")}, admin=True)
        u = urllib.parse.urlsplit(json.loads(body)["url"])
        st, r, _ = site.req("GET", f"{u.path}?{u.query}")
        vlink = cookie_from(r, "dwa_v").split(";")[0]
        jar_c = {"Cookie": f"{cookie_from(r).split(';')[0]}; {vlink}"}
        check("visitor link opens that visitor's answers on another browser", st == 303 and state(jar_c).get("P1.x") == "from A")
        print("visits")
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        vis = {v["visitor"]: v for v in x["visits"]}
        check("loading answers records a visit, named from saves", vis.get(ids.get("A"), {}).get("name") == "A", x["visits"])
        n_before = vis.get(ids.get("A"), {}).get("visits")
        site.req("GET", f"/{s1}/_api/state", headers={**jar_a, "X-DWA-Author": "Anna", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"})
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        va_row = {v["visitor"]: v for v in x["visits"]}.get(ids.get("A"), {})
        check("reload within 30 min is the same visit", va_row.get("visits") == n_before, va_row)
        check("visit records the name sent and a device label", va_row.get("name") == "Anna" and va_row.get("device") == "Safari on iPhone", va_row)
        before = len(x["visits"])
        site.req("GET", f"/{s1}/", headers={"Cookie": sess, "User-Agent": "WhatsApp/2.23.20.0"})
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        check("a link preview (page only, no answers loaded) is not a visit", len(x["visits"]) == before, len(x["visits"]))
        info = json.loads(site.req("GET", f"/{s1}/_api/info", headers=jar_a)[2])
        check("visitor-facing info hides visit counts", "visited" not in info, info)

        print("merging visitors")
        _, ve, jar_e = visitor_jar()
        _, vd, jar_d = visitor_jar()
        pput(jar_e, "M1.x", "from E", "Eve")
        pput(jar_e, "M2.e", "only E", "Eve")
        pput(jar_d, "M1.x", "from D", "Eve")  # newer, so it should win
        pput(jar_d, "M3.d", "only D", "Eve")
        state(jar_d)
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        by_key = {(r["key"], r["value"]): r["visitor"] for r in x["private_state"]}
        id_e, id_d = by_key.get(("M2.e", "only E")), by_key.get(("M3.d", "only D"))
        visits_before = {v["visitor"]: v["visits"] for v in x["visits"]}
        sock_d, _ = site.ws(f"/{s1}/_api/live", jar_d["Cookie"])
        st, _, body = site.req("POST", f"/_admin/apps/{s1}/visitors/merge", {"from": id_d, "into": id_e}, admin=True)
        check("merge -> 200", st == 200 and json.loads(body).get("answers") == 3, (st, body))
        want = {"M1.x": "from D", "M2.e": "only E", "M3.d": "only D"}
        check("merged visitor has both sets of answers (newer wins)", state(jar_e) == want, state(jar_e))
        check("the old browser sees the merged answers", state(jar_d) == want, state(jar_d))
        pput(jar_d, "M4.d", "after merge", "Eve")
        check("the old browser's saves land in the merged visitor", state(jar_e).get("M4.d") == "after merge")
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        check("the old id is gone from answers and visits",
              id_d not in {r["visitor"] for r in x["private_state"]} | {v["visitor"] for v in x["visits"]})
        ve_row = {v["visitor"]: v for v in x["visits"]}.get(id_e, {})
        check("visits are added together", ve_row.get("visits") == visits_before.get(id_e, 0) + visits_before.get(id_d, 0), ve_row)
        check("history follows the merge", id_d not in {h.get("visitor") for h in x["history"]})
        check("export lists the merge", any(m["visitor"] == id_d and m["target"] == id_e for m in x.get("merged", [])), x.get("merged"))
        check("merging again -> 400",
              site.req("POST", f"/_admin/apps/{s1}/visitors/merge", {"from": id_d, "into": id_e}, admin=True)[0] == 400)
        try:
            msg = json.loads(ws_read_text(sock_d))
            check("the old browser's open tab is told to reload", msg.get("type") == "reset", msg)
        except Exception as e:
            check("the old browser's open tab is told to reload", False, e)
        sock_d.close()

        site.req("PUT", f"/_admin/apps/{s1}", {"open": True}, admin=True)
        st, r, body = site.req("GET", f"/{s1}/_api/state")
        check("open + private: no cookies -> empty answers and a new visitor", st == 200 and json.loads(body) == [] and bool(cookie_from(r, "dwa_v")))
        check("open + private: visitor still sees only their own", state({"Cookie": va}) .get("P1.x") == "from A")
        site.req("PUT", f"/_admin/apps/{s1}", {"open": False, "private": False}, admin=True)
        check("private off -> shared answers again", "A1.choice" in state(jar_a) and "P1.x" not in state(jar_a))
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        n_visits = len(x["visits"])
        state(jar_b)
        x = json.loads(site.req("GET", f"/_admin/apps/{s1}/export", admin=True)[2])
        check("shared apps record no visits", len(x["visits"]) == n_visits)

        print("password change")
        site.req("PUT", f"/_admin/apps/{s1}", {"password": pw + "-new"}, admin=True)
        check("old session signed out", site.req("GET", f"/{s1}/_api/state", headers=cookie)[0] == 401)
        check("link minted before the change is dead", site.req("GET", f"{stale.path}?{stale.query}")[0] == 410)
        st, r, _ = site.req("POST", f"/{s1}/_login", form={"password": pw + "-new"})
        cookie = {"Cookie": cookie_from(r).split(";")[0]}

        print("closing")
        site.req("PUT", f"/_admin/apps/{s1}", {"closed": True}, admin=True)
        check("visitor write when closed -> 423", put("A1.choice", {"value": "b"})[0] == 423)
        check("closed app still readable", site.req("GET", f"/{s1}/", headers=cookie)[0] == 200)
        check("admin write when closed still works",
              site.req("PUT", f"/_admin/apps/{s1}/state/A3.note", {"value": "from Tom"}, admin=True)[0] == 200)
        site.req("PUT", f"/_admin/apps/{s1}", {"closed": False}, admin=True)
        check("reopened -> writable", put("A1.choice", {"value": "c"})[0] == 200)
        site.req("PUT", f"/_admin/apps/{s1}", {"expires_at": "2000-01-01T00:00:00Z"}, admin=True)
        check("past expiry -> read-only", put("A1.choice", {"value": "d"})[0] == 423)

        print("export")
        st, _, body = site.req("GET", f"/_admin/apps/{s1}/export", admin=True)
        x = json.loads(body)
        check("export has state and full history", st == 200 and len(x["history"]) >= 4 and "pw_hash" not in body.decode(),
              f"{len(x.get('history', []))} history rows")

        print("login lockout (10 wrong attempts, ~8 s)")
        for _ in range(10):
            site.req("POST", f"/{s2}/_login", form={"password": "guess"})
        check("11th attempt -> 429", site.req("POST", f"/{s2}/_login", form={"password": "guess"})[0] == 429)
        check("even the right password is held off", site.req("POST", f"/{s2}/_login", form={"password": pw2})[0] == 429)
    finally:
        print("cleanup")
        for s in (s1, s2):
            st, _, body = site.req("DELETE", f"/_admin/apps/{s}", admin=True)
            check(f"delete {s}", st == 200, body[:80])
        check("deleted app -> 404", site.req("GET", f"/{s1}/")[0] == 404)
        st, _, body = site.req("GET", "/_admin/apps", admin=True)
        check("registry no longer lists it", s1 not in body.decode())

    print(f"\n{'All checks passed.' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
