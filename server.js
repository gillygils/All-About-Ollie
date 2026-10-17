'use strict';

// Family Scrapbook — a private, PIN-locked photo timeline.
// Two locks: a site-wide family PIN (set by the admin), then a personal account login.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fingerprint = require('./fingerprint');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DIRS = {
  full: path.join(DATA_DIR, 'photos'),     // resized, metadata-stripped copies (what people see)
  thumb: path.join(DATA_DIR, 'thumbs'),     // also video poster frames
  video: path.join(DATA_DIR, 'videos'),     // converted MP4s every browser can play
  orig: path.join(DATA_DIR, 'originals'),  // untouched uploads, never served — your backup
  marked: path.join(DATA_DIR, 'marked'),   // each person's fingerprinted copies, made on first view
  tmp: path.join(DATA_DIR, 'tmp'),
};
for (const d of [DATA_DIR, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

// Video support needs ffmpeg (thumbnails + converting e.g. iPhone HEVC to H.264).
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const HAS_FFMPEG = !spawnSync(FFMPEG, ['-version']).error && !spawnSync(FFPROBE, ['-version']).error;
const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY;
const PIN_TTL = 30 * DAY;
const THEMES = ['cream', 'midnight', 'ocean', 'sage', 'blush'];

// ---------------------------------------------------------------- database

const db = new DatabaseSync(path.join(DATA_DIR, 'scrapbook.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    theme TEXT NOT NULL DEFAULT 'cream',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pin_passes (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    emoji TEXT,
    description TEXT,
    cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    date TEXT NOT NULL,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    caption TEXT,
    width INTEGER,
    height INTEGER,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS photo_access (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS likes (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, user_id)
  );
  -- who has opened which photo ('full' = opened it, 'thumb' = saw it on the board, 'video' = played it)
  CREATE TABLE IF NOT EXISTS photo_views (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    first_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_at TEXT NOT NULL DEFAULT (datetime('now')),
    times INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (photo_id, user_id, kind)
  );
  -- a tiny greyscale version of each photo, for recognising a copy found elsewhere
  CREATE TABLE IF NOT EXISTS photo_sigs (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    sig BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_photo ON comments(photo_id);
  CREATE INDEX IF NOT EXISTS photos_date ON photos(date);
  CREATE INDEX IF NOT EXISTS photos_event ON photos(event_id);
  CREATE INDEX IF NOT EXISTS events_date ON events(date);
`);

const stmts = new Map();
function stmt(sql) {
  let s = stmts.get(sql);
  if (!s) stmts.set(sql, (s = db.prepare(sql)));
  return s;
}
const get = (sql, ...p) => stmt(sql).get(...p);
const all = (sql, ...p) => stmt(sql).all(...p);
const run = (sql, ...p) => stmt(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Older databases predate private photos.
const photoColumns = all('PRAGMA table_info(photos)').map((c) => c.name);
if (!photoColumns.includes('restricted')) db.exec('ALTER TABLE photos ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0');
if (!photoColumns.includes('kind')) {
  db.exec(`ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo';
           ALTER TABLE photos ADD COLUMN duration REAL;
           ALTER TABLE photos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';`);
}

// A private (restricted) photo is visible only to its uploader and the people on its access list.
// Every query that reads photos must include this, binding $uid to the viewer's id.
const VISIBLE = `(p.restricted = 0 OR p.uploaded_by = $uid
  OR EXISTS (SELECT 1 FROM photo_access a WHERE a.photo_id = p.id AND a.user_id = $uid))`;

const getSetting = (k) => get('SELECT value FROM settings WHERE key = ?', k)?.value ?? null;
const setSetting = (k, v) =>
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
// The secret behind everyone's fingerprint pattern (see fingerprint.js). Made once and kept.
if (!getSetting('fp_secret')) setSetting('fp_secret', crypto.randomBytes(32).toString('hex'));
const FP_SECRET = getSetting('fp_secret');
const fpKey = (userId) => `user:${userId}`;
const hasUsers = () => !!get('SELECT 1 AS x FROM users LIMIT 1');
const siteInfo = () => ({ babyName: getSetting('baby_name') || 'Baby', birthDate: getSetting('birth_date') });

// ---------------------------------------------------------------- secrets

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifySecret(secret, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(String(secret), Buffer.from(salt, 'hex'), want.length);
  return crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = hashSecret('timing-equalizer');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// One-time code that must be typed on the first-run setup screen, so a stranger who
// finds the site before you do can't claim the admin account.
let setupCode = null;
function ensureSetupCode() {
  if (hasUsers()) { setupCode = null; return; }
  setupCode = process.env.SETUP_CODE || String(crypto.randomInt(100000, 1000000));
  console.log(`\n  First-time setup code: ${setupCode}\n  (Enter it on the setup screen to create the admin account.)\n`);
}

// ---------------------------------------------------------------- brute-force protection

const failures = new Map();
function lockedMinutes(key, max) {
  const f = failures.get(key);
  if (f && f.until > Date.now() && f.n >= max) return Math.ceil((f.until - Date.now()) / 60000);
  return 0;
}
function recordFailure(key, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  let f = failures.get(key);
  if (!f || f.until < now) failures.set(key, (f = { n: 0, until: now + windowMs }));
  f.n++;
}

setInterval(() => {
  const now = Date.now();
  run('DELETE FROM sessions WHERE expires_at < ?', now);
  run('DELETE FROM pin_passes WHERE expires_at < ?', now);
  for (const [k, f] of failures) if (f.until < now) failures.delete(k);
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------- helpers

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}
function setCookie(req, res, name, value, ttl) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ttl / 1000)}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function grantPinPass(req, res) {
  const t = newToken();
  run('INSERT INTO pin_passes(token, expires_at) VALUES(?, ?)', sha(t), Date.now() + PIN_TTL);
  setCookie(req, res, 'sb_pin', t, PIN_TTL);
}
function startSession(req, res, userId) {
  const t = newToken();
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)', sha(t), userId, Date.now() + SESSION_TTL);
  setCookie(req, res, 'sb_session', t, SESSION_TTL);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validPin = (p) => typeof p === 'string' && /^\d{4,12}$/.test(p);
const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const validEmail = (e) => e === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const id = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function fail(res, message, status = 400, error = 'bad') {
  return res.status(status).json({ error, message });
}
function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, email: u.email, isAdmin: !!u.is_admin, theme: u.theme };
}
const canEdit = (user, ownerId) => !!user.is_admin || (ownerId != null && ownerId === user.id);

// ---------------------------------------------------------------- app & gates

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true');

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});

