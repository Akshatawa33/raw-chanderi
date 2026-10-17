// Neelkora server: serves the site from ../rawmango and the JSON API under /api, backed by SQLite.
// No npm packages: Node 22.5+ provides http, crypto, fetch and node:sqlite.
// Run: node server/server.js   (settings in server/.env, see .env.example)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: dev defaults */ }
const ENV = process.env;
const PROD = ENV.NODE_ENV === 'production';
const PORT = +ENV.PORT || 5173;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'rawmango');
const catalog = require(path.join(PUBLIC_DIR, 'catalog.js'));

const cfg = {
  razorpayKey: ENV.RAZORPAY_KEY_ID || '', razorpaySecret: ENV.RAZORPAY_KEY_SECRET || '',
  googleClientId: ENV.GOOGLE_CLIENT_ID || '',
  resendKey: ENV.RESEND_API_KEY || '', mailFrom: ENV.MAIL_FROM || 'Neelkora <orders@example.com>',
  twilioSid: ENV.TWILIO_ACCOUNT_SID || '', twilioToken: ENV.TWILIO_AUTH_TOKEN || '', twilioFrom: ENV.TWILIO_FROM || '',
  // Firebase web config is public by design (it identifies the project; security comes from Firebase rules and token checks)
  firebase: ENV.FIREBASE_API_KEY && ENV.FIREBASE_PROJECT_ID ? {apiKey: ENV.FIREBASE_API_KEY, authDomain: ENV.FIREBASE_AUTH_DOMAIN || `${ENV.FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: ENV.FIREBASE_PROJECT_ID, appId: ENV.FIREBASE_APP_ID || ''} : null,
};
const live = {pay: !!(cfg.razorpayKey && cfg.razorpaySecret), mail: !!cfg.resendKey, sms: !!(cfg.twilioSid && cfg.twilioToken && cfg.twilioFrom), google: !!cfg.googleClientId, firebase: !!cfg.firebase};
if (PROD && (!live.pay || !live.sms)) console.warn('[warn] production without Razorpay or SMS keys: test payments and on-screen codes are disabled, those features will refuse requests.');

// ---------- database ----------
const db = new DatabaseSync(ENV.DB_FILE || path.join(__dirname, 'neelkora.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, phone TEXT UNIQUE, name TEXT NOT NULL,
    password_hash TEXT, google_sub TEXT UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wishlists (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, ids TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, email TEXT NOT NULL, data TEXT NOT NULL,
    total INTEGER NOT NULL, status TEXT NOT NULL, rzp_order_id TEXT, payment_id TEXT, token TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
  CREATE TABLE IF NOT EXISTS otps (phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY, to_addr TEXT, subject TEXT, html TEXT, status TEXT, detail TEXT, created_at INTEGER);
`);
const q = sql => db.prepare(sql);

// ---------- small helpers ----------
const now = () => Date.now();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hashPassword = pw => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
const checkPassword = (pw, stored) => { if (!stored) return false; const [, salt, hash] = stored.split('$');
  return safeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64).toString('hex'), hash); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const money = n => '₹' + Math.round(n).toLocaleString('en-IN');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/, PHONE_RE = /^[6-9]\d{9}$/, PIN_RE = /^[1-9]\d{5}$/;
const str = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

// in-memory rate limits: key -> {n, reset}. shortcut: per process only; use Redis or similar if you run several servers
const hits = new Map();
const limit = (key, max, windowMs, message) => {
  const t = now(), h = hits.get(key);
  if (!h || h.reset < t) return void hits.set(key, {n: 1, reset: t + windowMs});
  if (++h.n > max) fail(429, 'rate_limited', message || 'Too many attempts. Please wait a few minutes and try again.');
};
setInterval(() => { const t = now(); for (const [k, h] of hits) if (h.reset < t) hits.delete(k); q('DELETE FROM sessions WHERE expires_at < ?').run(t); }, 10 * 60e3).unref();

