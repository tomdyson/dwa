# dwa — disposable web apps

Password-protected interactive pages for sharing with clients: they tick choices, answer questions or review rows; answers are stored server-side, shown live to everyone on the page, and read back by Claude (`dwa data`). Apps live at `https://with.tomd.org/<slug>/`, close after 60 days and are deleted once they've served.

The `/dwa` Claude Code skill (`skill/SKILL.md`, symlinked into `~/.claude/skills/dwa`) is the how-to for making one. This README is about the machinery.

## Architecture

One Cloudflare Worker (`worker/`, name `dwa`, custom domain `with.tomd.org`) hosts every app. Making an app is data, not a deploy.

| Piece | Holds |
|---|---|
| R2 bucket `dwa-files` | each app's files under `<slug>/` (HTML, CSS, images, JSON) |
| Durable Object `AppStore`, one per app (`idFromName(slug)`, SQLite) | settings and password hash, current answers (`state`, or `pstate` per visitor for private apps), append-only history, login failures, used link nonces; live WebSocket connections (hibernatable, tagged by visitor in private apps) |
| Durable Object `Registry` (single instance) | the list of app slugs |

Files are in R2 rather than the Durable Object because Durable Object SQLite caps a row at 2 MB in production. The local simulator does not enforce that cap.

**Request flow** for `/<slug>/…`:
1. Look up the app's Durable Object; unknown → 404.
2. `_login` (POST): password check with PBKDF2 and a per-IP lockout, then a signed session cookie scoped to `Path=/<slug>/`.
3. `_enter?t=…`: one-time link from `dwa link`. GET shows a Continue button; the button's POST signs the visitor in.
4. Everything else needs the session:
   - `_dwa.js`: the browser library, `worker/src/dwa.client.js`.
   - `_api/info`, `_api/state` (GET), `_api/state/<key>` (PUT).
   - `_api/live`: WebSocket.
   - any other path: a file from R2.

**Admin API** (`/_admin/apps…`, `Authorization: Bearer $DWA_ADMIN_TOKEN`): create/configure, list, files (list/put/delete), export, admin state writes, clear state, one-time links, delete. The `dwa` CLI is its only client.

**Security model.**
- **Password:** one shared password per app, hashed with PBKDF2-SHA256 at 100k iterations.
- **Private apps:** with `private` set, the Worker gives each browser a signed `dwa_v` cookie (HttpOnly, path-scoped, about 400 days) holding a random visitor id, and reads and writes only that visitor's rows in `pstate`. Live updates go only to sockets tagged with the same id; the Worker sets the tag from the cookie and drops any `X-DWA-Visitor` header the browser sends. Visitor-facing `_api/info` leaves out answer and visitor counts. Caps: 500 keys per visitor, 20,000 private rows per app. `dwa link --visitor` mints an entry link that also sets that visitor's cookie. Visits: when a private app's page loads a visitor's answers (`GET _api/state`), the app records it in `visits` (first and last time, number of visits with a 30-minute gap, the name the browser sends, a rough device label from the User-Agent). Link previews don't run the page's script, so they never count. `dwa reset` clears visits too. `dwa merge` (admin `POST /_admin/apps/<slug>/visitors/merge {from, into}`) folds one visitor into another: `pstate` rows (newer wins), history and visits move to `into`, and `from` goes into an `aliases` table so the browser still holding `from`'s cookie reads and writes the merged answers; its open sockets get a reset and are closed so they reconnect under the merged id.
- **Open apps:** an app with `open` set (`dwa new --open`, `dwa open`) skips sign-in entirely: anyone with the URL can read the page and the answers, and write answers, within the limits below. It still has a password hash, which `dwa password` reinstates (and clears `open`).
- **Session cookie:** HMAC-signed, HttpOnly, Secure, SameSite=Lax, scoped to the app's path. It carries a fingerprint of the password hash, so a password change signs everyone out and kills outstanding links.
- **Entry links:** single use (nonce recorded in the app's object), expire after `--minutes`. Opening one doesn't use it: only the Continue button's POST does, so a link preview (WhatsApp, iMessage, a mail scanner) fetching the URL leaves it valid.
- **Login throttling:** 10 failures per IP per 15 minutes, or 200 per app per hour, then 429 for a while, plus a 750 ms delay on each failure.
- **Every response:** `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`, `nosniff`.
- **Limits on visitor writes:** keys `[A-Za-z0-9_.:/-]{1,200}`, values up to 64 KB, at most 5,000 keys per app.
- **Not checked:** visitor names (the password is shared).
- **Outbound:** none. The Worker sends no email and calls no third-party services.

## Setup (done once, 14 Oct 2026)

- `~/.config/dwa/.env` (mode 600):
  - `CLOUDFLARE_API_TOKEN`: an account-owned token "dwa deploy" with Workers Scripts Write, plus Workers Routes Edit on tomd.org.
  - `CLOUDFLARE_ACCOUNT_ID`, `DWA_BASE_URL=https://with.tomd.org`, `DWA_ADMIN_TOKEN`.
- Worker secrets: `ADMIN_TOKEN` (same value as `DWA_ADMIN_TOKEN`) and `SESSION_SECRET` (random; rotating it signs everyone out of every app). Set with `npx wrangler secret put` from `worker/`, using the token above.
- R2 bucket `dwa-files`. It was created through the Cloudflare connector and landed in ENAM; the dwa token has no R2 permissions.
- `ln -s ~/Documents/code/dwa/cli/dwa ~/.local/bin/dwa` and `ln -s ~/Documents/code/dwa/skill ~/.claude/skills/dwa`.
- Local secrets for `wrangler dev` are in `worker/.dev.vars` (gitignored).

## Development

```bash
dwa dev                      # wrangler dev on 127.0.0.1:8799 (local R2 + Durable Objects)
dwa --local new demo --title Demo
dwa --local push demo skill/templates/decisions
scripts/smoke.py --local     # every gate, end to end; creates and deletes its own apps
dwa deploy                   # wrangler deploy with the token from ~/.config/dwa/.env
scripts/smoke.py             # the same checks against production
```

- **Wrangler:** pinned in `cli/dwa` (`WRANGLER`).
- **Durable Object migrations:** append-only `[[migrations]]` in `worker/wrangler.toml`. Never edit or remove an existing tag.
- **Browser library:** loaded as text, through a `[[rules]]` entry for `*.client.js`.

## Operations

- **What exists:** `dwa ls`.
- **Remove an app:** `dwa rm <slug>` (it exports first).
- **Remove everything:**
  1. `dwa rm` every app.
  2. Delete the Worker (dashboard, or `npx wrangler delete` from `worker/`). This also drops the `with.tomd.org` custom domain.
  3. Delete the `dwa-files` bucket.
  4. Revoke the "dwa deploy" token.
- **Cost:** within the Workers free tier at this scale (R2 10 GB free; Durable Objects on SQLite storage).
- **Data inspection** outside the CLI: the Cloudflare dashboard's Durable Objects Data Studio shows each app's tables.