// Refuse writes that come from other websites.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (host !== req.get('host')) return fail(res, 'Cross-site request blocked', 403);
  }
  next();
});

app.use(express.json({ limit: '100kb' }));

// Work out who is asking: have they passed the PIN, and are they logged in?
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const now = Date.now();
  req.pinOk = !!(cookies.sb_pin && get('SELECT 1 AS x FROM pin_passes WHERE token = ? AND expires_at > ?', sha(cookies.sb_pin), now));
  req.user = null;
  req.sessionHash = cookies.sb_session ? sha(cookies.sb_session) : null;
  if (req.pinOk && req.sessionHash) {
    req.user = get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      req.sessionHash, now,
    ) || null;
  }
  next();
});

const needPin = (req, res, next) => (req.pinOk ? next() : fail(res, 'Enter the family PIN first.', 401, 'pin'));
const needUser = (req, res, next) => {
  if (!req.pinOk) return fail(res, 'Enter the family PIN first.', 401, 'pin');
  if (!req.user) return fail(res, 'Please log in.', 401, 'login');
  next();
};
const needAdmin = (req, res, next) =>
  needUser(req, res, () => (req.user.is_admin ? next() : fail(res, 'Only the admin can do that.', 403)));

// ---------------------------------------------------------------- site version

// A short code that changes whenever the page's files change (e.g. after `git pull`).
const PUBLIC = path.join(__dirname, 'public');
const SHELL_FILES = ['index.html', 'app.js', 'styles.css'];
let buildCache = { key: '', id: '' };
function currentBuild() {
  const key = SHELL_FILES.map((f) => fs.statSync(path.join(PUBLIC, f)).mtimeMs).join('|');
  if (key !== buildCache.key) {
    const hash = crypto.createHash('sha1');
    for (const f of SHELL_FILES) hash.update(fs.readFileSync(path.join(PUBLIC, f)));
    buildCache = { key, id: hash.digest('hex').slice(0, 10) };
  }
  return buildCache.id;
}

// ---------------------------------------------------------------- live updates

// Open pages keep one Server-Sent Events connection here. When something changes we send a
// short notice ("photos added", "comments on photo 12" …) and the page re-fetches what it needs
// through the normal, permission-checked API — so a notice never carries anything private.
const listeners = new Set();
app.get('/api/live', needUser, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', build: currentBuild() })}\n\n`); // so out-of-date pages can reload
  const client = { res, uid: req.user.id };
  listeners.add(client);
  res.on('close', () => listeners.delete(client));
});
// A comment line every 25s keeps the connection open through Cloudflare and other proxies.
setInterval(() => { for (const c of listeners) c.res.write(': ping\n\n'); }, 25000).unref();

// Send a notice to everyone, or only to the user ids in `only`.
function broadcast(msg, only = null) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of listeners) if (!only || only.has(c.uid)) c.res.write(data);
}
// Who may hear about a photo: everyone (null), or for a private one, its uploader and access list.
// Each open page sends a random id with its requests (X-Tab). Notices carry it so only the page
// that made a change skips redrawing — your other devices, on the same account, still update.
const tabOf = (req) => (/^[a-z0-9]{1,16}$/.test(req.get('x-tab') || '') ? req.get('x-tab') : null);
function audience(photoId) {
  const p = get('SELECT restricted, uploaded_by FROM photos WHERE id = ?', photoId);
  if (!p || !p.restricted) return null;
  const ids = new Set(all('SELECT user_id AS id FROM photo_access WHERE photo_id = ?', photoId).map((r) => r.id));
  if (p.uploaded_by) ids.add(p.uploaded_by);
  return ids;
}

// ---------------------------------------------------------------- setup, PIN, accounts

app.get('/api/status', (req, res) => {
  res.json({
    setupNeeded: !hasUsers(),
    pinOk: req.pinOk,
    user: req.user ? publicUser(req.user) : null,
    site: req.pinOk ? siteInfo() : null,
  });
});

app.post('/api/setup', (req, res) => {
  if (hasUsers()) return fail(res, 'This scrapbook is already set up.', 409);
  const b = req.body || {};
  const key = `setup:${req.ip}`;
  const wait = lockedMinutes(key, 10);
  if (wait) return fail(res, `Too many wrong tries. Try again in ${wait} min.`, 429);
  if (String(b.setupCode || '').trim() !== setupCode) {
    recordFailure(key);
    return fail(res, 'That setup code doesn’t match the one shown in the server window.');
  }
  const username = text(b.username, 32);
  const email = text(b.email, 200);
  const birthDate = b.birthDate || '';
  if (!validUsername(username)) return fail(res, 'Username: 3–32 letters, numbers, dots, dashes or underscores.');
  if (!validPassword(b.password)) return fail(res, 'Password must be at least 8 characters.');
  if (!validPin(b.pin)) return fail(res, 'The family PIN must be 4–12 digits.');
  if (!validEmail(email)) return fail(res, 'That email doesn’t look right.');
  if (birthDate && !isDate(birthDate)) return fail(res, 'Birth date is not a valid date.');

  const userId = tx(() => {
    setSetting('pin_hash', hashSecret(b.pin));
    setSetting('baby_name', text(b.babyName, 60) || 'Baby');
    if (birthDate) setSetting('birth_date', birthDate);
    const r = run(
      'INSERT INTO users(username, display_name, email, password_hash, is_admin) VALUES(?, ?, ?, ?, 1)',
      username, text(b.displayName, 60) || username, email || null, hashSecret(b.password),
    );
    const uid = Number(r.lastInsertRowid);
    if (birthDate) {
      run('INSERT INTO events(title, date, emoji, description, created_by) VALUES(?, ?, ?, ?, ?)',
        'Welcome to the world', birthDate, '👶', 'The day it all began.', uid);
    }
    return uid;
  });
  setupCode = null;
  grantPinPass(req, res);
  startSession(req, res, userId);
  res.json({ ok: true });
});