// ---------- sessions ----------
const SESSION_DAYS = 30, COOKIE = 'nk_sid';
const parseCookies = h => Object.fromEntries((h || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
const startSession = (res, userId) => {
  const token = rand();
  q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', cookie(token, SESSION_DAYS * 86400));
};
const currentUser = req => {
  const token = parseCookies(req.headers.cookie)[COOKIE]; if (!token) return null;
  const row = q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha256(token), now());
  return row || null;
};
// phones: Indian numbers are kept as 10 digits (as the SMS sign-in always did); other countries keep their full +code form
const publicUser = u => u && {name: u.name, email: u.email || '', phone: u.phone || '', id: u.email || (u.phone.startsWith('+') ? u.phone : '+91' + u.phone), since: u.created_at, google: !!u.google_sub};
const storedPhone = e164 => e164.startsWith('+91') ? e164.slice(3) : e164;

// ---------- profile, wishlist, orders ----------
const DEFAULT_PROFILE = {addresses: [], upi: [], cards: [], prefPay: 'UPI', phone: ''};
const getProfile = uid => ({...DEFAULT_PROFILE, ...JSON.parse(q('SELECT data FROM profiles WHERE user_id = ?').get(uid)?.data || '{}')});
const getWishlist = uid => JSON.parse(q('SELECT ids FROM wishlists WHERE user_id = ?').get(uid)?.ids || '[]');
const ordersFor = uid => q('SELECT data, status, payment_id, token FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(uid)
  .map(r => ({...JSON.parse(r.data), status: r.status, paymentId: r.payment_id || JSON.parse(r.data).paymentId, token: r.token}));

// validate everything a profile may contain; anything unexpected is dropped, card numbers can never get in
const cleanProfile = p => {
  const id = v => str(v, 20).replace(/[^\w-]/g, '') || rand(6);
  const addresses = (Array.isArray(p.addresses) ? p.addresses : []).slice(0, 20).map(a => {
    const out = {id: id(a.id), label: ['Home', 'Work', 'Other'].includes(a.label) ? a.label : 'Home', name: str(a.name, 80), phone: str(a.phone, 10),
      addr: str(a.addr, 200), city: str(a.city, 60), pin: str(a.pin, 6), state: str(a.state, 40), isDefault: !!a.isDefault};
    if (out.name.length < 2 || !PHONE_RE.test(out.phone) || out.addr.length < 6 || !out.city || !PIN_RE.test(out.pin) || !out.state) fail(400, 'bad_address', 'One of the saved addresses is incomplete.');
    return out; });
  const upi = (Array.isArray(p.upi) ? p.upi : []).slice(0, 10).map(u => {
    const vpa = str(u.vpa, 80).toLowerCase(); if (!/^[\w.\-]{2,}@[a-z]{2,}$/.test(vpa)) fail(400, 'bad_upi', 'A saved UPI ID is not valid.');
    return {id: id(u.id), vpa, nick: str(u.nick, 30), isDefault: !!u.isDefault}; });
  const cards = (Array.isArray(p.cards) ? p.cards : []).slice(0, 10).map(c => {
    const out = {id: id(c.id), holder: str(c.holder, 60), brand: ['Visa', 'Mastercard', 'RuPay', 'American Express'].includes(c.brand) ? c.brand : 'Visa',
      last4: str(c.last4, 4), expiry: str(c.expiry, 5), isDefault: !!c.isDefault};
    if (!/^\d{4}$/.test(out.last4) || !/^(0[1-9]|1[0-2])\/\d{2}$/.test(out.expiry)) fail(400, 'bad_card', 'A saved card is not valid.');
    return out; });
  const fixDefault = arr => { if (arr.length && !arr.some(x => x.isDefault)) arr[0].isDefault = true; return arr; };
  const prefPay = ['UPI', 'Card', 'Cash on delivery'].includes(p.prefPay) ? p.prefPay : 'UPI';
  const phone = str(p.phone, 10); if (phone && !PHONE_RE.test(phone)) fail(400, 'bad_phone', 'Enter a 10-digit mobile number.');
  const out = {addresses: fixDefault(addresses), upi: fixDefault(upi), cards: fixDefault(cards), prefPay, phone};
  if (/\d{12,}/.test(JSON.stringify(out))) fail(400, 'card_number', 'Full card numbers cannot be saved.');
  return out;
};

// ---------- outside services ----------
async function sendSMS(phone, text) {
  if (!live.sms) { console.log(`[sms:dev] to +91${phone}: ${text}`); return; }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioSid}/Messages.json`, {
    method: 'POST', headers: {Authorization: 'Basic ' + Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({To: '+91' + phone, From: cfg.twilioFrom, Body: text})});
  if (!r.ok) { console.error('[sms] failed', r.status, await r.text()); fail(502, 'sms_failed', 'We could not send the code. Please try again in a minute.'); }
}
async function sendEmail(to, subject, html) {
  const log = q('INSERT INTO emails (to_addr, subject, html, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  if (!live.mail) { log.run(to, subject, html, 'logged', 'no RESEND_API_KEY', now()); return {sent: false, reason: 'not-configured'}; }
  try {
    const r = await fetch('https://api.resend.com/emails', {method: 'POST', headers: {Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({from: cfg.mailFrom, to: [to], subject, html})});
    const body = await r.text();
    log.run(to, subject, html, r.ok ? 'sent' : 'failed', body.slice(0, 500), now());
    return r.ok ? {sent: true} : {sent: false, reason: 'error'};
  } catch (err) { log.run(to, subject, html, 'failed', String(err), now()); return {sent: false, reason: 'error'}; }
}
async function verifyGoogle(credential) {
  if (!live.google) fail(400, 'google_off', 'Google sign-in is not set up on this server.');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  const t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== cfg.googleClientId || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || t.email_verified !== 'true' || +t.exp * 1000 < now())
    fail(401, 'google_invalid', 'Google sign-in could not be verified. Please try again.');
  return {sub: t.sub, email: t.email.toLowerCase(), name: t.name || t.given_name || t.email.split('@')[0]};
}
// Firebase phone sign-in: ask Google who this ID token belongs to. An invalid, expired or other-project token is rejected by Google.
async function verifyFirebase(idToken) {
  if (!live.firebase) fail(400, 'firebase_off', 'Phone sign-in with Firebase is not set up on this server.');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(cfg.firebase.apiKey)}`,
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({idToken})});
  const body = await r.json().catch(() => ({}));
  const user = r.ok && body.users && body.users[0];
  if (!user || !/^\+\d{8,15}$/.test(user.phoneNumber || '')) fail(401, 'firebase_invalid', 'We could not confirm your phone sign-in. Please request a new code.');
  return {phone: user.phoneNumber, uid: user.localId};
}
async function razorpayOrder(amountPaise, receipt) {
  const r = await fetch('https://api.razorpay.com/v1/orders', {method: 'POST',
    headers: {Authorization: 'Basic ' + Buffer.from(`${cfg.razorpayKey}:${cfg.razorpaySecret}`).toString('base64'), 'Content-Type': 'application/json'},
    body: JSON.stringify({amount: amountPaise, currency: 'INR', receipt, payment_capture: 1})});
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('[razorpay] order failed', r.status, body); fail(502, 'payment_unavailable', 'The payment service is not responding. Please try again.'); }
  return body.id;
}

