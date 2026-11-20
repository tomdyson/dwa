// dwa.js — shared state for a disposable web app. Served at /<app>/_dwa.js.
// Load it with a plain <script> BEFORE Alpine's deferred script, so the store registers on alpine:init.
(() => {
  const slug = location.pathname.split("/")[1];
  const base = `/${slug}/_api`;
  const NAME_KEY = "dwa_author";
  const remember = {
    get: () => { try { return localStorage.getItem(NAME_KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(NAME_KEY, v); } catch {} },
  };

  // A personal entry link (dwa link --as NAME) leaves the name in a short-lived cookie.
  const linkName = decodeURIComponent((document.cookie.match(/(?:^|;\s*)dwa_name=([^;]*)/) || [])[1] || "");
  if (linkName) {
    remember.set(linkName);
    document.cookie = `dwa_name=; Path=/${slug}/; Max-Age=0; Secure; SameSite=Lax`;
  }
  let name = remember.get();

  // --- name dialog (inline styles, so it works whatever CSS the page has) ---------------------
  const css = document.createElement("style");
  css.textContent = `dialog.dwa-dialog::backdrop{background:rgba(43,43,43,.4)}
    dialog.dwa-dialog input:focus{outline:2px solid #E76F51;border-color:transparent}`;
  document.head.appendChild(css);

  function askName(current) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "dwa-dialog";
      d.setAttribute("aria-labelledby", "dwa-name-title");
      // margin:auto centres the modal; Tailwind's preflight resets the browser's own centring.
      d.style.cssText = "margin:auto;border:0;border-radius:18px;padding:1.75rem;width:min(22rem,calc(100vw - 2rem));box-sizing:border-box;" +
        "box-shadow:0 20px 50px -12px rgba(0,0,0,.35);font-family:Inter,system-ui,sans-serif;color:#2B2B2B";
      const field = "font:inherit;width:100%;box-sizing:border-box;padding:.65rem .85rem;border-radius:10px;";
      d.innerHTML = `<form method="dialog" style="margin:0">
        <h2 id="dwa-name-title" style="font-family:'Gowun Batang',serif;font-weight:400;font-size:1.35rem;margin:0 0 .4rem">What's your name?</h2>
        <p style="margin:0 0 1rem;font-size:.9rem;line-height:1.45;color:#6b6259">It appears next to your answers, so everyone can see who said what.</p>
        <input name="n" required maxlength="80" autocomplete="name" style="${field}border:1px solid #d9d1c7;margin-bottom:.8rem">
        <button style="${field}border:0;background:#2B2B2B;color:#fff;cursor:pointer">Continue</button></form>`;
      const input = d.querySelector("input");
      input.value = current || "";
      let done = false;
      const finish = (v) => { if (done) return; done = true; d.remove(); resolve(v); };
      // The first time, there's no way out without a name.
      d.addEventListener("cancel", (e) => { if (!current) e.preventDefault(); });
      d.querySelector("form").addEventListener("submit", (e) => {
        const v = input.value.trim();
        if (!v) return e.preventDefault();
        finish(v);
      });
      d.addEventListener("close", () => finish(current));
      document.body.appendChild(d);
      d.showModal();
    });
  }

  let asking = null;
  async function me() {
    if (name) return name;
    asking ??= askName("").then((v) => { name = v; remember.set(v); asking = null; return v; });
    return asking;
  }
  async function changeName() {
    const v = await askName(name);
    if (v) { name = v; remember.set(v); }
    return name;
  }

  // --- API ----------------------------------------------------------------------------------
  async function call(path, opts = {}) {
    const r = await fetch(base + path, { credentials: "same-origin", ...opts });
    if (r.status === 401) { location.reload(); throw new Error("Signed out"); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(body.error === "closed" ? "This page is closed, so answers can't be changed." : body.error || `Request failed (${r.status})`);
    }
    return body;
  }

  function ago(iso) {
    if (!iso) return "";
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  const api = {
    slug, ago, me, changeName,
    get name() { return name; },
    info: () => call("/info"),
    async load() {
      // The name (if we have it yet) lets private apps label the visit for Tom.
      const rows = await call("/state", name ? { headers: { "X-DWA-Author": encodeURIComponent(name) } } : {});
      return Object.fromEntries(rows.map((r) => [r.key, r]));
    },
    async set(key, value) {
      const author = await me();
      return call(`/state/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-DWA-Author": encodeURIComponent(author) },
        body: JSON.stringify({ value }),
      });
    },
    // onMessage({type: "set", row} | {type: "reset"} | {type: "info"}); reconnects with backoff.
    subscribe(onMessage) {
      let delay = 1000;
      const connect = () => {
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/live`);
        ws.onopen = () => { delay = 1000; };
        ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
        ws.onclose = () => setTimeout(connect, (delay = Math.min(delay * 2, 30000)));
      };
      connect();
    },
  };
  window.dwa = api;

  function showClosedBanner() {
    if (document.getElementById("dwa-closed")) return;
    const b = document.createElement("div");
    b.id = "dwa-closed";
    b.setAttribute("role", "status");
    b.style.cssText = "position:sticky;top:0;z-index:50;background:#2B2B2B;color:#fff;" +
      "font:500 .875rem/1.4 Inter,system-ui,sans-serif;padding:.6rem 1rem;text-align:center";
    b.textContent = "This page is closed. You can still read it, but answers can no longer be changed.";
    document.body.prepend(b);
  }

  // --- Alpine integration: $store.dwa and x-data="dwaText('key')" ------------------------------
  document.addEventListener("alpine:init", () => {
    const Alpine = window.Alpine;
    Alpine.store("dwa", {
      ready: false, me: name, info: {}, state: {}, saving: {}, error: null,
      get closed() { return Boolean(this.info.closed); },
      val(k, fallback) { const r = this.state[k]; return r === undefined ? fallback : r.value; },
      by(k) { return this.state[k]?.author || ""; },
      ago(k) { return ago(this.state[k]?.at); },
      has(k) {
        const v = this.val(k);
        return !(v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length));
      },
      count(keys) { return keys.filter((k) => this.has(k)).length; },
      includes(k, item) { const v = this.val(k); return Array.isArray(v) && v.includes(item); },
      async save(k, v) {
        if (this.closed) return;
        this.saving[k] = true;
        this.error = null;
        try {
          this.state[k] = await api.set(k, v);
          this.me = api.name;
        } catch (e) {
          this.error = e.message;
        } finally {
          this.saving[k] = false;
        }
      },
      // Checklists: the value is an array; toggle one item in or out.
      toggle(k, item) {
        const cur = Array.isArray(this.val(k)) ? [...this.val(k)] : [];
        const i = cur.indexOf(item);
        i >= 0 ? cur.splice(i, 1) : cur.push(item);
        return this.save(k, cur);
      },
      async rename() { this.me = await api.changeName(); },
      async refresh() { this.state = await api.load(); },
    });

    // Free text: keeps a local draft while the field has focus, so a colleague's live update
    // can't overwrite what you're typing. Usage:
    //   <textarea x-data="dwaText('A1.note')" x-model="draft" x-bind="field"></textarea>
    Alpine.data("dwaText", (key) => ({
      key, draft: "", focused: false,
      init() {
        this.draft = this.$store.dwa.val(key, "");
        this.$watch(() => this.$store.dwa.val(key, ""), (v) => { if (!this.focused) this.draft = v; });
      },
      commit() {
        if (this.draft !== this.$store.dwa.val(key, "")) this.$store.dwa.save(key, this.draft);
      },
      field: {
        ["@focus"]() { this.focused = true; },
        ["@blur"]() { this.focused = false; this.commit(); },
        ["@input.debounce.800ms"]() { this.commit(); },
        [":disabled"]() { return this.$store.dwa.closed; },
      },
    }));
  });

  document.addEventListener("alpine:initialized", async () => {
    const s = window.Alpine.store("dwa");
    try {
      [s.info, s.state] = await Promise.all([api.info(), api.load()]);
    } catch (e) {
      s.error = e.message;
      return;
    }
    s.ready = true;
    if (s.closed) showClosedBanner();
    else {
      const hadName = Boolean(api.name);
      s.me = await api.me();
      // Private apps: reload once the visitor has given their name, so Tom's list of visits shows it.
      if (s.info.private && !hadName && s.me) s.refresh().catch(() => {});
    }
    api.subscribe(async (msg) => {
      if (msg.type === "set") s.state[msg.row.key] = msg.row;
      else if (msg.type === "reset") s.state = await api.load();
      else if (msg.type === "info") {
        s.info = await api.info();
        if (s.closed) showClosedBanner();
      }
    });
    // Catch up on anything missed while the laptop slept.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) s.refresh().catch(() => {}); });
  });
})();