app.post('/api/pin', (req, res) => {
  const key = `pin:${req.ip}`;
  const wait = lockedMinutes(key, 5);
  if (wait) return fail(res, `Too many wrong tries. Try again in ${wait} min.`, 429);
  const stored = getSetting('pin_hash');
  if (!stored) return fail(res, 'This scrapbook hasn’t been set up yet.');
  if (!verifySecret(String(req.body?.pin ?? ''), stored)) {
    recordFailure(key);
    return fail(res, 'That PIN isn’t right.', 401, 'badpin');
  }
  failures.delete(key);
  grantPinPass(req, res);
  res.json({ ok: true });
});

app.post('/api/register', needPin, (req, res) => {
  const b = req.body || {};
  const username = text(b.username, 32);
  const email = text(b.email, 200);
  if (!validUsername(username)) return fail(res, 'Username: 3–32 letters, numbers, dots, dashes or underscores.');
  if (!validPassword(b.password)) return fail(res, 'Password must be at least 8 characters.');
  if (!validEmail(email)) return fail(res, 'That email doesn’t look right.');
  if (get('SELECT 1 AS x FROM users WHERE username = ?', username)) return fail(res, 'That username is taken.', 409);
  const r = run(
    'INSERT INTO users(username, display_name, email, password_hash) VALUES(?, ?, ?, ?)',
    username, text(b.displayName, 60) || username, email || null, hashSecret(b.password),
  );
  startSession(req, res, Number(r.lastInsertRowid));
  res.json({ ok: true });
});

app.post('/api/login', needPin, (req, res) => {
  const username = text(req.body?.username, 32);
  const key = `login:${req.ip}:${username.toLowerCase()}`;
  const wait = lockedMinutes(key, 8);
  if (wait) return fail(res, `Too many tries. Try again in ${wait} min.`, 429);
  const user = get('SELECT * FROM users WHERE username = ?', username);
  const ok = verifySecret(String(req.body?.password ?? ''), user ? user.password_hash : DUMMY_HASH) && !!user;
  if (!ok) {
    recordFailure(key);
    return fail(res, 'Wrong username or password.', 401, 'badlogin');
  }
  failures.delete(key);
  startSession(req, res, user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionHash) run('DELETE FROM sessions WHERE token = ?', req.sessionHash);
  setCookie(req, res, 'sb_session', '', 0);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- timeline & photos

const PHOTO_SELECT = `
  SELECT p.id, p.date, p.event_id AS eventId, p.caption, p.width, p.height, p.restricted,
         p.kind, p.duration, p.status, p.uploaded_by AS uploadedBy, u.display_name AS uploaderName, p.created_at AS createdAt,
         e.title AS eventTitle, e.emoji AS eventEmoji,
         (SELECT COUNT(*) FROM comments c WHERE c.photo_id = p.id) AS commentCount,
         (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS likeCount,
         EXISTS (SELECT 1 FROM likes l WHERE l.photo_id = p.id AND l.user_id = $uid) AS liked,
         (SELECT u2.display_name FROM likes l JOIN users u2 ON u2.id = l.user_id
           WHERE l.photo_id = p.id ORDER BY l.rowid LIMIT 1) AS firstLiker
  FROM photos p
  LEFT JOIN users u ON u.id = p.uploaded_by
  LEFT JOIN events e ON e.id = p.event_id`;

app.get('/api/timeline', needUser, (req, res) => {
  const days = new Map();
  const day = (date) => {
    let d = days.get(date);
    if (!d) {
      days.set(date, (d = { date, count: 0, photoCount: 0, videoCount: 0, previews: [], eventPreviews: [], loose: [], looseCount: 0, events: [], byEvent: {} }));
    }
    return d;
  };
  // Previews for the polaroids — videos first, so one is always on top if there is one:
  //  previews       up to 3 of the day's photos (stacks when zoomed out)
  //  eventPreviews  up to 3 photos that belong to an event (the tidy stack on the Days view)
  //  loose          up to 7 photos with no event (scattered around the day on the Days view)
  const rows = all(`SELECT p.id, p.date, p.kind, p.duration, p.caption, p.event_id AS eventId FROM photos p WHERE ${VISIBLE}
                    ORDER BY p.date, (p.kind = 'video') DESC, p.id`, { uid: req.user.id });
  for (const p of rows) {
    const d = day(p.date);
    const preview = { id: p.id, kind: p.kind, duration: p.duration, caption: p.caption };
    d.count++;
    if (p.kind === 'video') d.videoCount++; else d.photoCount++;
    if (d.previews.length < 3) d.previews.push(preview);
    if (p.eventId) {
      if (d.eventPreviews.length < 3) d.eventPreviews.push(preview);
      // each event's own stack, for days with more than one event
      const be = (d.byEvent[p.eventId] ||= { eventId: p.eventId, previews: [], photoCount: 0, videoCount: 0 });
      if (be.previews.length < 3) be.previews.push(preview);
      if (p.kind === 'video') be.videoCount++; else be.photoCount++;
    } else {
      d.looseCount++;
      if (d.loose.length < 7) d.loose.push(preview);
    }
  }
  for (const e of all('SELECT id, title, date, emoji FROM events ORDER BY date, id')) day(e.date).events.push(e);
  for (const d of days.values()) {
    d.byEvent = d.events.map((e) => d.byEvent[e.id]).filter(Boolean); // in event order; only events with photos
  }
  res.json({ site: siteInfo(), days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) });
});

app.get('/api/photos', needUser, (req, res) => {
  if (!isDate(req.query.date)) return fail(res, 'Pick a date.');
  res.json(all(`${PHOTO_SELECT} WHERE p.date = $date AND ${VISIBLE} ORDER BY p.id`, { date: req.query.date, uid: req.user.id }));
});

// Everyone's names, for choosing who can see a private photo.
app.get('/api/members', needUser, (req, res) => {
  res.json(all('SELECT id, display_name AS displayName FROM users ORDER BY display_name COLLATE NOCASE'));
});

// The photo as this viewer is allowed to see it, or undefined.
const visiblePhoto = (photoId, user) =>
  get(`SELECT p.* FROM photos p WHERE p.id = $id AND ${VISIBLE}`, { id: photoId, uid: user.id });

// Turns "3,7" or [3, 7] into ids of real members, leaving out the uploader (who always has access).
function readAllowed(value, uploaderId) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const ids = [...new Set(list.map(id).filter(Boolean))].filter((u) => u !== uploaderId);
  return ids.filter((u) => get('SELECT 1 AS x FROM users WHERE id = ?', u));
}
function setAccess(photoId, restricted, allowed) {
  run('UPDATE photos SET restricted = ? WHERE id = ?', restricted ? 1 : 0, photoId);
  run('DELETE FROM photo_access WHERE photo_id = ?', photoId);
  if (restricted) for (const u of allowed) run('INSERT INTO photo_access(photo_id, user_id) VALUES(?, ?)', photoId, u);
}