// ---------- order email ----------
const receiptHTML = o => {
  const rows = o.items.map(i => `<tr><td style="padding:10px 0;border-bottom:1px solid #e8e3db">${esc(i.name)} × ${i.qty}<br><span style="color:#7a6f6a;font-size:13px">${esc(i.blouseLabel)}</span></td>
    <td style="padding:10px 0;border-bottom:1px solid #e8e3db;text-align:right;white-space:nowrap">${money(i.price)}</td></tr>`).join('');
  const line = (k, v, b) => `<tr><td style="padding:4px 0;${b ? 'font-weight:bold;font-size:17px' : ''}">${k}</td><td style="padding:4px 0;text-align:right;${b ? 'font-weight:bold;font-size:17px' : ''}">${v}</td></tr>`;
  return `<div style="background:#F4F1EC;padding:24px 12px;font-family:Georgia,'Times New Roman',serif;color:#161412">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-collapse:collapse">
      <tr><td style="background:#161412;padding:24px;text-align:center;color:#B08D57;font-size:28px;font-style:italic">Neelkora</td></tr>
      <tr><td style="padding:28px 28px 8px">
        <h1 style="font-weight:normal;font-size:26px;margin:0 0 8px">Thank you, ${esc(o.name.split(' ')[0])}</h1>
        <p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;margin:0 0 4px">Your order <b>${esc(o.id)}</b> is confirmed and is being packed by hand.</p>
        <p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;margin:0">Arriving by <b>${esc(o.eta)}</b>, wrapped in a cotton bundle.</p></td></tr>
      <tr><td style="padding:16px 28px;font-family:Arial,sans-serif;font-size:15px">
        <table role="presentation" width="100%" style="border-collapse:collapse">${rows}</table>
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:12px">
          ${line('Subtotal', money(o.subtotal))}${o.discount ? line('Promo', '−' + money(o.discount)) : ''}${line('Shipping', o.shipping ? money(o.shipping) : 'Free')}${line('Total', money(o.total), true)}
        </table></td></tr>
      <tr><td style="padding:8px 28px 28px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#4a403c">
        <b style="color:#161412">Delivering to</b><br>${esc(o.name)}<br>${esc(o.address)}<br>${esc(o.city)} ${esc(o.pin)}, ${esc(o.state)}<br><br>
        <b style="color:#161412">Payment</b><br>${o.pay === 'Cash on delivery' ? 'Cash on delivery: ' + money(o.total) + ' to pay at your door' : esc(o.pay) + ', reference ' + esc(o.paymentId)}</td></tr>
      <tr><td style="background:#161412;color:#F4F1EC;padding:18px 28px;font-family:Arial,sans-serif;font-size:12px;text-align:center">Prices include GST. Questions? Reply to this email.</td></tr>
    </table></div>`;
};
const confirmOrder = async (orderId, paymentId) => {
  q('UPDATE orders SET status = ?, payment_id = ? WHERE id = ?').run(paymentId === 'COD' ? 'placed' : 'paid', paymentId, orderId);
  const row = q('SELECT data FROM orders WHERE id = ?').get(orderId), o = {...JSON.parse(row.data), paymentId};
  q('UPDATE orders SET data = ? WHERE id = ?').run(JSON.stringify(o), orderId);
  const mail = await sendEmail(o.email, `Your Neelkora order ${o.id}`, receiptHTML(o));
  return {order: o, email: mail};
};

