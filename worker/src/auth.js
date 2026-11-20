// Password hashing and signed tokens (session cookies, one-time entry links), all on WebCrypto.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  // 100k is the Workers runtime's PBKDF2 ceiling.
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${b64u(salt)}.${b64u(await pbkdf2(password, salt))}`;
}

export async function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(".");
  if (!salt || !hash) return false;
  const got = b64u(await pbkdf2(password, fromB64u(salt)));
  return safeEqual(got, hash);
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// Token = base64url(JSON payload) + "." + HMAC. Every payload carries a kind (`k`) so a session
// cookie can never be replayed as an entry link or vice versa.
export async function makeToken(secret, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readToken(secret, token, kind) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(await hmac(secret, body), sig)) return null;
  try {
    const payload = JSON.parse(dec.decode(fromB64u(body)));
    if (payload.k !== kind || typeof payload.e !== "number" || payload.e < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// A short fingerprint of the password hash goes into each session, so changing an app's
// password signs everyone out of it.
export const fingerprint = (pwHash) => String(pwHash).slice(-12);