const upload = multer({
  dest: DIRS.tmp,
  limits: { fileSize: MAX_VIDEO_BYTES, files: 20 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

// ---- video helpers

function runTool(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim().split('\n').pop()}`))));
  });
}

async function probeDuration(file) {
  const out = await runTool(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file]);
  return Number(JSON.parse(out).format?.duration) || null;
}

// Grab a frame for the polaroid/thumbnail, saved exactly like a photo so /media/thumb and /media/full work.
async function makePoster(file, name, duration) {
  const frame = path.join(DIRS.tmp, `${name}-poster.jpg`);
  const at = duration ? Math.min(1, duration / 2) : 0;
  await runTool(FFMPEG, ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-q:v', '3', frame]);
  try {
    const info = await sharp(frame).resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(DIRS.full, `${name}.jpg`));
    await sharp(frame).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 }).toFile(path.join(DIRS.thumb, `${name}.webp`));
    return info;
  } finally {
    fs.rm(frame, { force: true }, () => {});
  }
}

// Converts to H.264/AAC MP4 (plays everywhere, streams from the start), max 1080p, and strips
// metadata such as GPS location. One at a time so the server stays responsive.
let videoQueue = Promise.resolve();
function queueConversion(photoId) {
  videoQueue = videoQueue.then(async () => {
    const v = get('SELECT id, file FROM photos WHERE id = ?', photoId);
    if (!v) return;
    const src = fs.readdirSync(DIRS.orig).find((f) => f.startsWith(v.file));
    const out = path.join(DIRS.video, `${v.file}.mp4`);
    const partial = `${out}.part.mp4`;
    try {
      await runTool(FFMPEG, [
        '-v', 'error', '-y', '-i', path.join(DIRS.orig, src),
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
        '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', partial,
      ]);
      await fs.promises.rename(partial, out);
      run("UPDATE photos SET status = 'ready' WHERE id = ?", v.id);
    } catch (err) {
      console.warn(`Could not convert video ${v.id}:`, err.message);
      fs.rm(partial, { force: true }, () => {});
      run("UPDATE photos SET status = 'failed' WHERE id = ?", v.id);
    }
    broadcast({ type: 'photo', id: v.id }, audience(v.id)); // "Converting…" → playable
  });
}
// Pick up conversions interrupted by a restart.
for (const v of all("SELECT id FROM photos WHERE kind = 'video' AND status = 'processing'")) queueConversion(v.id);

app.post('/api/photos', needUser, upload.array('photos', 20), async (req, res) => {
  const files = req.files || [];
  const discard = (f) => fs.rm(f.path, { force: true }, () => {});
  let date = req.body.date;
  const eventId = id(req.body.eventId);
  if (eventId) {
    const ev = get('SELECT date FROM events WHERE id = ?', eventId);
    if (!ev) { files.forEach(discard); return fail(res, 'That event no longer exists.'); }
    date = ev.date; // photos in an event always live on the event's day
  }
  if (!isDate(date)) { files.forEach(discard); return fail(res, 'Pick a date for these photos.'); }
  if (!files.length) return fail(res, 'Choose at least one photo or video.');

  const caption = text(req.body.caption, 500) || null;
  const restricted = req.body.restricted === '1';
  const allowed = restricted ? readAllowed(req.body.allowed, req.user.id) : [];
  const insert = (name, info, kind, duration) => tx(() => {
    const r = run(
      `INSERT INTO photos(file, date, event_id, caption, width, height, uploaded_by, kind, duration, status)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, date, eventId, caption, info.width, info.height, req.user.id, kind, duration,
      kind === 'video' ? 'processing' : 'ready',
    );
    const pid = Number(r.lastInsertRowid);
    if (restricted) setAccess(pid, true, allowed);
    return pid;
  });

  const saved = [];
  const failed = [];
  for (const f of files) {
    const name = crypto.randomBytes(12).toString('hex');
    const ext = path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const isVideo = f.mimetype.startsWith('video/');
    try {
      if (isVideo) {
        if (!HAS_FFMPEG) throw Object.assign(new Error('no ffmpeg'), { reason: 'videos need ffmpeg installed on the server' });
        const orig = path.join(DIRS.orig, name + ext);
        await fs.promises.rename(f.path, orig);
        const duration = await probeDuration(orig);
        const info = await makePoster(orig, name, duration);
        const vid = insert(name, info, 'video', duration);
        saveSignature(vid, name);
        queueConversion(vid);
        saved.push(vid);
      } else {
        if (f.size > MAX_PHOTO_BYTES) throw Object.assign(new Error('too big'), { reason: 'over 40 MB' });
        // .rotate() applies the phone's orientation; sharp drops EXIF (incl. GPS location) from outputs.
        const info = await sharp(f.path, { failOn: 'none' }).rotate()
          .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 86, mozjpeg: true })
          .toFile(path.join(DIRS.full, `${name}.jpg`));
        await sharp(f.path, { failOn: 'none' }).rotate()
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(path.join(DIRS.thumb, `${name}.webp`));
        await fs.promises.rename(f.path, path.join(DIRS.orig, name + ext));
        const pid = insert(name, info, 'photo', null);
        saveSignature(pid, name);
        saved.push(pid);
      }
    } catch (err) {
      console.warn(`Could not process ${f.originalname}:`, err.message);
      failed.push(err.reason ? `${f.originalname} (${err.reason})` : f.originalname);
      discard(f);
      fs.rm(path.join(DIRS.orig, name + ext), { force: true }, () => {});
      fs.rm(path.join(DIRS.full, `${name}.jpg`), { force: true }, () => {});
      fs.rm(path.join(DIRS.thumb, `${name}.webp`), { force: true }, () => {});
    }
  }
  if (saved.length) {
    broadcast({ type: 'photos', count: saved.length, date, eventId, by: req.user.display_name, from: req.user.id, tab: tabOf(req) },
      restricted ? new Set([req.user.id, ...allowed]) : null);
  }
  res.json({ saved, failed });
});