// ---------- request plumbing ----------
const readJSON = req => new Promise((ok, bad) => {
  let size = 0, chunks = [];
  req.on('data', c => { size += c.length; if (size > 100e3) { bad(new HttpError(413, 'too_large', 'Request too large.')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { bad(new HttpError(400, 'bad_json', 'Invalid request.')); } });
  req.on('error', bad);
});
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
  res.end(JSON.stringify(body));
};
// behind Netlify's proxy every request comes from Netlify, so with TRUST_PROXY the visitor's IP is read from the forwarded header
const ip = req => (ENV.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
  || (req.socket.remoteAddress || '').replace('::ffff:', '');
// sites allowed to call the API: this server itself, plus the Netlify (or custom) domains listed in ALLOWED_ORIGINS
const ALLOWED = new Set((ENV.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean));
const originOk = req => { const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host || ALLOWED.has(o.replace(/\/$/, '')); } catch { return false; } };
const needUser = req => currentUser(req) || fail(401, 'signed_out', 'Please sign in again.');

// ---------- API routes ----------
const routes = {
  // public keys only: the browser never sees secrets
  'GET /config.js': (req, res) => {
    res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(`window.NK_CONFIG = ${JSON.stringify({razorpayKey: cfg.razorpayKey, googleClientId: cfg.googleClientId, firebase: cfg.firebase, live, api: true})};`);
  },

  'GET /api/me': req => {
    const u = currentUser(req);
    if (!u) return {user: null};
    return {user: publicUser(u), profile: getProfile(u.id), wishlist: getWishlist(u.id), orders: ordersFor(u.id)};
  },

  'POST /api/auth/signup': async (req, res, b) => {
    const name = str(b.name, 80), email = str(b.email, 200).toLowerCase(), pw = typeof b.password === 'string' ? b.password : '';
    limit('signup:' + ip(req), 10, 60 * 60e3);
    if (name.length < 2) fail(400, 'bad_name', 'Enter your name.');
    if (!EMAIL_RE.test(email)) fail(400, 'bad_email', 'Enter an email like name@example.com.');
    if (pw.length < 8 || pw.length > 200) fail(400, 'bad_password', 'Use at least 8 characters.');
    if (q('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    const {lastInsertRowid: id} = q('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)').run(email, name, hashPassword(pw), now());
    startSession(res, id);
    return mePayload(id);
  },
  'POST /api/auth/login': async (req, res, b) => {
    const email = str(b.email, 200).toLowerCase(), pw = typeof b.password === 'string' ? b.password : '';
    limit('login:' + ip(req), 30, 15 * 60e3); limit('login:' + email, 8, 15 * 60e3);
    const u = q('SELECT * FROM users WHERE email = ?').get(email);
    // one message for a wrong email or password; accounts without a password get pointed to their sign-in method
    // (sign-up already tells people an email is taken, so this reveals nothing new; per-email rate limit above slows guessing)
    if (!u || !checkPassword(pw, u.password_hash)) fail(401, 'bad_login', u && !u.password_hash ? 'This account uses Google or a phone code to sign in.' : 'That email and password do not match.');
    startSession(res, u.id);
    return mePayload(u.id);
  },
  'POST /api/auth/google': async (req, res, b) => {
    limit('google:' + ip(req), 30, 15 * 60e3);
    const g = await verifyGoogle(str(b.credential, 4000));
    let u = q('SELECT * FROM users WHERE google_sub = ? OR email = ?').get(g.sub, g.email);
    if (!u) u = {id: q('INSERT INTO users (email, name, google_sub, created_at) VALUES (?, ?, ?, ?)').run(g.email, g.name, g.sub, now()).lastInsertRowid};
    else if (!u.google_sub) q('UPDATE users SET google_sub = ? WHERE id = ?').run(g.sub, u.id);
    startSession(res, u.id);
    return mePayload(u.id);
  },
  'POST /api/auth/otp/send': async (req, res, b) => {
    const phone = str(b.phone, 10);
    if (!PHONE_RE.test(phone)) fail(400, 'bad_phone', 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9.');
    if (PROD && !live.sms) fail(503, 'sms_off', 'Phone sign-in is not available right now. Please use email.');
    limit('otp:ip:' + ip(req), 20, 60 * 60e3); limit('otp:ph:' + phone, 5, 60 * 60e3, 'Too many codes for this number. Try again in an hour.');
    const prev = q('SELECT sent_at FROM otps WHERE phone = ?').get(phone);
    if (prev && now() - prev.sent_at < 30e3) fail(429, 'too_soon', 'Please wait 30 seconds before asking for another code.');
    const code = String(crypto.randomInt(100000, 1000000));
    q('INSERT OR REPLACE INTO otps (phone, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)').run(phone, sha256(phone + ':' + code), now() + 5 * 60e3, now());
    await sendSMS(phone, `${code} is your Neelkora sign-in code. It expires in 5 minutes. Do not share it.`);
    const isNew = !q('SELECT 1 FROM users WHERE phone = ?').get(phone);
    // dev only: with no SMS provider, hand the code back so the flow can be tested end to end
    return {ok: true, isNew, ...(!live.sms && !PROD ? {devCode: code} : {})};
  },
  'POST /api/auth/otp/verify': async (req, res, b) => {
    const phone = str(b.phone, 10), code = str(b.code, 6), name = str(b.name, 80);
    limit('otpv:' + ip(req), 40, 60 * 60e3);
    const row = q('SELECT * FROM otps WHERE phone = ?').get(phone);
    if (!row || row.expires_at < now()) fail(400, 'code_expired', 'That code has expired. Tap Resend to get a new one.');
    if (row.attempts >= 5) fail(429, 'too_many_wrong', 'Too many wrong codes. Tap Resend to get a new code.');
    if (!safeEqual(sha256(phone + ':' + code), row.code_hash)) {
      q('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
      fail(400, 'wrong_code', 'That code is not right. Check the text message and try again.');
    }
    let u = q('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!u) {
      if (name.length < 2) fail(400, 'name_required', 'Enter your name.');
      u = {id: q('INSERT INTO users (phone, name, created_at) VALUES (?, ?, ?)').run(phone, name, now()).lastInsertRowid};
      q('INSERT INTO profiles (user_id, data) VALUES (?, ?)').run(u.id, JSON.stringify({...DEFAULT_PROFILE, phone}));
    }
    q('DELETE FROM otps WHERE phone = ?').run(phone);   // a code works once
    startSession(res, u.id);
    return mePayload(u.id);
  },
  // Firebase sent and checked the SMS code in the browser; here the server confirms that sign-in with Google and opens a session
  'POST /api/auth/firebase': async (req, res, b) => {
    limit('fb:' + ip(req), 40, 60 * 60e3);
    const fb = await verifyFirebase(str(b.idToken, 5000)), phone = storedPhone(fb.phone), name = str(b.name, 80);
    let u = q('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!u) {
      if (name.length < 2) fail(400, 'name_required', 'Enter your name.');   // the token stays valid for an hour, so the browser just asks and resends
      u = {id: q('INSERT INTO users (phone, name, created_at) VALUES (?, ?, ?)').run(phone, name, now()).lastInsertRowid};
      q('INSERT INTO profiles (user_id, data) VALUES (?, ?)').run(u.id, JSON.stringify({...DEFAULT_PROFILE, phone: PHONE_RE.test(phone) ? phone : ''}));
    }
    startSession(res, u.id);
    return mePayload(u.id);
  },
  'POST /api/auth/logout': (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', cookie('', 0));
    return {ok: true};
  },

  'PUT /api/profile': async (req, res, b) => {
    const u = needUser(req);
    if (b.name !== undefined) { const name = str(b.name, 80); if (name.length < 2) fail(400, 'bad_name', 'Enter your name.'); q('UPDATE users SET name = ? WHERE id = ?').run(name, u.id); }
    const p = cleanProfile({...getProfile(u.id), ...b});
    q('INSERT INTO profiles (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data').run(u.id, JSON.stringify(p));
    return {profile: p, user: publicUser(q('SELECT * FROM users WHERE id = ?').get(u.id))};
  },
  'PUT /api/wishlist': async (req, res, b) => {
    const u = needUser(req);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).filter(id => catalog.get(id)))].slice(0, 100);
    q('INSERT INTO wishlists (user_id, ids) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET ids = excluded.ids').run(u.id, JSON.stringify(ids));
    return {wishlist: ids};
  },

  // create the order: the server prices it from the catalogue and opens the Razorpay order for that exact amount
  'POST /api/orders': async (req, res, b) => {
    const u = currentUser(req);
    limit('order:' + ip(req), 30, 60 * 60e3);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).map(i => ({id: str(i.id, 20), blouse: str(i.blouse, 20), qty: Math.floor(+i.qty)}));
    if (!items.length) fail(400, 'empty', 'Your bag is empty.');
    for (const i of items) if (!catalog.get(i.id) || !catalog.validBlouse(i.blouse) || !(i.qty >= 1 && i.qty <= catalog.MAX_QTY)) fail(400, 'bad_item', 'Something in your bag is no longer available. Please review your bag.');
    const c = b.contact || {}, a = b.address || {};
    const order = {email: str(c.email, 200).toLowerCase(), phone: str(c.phone, 10), name: str(c.name, 80),
      address: str(a.addr, 200), city: str(a.city, 60), pin: str(a.pin, 6), state: str(a.state, 40)};
    if (!EMAIL_RE.test(order.email)) fail(400, 'bad_email', 'Enter an email like name@example.com.');
    if (!PHONE_RE.test(order.phone)) fail(400, 'bad_phone', 'Enter a 10-digit mobile number.');
    if (order.name.length < 2 || order.address.length < 6 || !order.city || !PIN_RE.test(order.pin) || !order.state) fail(400, 'bad_address', 'Please complete the delivery address.');
    const pay = ['UPI', 'Card', 'Cash on delivery'].includes(b.pay) ? b.pay : fail(400, 'bad_pay', 'Choose a payment method.');
    const express = !!b.express, t = catalog.totals(items, b.coupon, express);
    if (pay === 'Cash on delivery' && t.total >= catalog.COD_LIMIT) fail(400, 'cod_limit', 'Cash on delivery is for orders under ₹50,000.');
    const id = 'NK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const eta = new Date(now() + (express ? 2 : 5) * 864e5).toLocaleDateString('en-IN', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata'});
    Object.assign(order, {id, account: u ? (u.email || '+91' + u.phone) : null, date: now(), eta, pay, express, ...t, coupon: t.discount ? str(b.coupon, 20).toUpperCase() : '',
      items: items.map(i => ({id: i.id, name: catalog.get(i.id).name, qty: i.qty, blouse: i.blouse, blouseLabel: catalog.blouseLabel(i.blouse), price: catalog.unitPrice(i) * i.qty}))});
    let rzpOrderId = null;
    if (pay !== 'Cash on delivery' && live.pay) rzpOrderId = await razorpayOrder(t.total * 100, id);
    if (pay !== 'Cash on delivery' && !live.pay && PROD) fail(503, 'payments_off', 'Online payment is not available right now. Please choose cash on delivery.');
    const token = rand(18);
    q('INSERT INTO orders (id, user_id, email, data, total, status, rzp_order_id, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, u ? u.id : null, order.email, JSON.stringify(order), t.total, 'pending_payment', rzpOrderId, token, now());
    if (pay === 'Cash on delivery') { const done = await confirmOrder(id, 'COD'); return {order: {...done.order, token, status: 'placed'}, email: done.email}; }
    return {order: {id, total: t.total, token}, payment: live.pay ? {mode: 'razorpay', key: cfg.razorpayKey, orderId: rzpOrderId, amount: t.total * 100} : {mode: 'test'}};
  },
  // confirm payment: Razorpay's signature proves the payment is real and for this order
  'POST /api/orders/pay': async (req, res, b) => {
    const row = q('SELECT * FROM orders WHERE id = ?').get(str(b.orderId, 20));
    if (!row || !safeEqual(str(b.token, 40), row.token)) fail(404, 'no_order', 'Order not found.');
    if (row.status !== 'pending_payment') fail(409, 'already_done', 'This order has already been placed.');
    let paymentId;
    if (live.pay) {
      const expected = crypto.createHmac('sha256', cfg.razorpaySecret).update(`${row.rzp_order_id}|${str(b.razorpay_payment_id, 40)}`).digest('hex');
      if (str(b.razorpay_order_id, 40) !== row.rzp_order_id || !safeEqual(expected, str(b.razorpay_signature, 200))) fail(400, 'bad_signature', 'We could not confirm this payment. If money was taken, it will be refunded automatically.');
      paymentId = str(b.razorpay_payment_id, 40);
    } else {
      if (PROD) fail(503, 'payments_off', 'Online payment is not available right now.');
      paymentId = 'pay_test_' + rand(7);   // dev only: no payment provider configured
    }
    const done = await confirmOrder(row.id, paymentId);
    return {order: {...done.order, token: row.token, status: 'paid'}, email: done.email};
  },
  'GET /api/orders/receipt': (req, res, b, url) => {
    const row = q('SELECT data, token FROM orders WHERE id = ?').get(url.searchParams.get('id') || '');
    if (!row || !safeEqual(url.searchParams.get('t') || '', row.token)) { res.writeHead(404, {'Content-Type': 'text/plain'}); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"});
    res.end(receiptHTML(JSON.parse(row.data)));
  },
};
const mePayload = uid => ({user: publicUser(q('SELECT * FROM users WHERE id = ?').get(uid)), profile: getProfile(uid), wishlist: getWishlist(uid), orders: ordersFor(uid)});