app.get('/api/photos/:id/access', needUser, (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return fail(res, 'Photo not found.', 404);
  if (!canEdit(req.user, photo.uploaded_by)) return fail(res, 'Only the person who added this photo can see who it’s shared with.', 403);
  res.json({
    restricted: !!photo.restricted,
    userIds: all('SELECT user_id AS id FROM photo_access WHERE photo_id = ?', photo.id).map((r) => r.id),
    uploadedBy: photo.uploaded_by,
  });
});

app.patch('/api/photos/:id', needUser, (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return fail(res, 'Photo not found.', 404);
  if (!canEdit(req.user, photo.uploaded_by)) return fail(res, 'You can only change photos you added.', 403);
  const b = req.body || {};
  let { date, event_id: eventId, caption } = photo;
  if ('caption' in b) caption = text(b.caption, 500) || null;
  if ('eventId' in b) {
    eventId = b.eventId == null ? null : id(b.eventId);
    if (eventId) {
      const ev = get('SELECT date FROM events WHERE id = ?', eventId);
      if (!ev) return fail(res, 'That event no longer exists.');
      date = ev.date;
    }
  }
  if ('date' in b && !eventId) {
    if (!isDate(b.date)) return fail(res, 'That date isn’t valid.');
    date = b.date;
  }
  const before = audience(photo.id);
  tx(() => {
    if (eventId !== photo.event_id) run('UPDATE events SET cover_photo_id = NULL WHERE cover_photo_id = ?', photo.id);
    run('UPDATE photos SET date = ?, event_id = ?, caption = ? WHERE id = ?', date, eventId, caption, photo.id);
    if ('restricted' in b) {
      const restricted = !!b.restricted;
      setAccess(photo.id, restricted, restricted ? readAllowed(b.allowedUserIds, photo.uploaded_by) : []);
    }
  });
  // tell everyone who could see it before or can see it now (so it appears or disappears for them)
  const after = audience(photo.id);
  broadcast({ type: 'photo', id: photo.id }, before && after ? new Set([...before, ...after]) : null);
  res.json(get(`${PHOTO_SELECT} WHERE p.id = $id`, { id: photo.id, uid: req.user.id }));
});

// ---- comments & hearts (only for people who can see the photo)

const COMMENT_SELECT = `
  SELECT c.id, c.body, c.created_at AS createdAt, c.user_id AS userId, u.display_name AS userName
  FROM comments c LEFT JOIN users u ON u.id = c.user_id`;

app.get('/api/photos/:id/comments', needUser, (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return fail(res, 'Photo not found.', 404);
  res.json({
    comments: all(`${COMMENT_SELECT} WHERE c.photo_id = ? ORDER BY c.id`, photo.id)
      .map((c) => ({ ...c, canDelete: canEdit(req.user, c.userId) })),
    likedBy: likedBy(photo.id),
    liked: !!get('SELECT 1 AS x FROM likes WHERE photo_id = ? AND user_id = ?', photo.id, req.user.id),
  });
});
const likedBy = (photoId) => all(
  'SELECT u.display_name AS name FROM likes l JOIN users u ON u.id = l.user_id WHERE l.photo_id = ? ORDER BY l.rowid', photoId,
).map((r) => r.name);

app.post('/api/photos/:id/comments', needUser, (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return fail(res, 'Photo not found.', 404);
  const body = text(req.body?.body, 1000);
  if (!body) return fail(res, 'Write something first.');
  const r = run('INSERT INTO comments(photo_id, user_id, body) VALUES(?, ?, ?)', photo.id, req.user.id, body);
  broadcast({ type: 'social', id: photo.id, from: req.user.id, tab: tabOf(req) }, audience(photo.id));
  res.json({ ...get(`${COMMENT_SELECT} WHERE c.id = ?`, Number(r.lastInsertRowid)), canDelete: true });
});

app.delete('/api/comments/:id', needUser, (req, res) => {
  const c = get('SELECT * FROM comments WHERE id = ?', id(req.params.id));
  if (!c || !visiblePhoto(c.photo_id, req.user)) return fail(res, 'Comment not found.', 404);
  if (!canEdit(req.user, c.user_id)) return fail(res, 'You can only delete your own comments.', 403);
  run('DELETE FROM comments WHERE id = ?', c.id);
  broadcast({ type: 'social', id: c.photo_id, from: req.user.id, tab: tabOf(req) }, audience(c.photo_id));
  res.json({ ok: true });
});

app.put('/api/photos/:id/like', needUser, (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return fail(res, 'Photo not found.', 404);
  if (req.body?.liked) run('INSERT OR IGNORE INTO likes(photo_id, user_id) VALUES(?, ?)', photo.id, req.user.id);
  else run('DELETE FROM likes WHERE photo_id = ? AND user_id = ?', photo.id, req.user.id);
  const names = likedBy(photo.id);
  broadcast({ type: 'social', id: photo.id, from: req.user.id, tab: tabOf(req) }, audience(photo.id));
  res.json({ liked: !!req.body?.liked, likeCount: names.length, likedBy: names, firstLiker: names[0] || null });
});

// Removes a photo or video everywhere: database row (comments, hearts and access go with it) and every file.
async function deletePhoto(photo) {
  const who = audience(photo.id);
  run('DELETE FROM photos WHERE id = ?', photo.id);
  broadcast({ type: 'photo', id: photo.id, removed: true }, who);
  await fs.promises.rm(path.join(DIRS.full, `${photo.file}.jpg`), { force: true });
  await fs.promises.rm(path.join(DIRS.thumb, `${photo.file}.webp`), { force: true });
  await fs.promises.rm(path.join(DIRS.video, `${photo.file}.mp4`), { force: true });
  await fs.promises.rm(path.join(DIRS.marked, photo.file), { recursive: true, force: true });
  for (const f of await fs.promises.readdir(DIRS.orig)) {
    if (f.startsWith(photo.file)) await fs.promises.rm(path.join(DIRS.orig, f), { force: true });
  }
}

app.delete('/api/photos/:id', needUser, async (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return fail(res, 'Photo not found.', 404);
  if (!canEdit(req.user, photo.uploaded_by)) return fail(res, 'You can only delete photos you added.', 403);
  await deletePhoto(photo);
  res.json({ ok: true });
});

// ---- fingerprints

// The viewer's own copy of a photo: made the first time they open it, then kept.
const making = new Map();
async function markedCopy(photo, kind, userId) {
  const clean = kind === 'thumb' ? path.join(DIRS.thumb, `${photo.file}.webp`) : path.join(DIRS.full, `${photo.file}.jpg`);
  const out = path.join(DIRS.marked, photo.file, `${kind}-${userId}${kind === 'thumb' ? '.webp' : '.jpg'}`);
  if (fs.existsSync(out)) return out;
  if (!making.has(out)) {
    making.set(out, (async () => {
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      await fingerprint.stamp(clean, fingerprint.patternFor(FP_SECRET, fpKey(userId)), out);
    })().finally(() => making.delete(out)));
  }
  await making.get(out);
  return out;
}

// Remembers who opened what. Seeing the same thing again within 10 minutes isn't counted again.
const recentViews = new Map();
function noteView(photoId, userId, kind) {
  const key = `${photoId}:${userId}:${kind}`;
  const now = Date.now();
  if (now - (recentViews.get(key) || 0) < 10 * 60 * 1000) return;
  recentViews.set(key, now);
  if (recentViews.size > 50000) recentViews.clear();
  run(`INSERT INTO photo_views(photo_id, user_id, kind) VALUES(?, ?, ?)
       ON CONFLICT(photo_id, user_id, kind) DO UPDATE SET last_at = datetime('now'), times = times + 1`, photoId, userId, kind);
}

async function saveSignature(photoId, file) {
  try {
    const sig = await fingerprint.signature(path.join(DIRS.thumb, `${file}.webp`));
    run('INSERT OR REPLACE INTO photo_sigs(photo_id, sig) VALUES(?, ?)', photoId, sig);
  } catch (err) {
    console.warn(`Could not read photo ${photoId} for matching:`, err.message);
  }
}
// Photos added before fingerprints existed: fill their signatures in quietly after startup.
setTimeout(async () => {
  for (const p of all('SELECT id, file FROM photos WHERE id NOT IN (SELECT photo_id FROM photo_sigs)')) await saveSignature(p.id, p.file);
}, 2000);

// "Who shared this?" — the admin adds a copy of one of our photos found elsewhere (and, for a
// screenshot, the part of it that shows the photo). We work out which photo it is, then whose
// fingerprint is in it, and list who has opened that photo.
const traceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
app.post('/api/admin/trace', needAdmin, traceUpload.single('image'), async (req, res) => {
  if (!req.file) return fail(res, 'Choose the picture you found.');
  let crop = { x: 0, y: 0, w: 1, h: 1 };
  try {
    const c = JSON.parse(req.body.crop || 'null');
    if (c && [c.x, c.y, c.w, c.h].every((v) => Number.isFinite(v)) && c.w > 0.05 && c.h > 0.05) {
      const x = Math.min(0.95, Math.max(0, c.x)), y = Math.min(0.95, Math.max(0, c.y));
      crop = { x, y, w: Math.min(1 - x, c.w), h: Math.min(1 - y, c.h) };
    }
  } catch { /* use the whole picture */ }
  let found;
  try {
    const meta = await sharp(req.file.buffer, { failOn: 'none' }).rotate().metadata();
    const turned = (meta.orientation || 1) >= 5;
    const W = turned ? meta.height : meta.width, H = turned ? meta.width : meta.height;
    found = await sharp(req.file.buffer, { failOn: 'none' }).rotate()
      .extract({ left: Math.round(crop.x * W), top: Math.round(crop.y * H), width: Math.max(1, Math.round(crop.w * W)), height: Math.max(1, Math.round(crop.h * H)) })
      .toBuffer();
  } catch {
    return fail(res, 'That file doesn’t look like a picture.');
  }

  // Which of our photos is it? The closest few by their tiny versions, then whichever lines up best.
  const sig = await fingerprint.signature(found);
  const ranked = all('SELECT photo_id AS id, sig FROM photo_sigs')
    .map((r) => ({ id: r.id, score: fingerprint.ncc(sig, r.sig) }))
    .sort((a, b) => b.score - a.score).slice(0, 3)
    .filter((r) => r.score > 0.5);
  const users = all('SELECT id, display_name AS name FROM users');
  let best = null;
  for (const r of ranked) {
    const photo = get('SELECT * FROM photos WHERE id = ?', r.id);
    if (!photo) continue;
    const result = await fingerprint.check(req.file.buffer, crop, path.join(DIRS.full, `${photo.file}.jpg`),
      users.map((u) => ({ key: fpKey(u.id), id: u.id, name: u.name })), FP_SECRET);
    if (!best || result.lineUp > best.result.lineUp) best = { photo, result };
    if (result.lineUp > 0.97) break;
  }
  if (!best || best.result.lineUp < 0.8) return res.json({ found: false });

  const { photo, result } = best;
  const canSee = audience(photo.id); // null = everyone
  const views = all(`SELECT v.user_id AS userId, u.display_name AS name, v.kind, v.first_at AS firstAt, v.last_at AS lastAt, v.times
    FROM photo_views v JOIN users u ON u.id = v.user_id WHERE v.photo_id = ? ORDER BY v.last_at DESC`, photo.id);
  res.json({
    found: true,
    photo: {
      id: photo.id, date: photo.date, caption: photo.caption, kind: photo.kind,
      uploadedBy: get('SELECT display_name AS n FROM users WHERE id = ?', photo.uploaded_by)?.n || null,
    },
    lineUp: result.lineUp,
    coverage: result.coverage,
    people: result.scores.map((p) => ({ id: p.id, name: p.name, score: Math.round(p.score * 10) / 10, canSee: !canSee || canSee.has(p.id) })),
    views,
  });
});