// ---------- static files ----------
const TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon'};
const serveStatic = (req, res, url) => {
  let rel = decodeURIComponent(url.pathname); if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {   // same branded page Netlify shows for a missing address
      return fs.readFile(path.join(PUBLIC_DIR, '404.html'), (e2, page) => { res.writeHead(404, {'Content-Type': e2 ? 'text/plain' : TYPES['.html']}); res.end(e2 ? 'Not found' : page); });
    }
    const ext = path.extname(file);
    // pages, scripts and styles are re-checked every time so an update shows at once; images can be cached
    res.writeHead(200, {'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff'});
    res.end(data);
  });
};

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    if (url.pathname.startsWith('/api/')) return send(res, 404, {error: 'not_found', message: 'Not found.'});
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  }
  try {
    let body = {};
    if (req.method !== 'GET') {
      // CSRF guard: JSON only, and from this site only (cookies are SameSite=Lax as well)
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'json_only', 'Unsupported request.');
      if (!originOk(req)) fail(403, 'bad_origin', 'Request blocked.');
      body = await readJSON(req);
    }
    const out = await handler(req, res, body, url);
    if (!res.writableEnded) send(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, {error: err.code, message: err.message});
    console.error('[error]', req.method, url.pathname, err);
    send(res, 500, {error: 'server_error', message: 'Something went wrong on our side. Please try again.'});
  }
});
server.listen(PORT, () => {
  console.log(`Neelkora running at http://localhost:${PORT}`);
  console.log(`  payments: ${live.pay ? 'Razorpay LIVE' : 'test mode'} | email: ${live.mail ? 'Resend' : 'logged to db'} | sms: ${live.firebase ? 'Firebase' : live.sms ? 'Twilio' : 'printed here (dev)'} | google: ${live.google ? 'on' : 'off'}`);
});