// Images and videos are only ever served to people who passed both locks.
// (For a video, "full" and "thumb" are its poster frame.)
// Photos (and video poster frames) go out as the viewer's own fingerprinted copy.
app.get('/media/:kind/:id', needUser, async (req, res) => {
  const photo = visiblePhoto(id(req.params.id), req.user);
  if (!photo) return res.sendStatus(404);
  let file;
  let download = `photo-${photo.id}.jpg`;
  if (req.params.kind === 'thumb' || req.params.kind === 'full') {
    try {
      file = await markedCopy(photo, req.params.kind, req.user.id);
    } catch (err) {
      console.warn(`Could not fingerprint photo ${photo.id}:`, err.message);
      return res.sendStatus(500);
    }
  } else if (req.params.kind === 'video' && photo.kind === 'video' && photo.status === 'ready') {
    file = path.join(DIRS.video, `${photo.file}.mp4`);
    download = `video-${photo.id}.mp4`;
  } else return res.sendStatus(404);
  // no-cache: browsers keep a copy but must re-ask (cheaply, via ETag) each time, so a photo made
  // private — or a shared device where someone else logs in — never shows from cache.
  res.set('Cache-Control', 'private, no-cache');
  noteView(photo.id, req.user.id, req.params.kind);
  if (req.query.download) res.attachment(download);
  res.sendFile(file); // handles Range requests, so videos can seek and stream
});

// ---------------------------------------------------------------- events

const EVENT_LIST = `
  SELECT e.id, e.title, e.date, e.emoji,
         COALESCE(
           (SELECT p.id FROM photos p WHERE p.id = e.cover_photo_id AND ${VISIBLE}),
           (SELECT p.id FROM photos p WHERE p.event_id = e.id AND ${VISIBLE} ORDER BY p.id LIMIT 1)
         ) AS coverId,
         (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id AND ${VISIBLE}) AS count
  FROM events e`;

app.get('/api/events', needUser, (req, res) => {
  res.json(all(`${EVENT_LIST} ORDER BY e.date, e.id`, { uid: req.user.id }));
});

app.get('/api/events/:id', needUser, (req, res) => {
  const ev = get(
    `SELECT e.id, e.title, e.date, e.emoji, e.description, e.cover_photo_id AS coverId,
            e.created_by AS createdBy, u.display_name AS creatorName
     FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`,
    id(req.params.id),
  );
  if (!ev) return fail(res, 'Event not found.', 404);
  ev.canEdit = canEdit(req.user, ev.createdBy);
  res.json({ event: ev, photos: all(`${PHOTO_SELECT} WHERE p.event_id = $eid AND ${VISIBLE} ORDER BY p.id`, { eid: ev.id, uid: req.user.id }) });
});

function readEvent(b, current = {}) {
  const title = 'title' in b ? text(b.title, 80) : current.title;
  const date = 'date' in b ? b.date : current.date;
  if (!title) return { error: 'Give the event a title.' };
  if (!isDate(date)) return { error: 'Pick a date for the event.' };
  return {
    title,
    date,
    emoji: 'emoji' in b ? text(b.emoji, 8) || null : current.emoji ?? null,
    description: 'description' in b ? text(b.description, 1000) || null : current.description ?? null,
  };
}

app.post('/api/events', needUser, (req, res) => {
  const ev = readEvent(req.body || {});
  if (ev.error) return fail(res, ev.error);
  const r = run('INSERT INTO events(title, date, emoji, description, created_by) VALUES(?, ?, ?, ?, ?)',
    ev.title, ev.date, ev.emoji, ev.description, req.user.id);
  broadcast({ type: 'events', from: req.user.id, tab: tabOf(req) });
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/events/:id', needUser, (req, res) => {
  const current = get('SELECT * FROM events WHERE id = ?', id(req.params.id));
  if (!current) return fail(res, 'Event not found.', 404);
  if (!canEdit(req.user, current.created_by)) return fail(res, 'Only the person who made this event (or the admin) can change it.', 403);
  const b = req.body || {};
  const ev = readEvent(b, current);
  if (ev.error) return fail(res, ev.error);
  let cover = current.cover_photo_id;
  if ('coverId' in b) {
    cover = b.coverId == null ? null : id(b.coverId);
    const photo = cover && visiblePhoto(cover, req.user);
    if (cover && (!photo || photo.event_id !== current.id)) return fail(res, 'That photo isn’t in this event.');
  }
  tx(() => {
    run('UPDATE events SET title = ?, date = ?, emoji = ?, description = ?, cover_photo_id = ? WHERE id = ?',
      ev.title, ev.date, ev.emoji, ev.description, cover, current.id);
    run('UPDATE photos SET date = ? WHERE event_id = ?', ev.date, current.id);
  });
  broadcast({ type: 'events', from: req.user.id, tab: tabOf(req) });
  res.json({ ok: true });
});

app.delete('/api/events/:id', needUser, (req, res) => {
  const current = get('SELECT * FROM events WHERE id = ?', id(req.params.id));
  if (!current) return fail(res, 'Event not found.', 404);
  if (!canEdit(req.user, current.created_by)) return fail(res, 'Only the person who made this event (or the admin) can delete it.', 403);
  run('DELETE FROM events WHERE id = ?', current.id); // its photos stay on the timeline, just without the event
  broadcast({ type: 'events', from: req.user.id, tab: tabOf(req) });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- my settings

app.patch('/api/me', needUser, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const displayName = 'displayName' in b ? text(b.displayName, 60) : u.display_name;
  const email = 'email' in b ? text(b.email, 200) : u.email || '';
  const theme = 'theme' in b ? b.theme : u.theme;
  if (!displayName) return fail(res, 'Your name can’t be empty.');
  if (!validEmail(email)) return fail(res, 'That email doesn’t look right.');
  if (!THEMES.includes(theme)) return fail(res, 'Unknown theme.');
  run('UPDATE users SET display_name = ?, email = ?, theme = ? WHERE id = ?', displayName, email || null, theme, u.id);
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', u.id)));
});

app.post('/api/me/password', needUser, (req, res) => {
  const b = req.body || {};
  if (!verifySecret(String(b.current ?? ''), req.user.password_hash)) return fail(res, 'Your current password isn’t right.');
  if (!validPassword(b.next)) return fail(res, 'New password must be at least 8 characters.');
  tx(() => {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(b.next), req.user.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user.id, req.sessionHash); // sign out other devices
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin

app.patch('/api/admin/site', needAdmin, (req, res) => {
  const b = req.body || {};
  if ('birthDate' in b && b.birthDate && !isDate(b.birthDate)) return fail(res, 'Birth date is not a valid date.');
  if ('babyName' in b) setSetting('baby_name', text(b.babyName, 60) || 'Baby');
  if ('birthDate' in b) {
    if (b.birthDate) setSetting('birth_date', b.birthDate);
    else run("DELETE FROM settings WHERE key = 'birth_date'");
  }
  res.json(siteInfo());
});

app.post('/api/admin/pin', needAdmin, (req, res) => {
  const b = req.body || {};
  if (!verifySecret(String(b.password ?? ''), req.user.password_hash)) return fail(res, 'Your password isn’t right.');
  if (!validPin(b.pin)) return fail(res, 'The PIN must be 4–12 digits.');
  tx(() => {
    setSetting('pin_hash', hashSecret(b.pin));
    run('DELETE FROM pin_passes'); // everyone has to enter the new PIN
  });
  grantPinPass(req, res);
  res.json({ ok: true });
});

// Manage photos: every photo/video the admin can see, newest date first, 60 at a time.
// `after` is the last item's "date|id" from the previous page.
app.get('/api/admin/photos', needAdmin, (req, res) => {
  const [d, i] = String(req.query.after || '').split('|');
  const cursor = isDate(d) && id(i) ? { d, i: id(i) } : null;
  const rows = all(
    `${PHOTO_SELECT} WHERE ${VISIBLE} ${cursor ? 'AND (p.date < $d OR (p.date = $d AND p.id < $i))' : ''}
     ORDER BY p.date DESC, p.id DESC LIMIT 60`,
    { uid: req.user.id, ...(cursor || {}) },
  );
  res.json({
    photos: rows,
    total: get(`SELECT COUNT(*) AS n FROM photos p WHERE ${VISIBLE}`, { uid: req.user.id }).n,
    next: rows.length === 60 ? `${rows[59].date}|${rows[59].id}` : null,
  });
});

// Delete many at once (only ones the admin can see).
app.post('/api/admin/photos/delete', needAdmin, async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(id).filter(Boolean))].slice(0, 500);
  let deleted = 0;
  for (const pid of ids) {
    const photo = visiblePhoto(pid, req.user);
    if (!photo) continue;
    await deletePhoto(photo);
    deleted++;
  }
  res.json({ deleted });
});

app.get('/api/admin/users', needAdmin, (req, res) => {
  res.json(all(`
    SELECT u.id, u.username, u.display_name AS displayName, u.email, u.is_admin AS isAdmin, u.created_at AS createdAt,
           (SELECT COUNT(*) FROM photos WHERE uploaded_by = u.id) AS photoCount
    FROM users u ORDER BY u.created_at`).map((u) => ({ ...u, isAdmin: !!u.isAdmin })));
});

app.patch('/api/admin/users/:id', needAdmin, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', id(req.params.id));
  if (!target) return fail(res, 'Member not found.', 404);
  if ('isAdmin' in (req.body || {})) {
    const makeAdmin = !!req.body.isAdmin;
    if (!makeAdmin && target.id === req.user.id) return fail(res, 'You can’t remove your own admin access.');
    run('UPDATE users SET is_admin = ? WHERE id = ?', makeAdmin ? 1 : 0, target.id);
  }
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', needAdmin, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', id(req.params.id));
  if (!target) return fail(res, 'Member not found.', 404);
  const temp = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
  tx(() => {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(temp), target.id);
    run('DELETE FROM sessions WHERE user_id = ?', target.id);
  });
  res.json({ tempPassword: temp });
});

app.delete('/api/admin/users/:id', needAdmin, (req, res) => {
  const target = get('SELECT * FROM users WHERE id = ?', id(req.params.id));
  if (!target) return fail(res, 'Member not found.', 404);
  if (target.id === req.user.id) return fail(res, 'You can’t remove your own account.');
  run('DELETE FROM users WHERE id = ?', target.id); // their photos stay; sessions go with them
  res.json({ ok: true });
});

// ---------------------------------------------------------------- static app & errors

// The page itself is always served fresh, with its script and stylesheet addresses stamped with the
// current version — so phones (including home-screen shortcuts, which keep their own cache) never
// run old code. Open pages compare versions when they connect and reload themselves if they're behind.
app.get(['/', '/index.html'], (req, res) => {
  const build = currentBuild();
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${build}"`)
    .replace('src="app.js"', `src="app.js?v=${build}"`)
    .replace('</head>', `  <meta name="build" content="${build}">\n</head>`);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
});
app.use(express.static(PUBLIC, { index: false }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is over 2 GB.' : `Upload problem: ${err.message}`;
    return fail(res, msg, 400);
  }
  console.error(err);
  if (res.headersSent) return next(err);
  fail(res, 'Something went wrong on the server.', 500);
});

ensureSetupCode();
if (!HAS_FFMPEG) console.log('  Note: ffmpeg not found, so video uploads are turned off. Install ffmpeg to enable them.\n');
app.listen(PORT, () => console.log(`  Family Scrapbook running at http://localhost:${PORT}\n`));
