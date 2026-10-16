'use strict';

// Family Scrapbook — a private, PIN-locked photo timeline.
// Two locks: a site-wide family PIN (set by the admin), then a personal account login.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DIRS = {
  full: path.join(DATA_DIR, 'photos'),     // resized, metadata-stripped copies (what people see)
  thumb: path.join(DATA_DIR, 'thumbs'),
  orig: path.join(DATA_DIR, 'originals'),  // untouched uploads, never served — your backup
  tmp: path.join(DATA_DIR, 'tmp'),
};
for (const d of [DATA_DIR, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

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

const getSetting = (k) => get('SELECT value FROM settings WHERE key = ?', k)?.value ?? null;
const setSetting = (k, v) =>
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
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
  SELECT p.id, p.date, p.event_id AS eventId, p.caption, p.width, p.height,
         p.uploaded_by AS uploadedBy, u.display_name AS uploaderName, p.created_at AS createdAt,
         e.title AS eventTitle, e.emoji AS eventEmoji
  FROM photos p
  LEFT JOIN users u ON u.id = p.uploaded_by
  LEFT JOIN events e ON e.id = p.event_id`;

app.get('/api/timeline', needUser, (req, res) => {
  const days = new Map();
  const day = (date) => {
    let d = days.get(date);
    if (!d) days.set(date, (d = { date, count: 0, photos: [], events: [] }));
    return d;
  };
  for (const p of all('SELECT id, date FROM photos ORDER BY date, id')) {
    const d = day(p.date);
    d.count++;
    if (d.photos.length < 3) d.photos.push(p.id);
  }
  for (const e of all('SELECT id, title, date, emoji FROM events ORDER BY date, id')) day(e.date).events.push(e);
  res.json({ site: siteInfo(), days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) });
});

app.get('/api/photos', needUser, (req, res) => {
  if (!isDate(req.query.date)) return fail(res, 'Pick a date.');
  res.json(all(`${PHOTO_SELECT} WHERE p.date = ? ORDER BY p.id`, req.query.date));
});

const upload = multer({
  dest: DIRS.tmp,
  limits: { fileSize: 40 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

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
  if (!files.length) return fail(res, 'Choose at least one photo.');

  const caption = text(req.body.caption, 500) || null;
  const saved = [];
  const failed = [];
  for (const f of files) {
    const name = crypto.randomBytes(12).toString('hex');
    try {
      // .rotate() applies the phone's orientation; sharp drops EXIF (incl. GPS location) from outputs.
      const info = await sharp(f.path, { failOn: 'none' }).rotate()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86, mozjpeg: true })
        .toFile(path.join(DIRS.full, `${name}.jpg`));
      await sharp(f.path, { failOn: 'none' }).rotate()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(path.join(DIRS.thumb, `${name}.webp`));
      const ext = path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      await fs.promises.rename(f.path, path.join(DIRS.orig, name + ext));
      const r = run(
        'INSERT INTO photos(file, date, event_id, caption, width, height, uploaded_by) VALUES(?, ?, ?, ?, ?, ?, ?)',
        name, date, eventId, caption, info.width, info.height, req.user.id,
      );
      saved.push(Number(r.lastInsertRowid));
    } catch (err) {
      console.warn(`Could not process ${f.originalname}:`, err.message);
      failed.push(f.originalname);
      discard(f);
      fs.rm(path.join(DIRS.full, `${name}.jpg`), { force: true }, () => {});
      fs.rm(path.join(DIRS.thumb, `${name}.webp`), { force: true }, () => {});
    }
  }
  res.json({ saved, failed });
});

app.patch('/api/photos/:id', needUser, (req, res) => {
  const photo = get('SELECT * FROM photos WHERE id = ?', id(req.params.id));
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
  tx(() => {
    if (eventId !== photo.event_id) run('UPDATE events SET cover_photo_id = NULL WHERE cover_photo_id = ?', photo.id);
    run('UPDATE photos SET date = ?, event_id = ?, caption = ? WHERE id = ?', date, eventId, caption, photo.id);
  });
  res.json(get(`${PHOTO_SELECT} WHERE p.id = ?`, photo.id));
});

app.delete('/api/photos/:id', needUser, async (req, res) => {
  const photo = get('SELECT * FROM photos WHERE id = ?', id(req.params.id));
  if (!photo) return fail(res, 'Photo not found.', 404);
  if (!canEdit(req.user, photo.uploaded_by)) return fail(res, 'You can only delete photos you added.', 403);
  run('DELETE FROM photos WHERE id = ?', photo.id);
  await fs.promises.rm(path.join(DIRS.full, `${photo.file}.jpg`), { force: true });
  await fs.promises.rm(path.join(DIRS.thumb, `${photo.file}.webp`), { force: true });
  for (const f of await fs.promises.readdir(DIRS.orig)) {
    if (f.startsWith(photo.file)) await fs.promises.rm(path.join(DIRS.orig, f), { force: true });
  }
  res.json({ ok: true });
});

// Images are only ever served to people who passed both locks.
app.get('/media/:kind/:id', needUser, (req, res) => {
  const photo = get('SELECT id, file FROM photos WHERE id = ?', id(req.params.id));
  if (!photo) return res.sendStatus(404);
  let file;
  if (req.params.kind === 'thumb') file = path.join(DIRS.thumb, `${photo.file}.webp`);
  else if (req.params.kind === 'full') file = path.join(DIRS.full, `${photo.file}.jpg`);
  else return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (req.query.download) res.attachment(`photo-${photo.id}.jpg`);
  res.sendFile(file);
});

// ---------------------------------------------------------------- events

const EVENT_LIST = `
  SELECT e.id, e.title, e.date, e.emoji,
         COALESCE(e.cover_photo_id, (SELECT id FROM photos WHERE event_id = e.id ORDER BY id LIMIT 1)) AS coverId,
         (SELECT COUNT(*) FROM photos WHERE event_id = e.id) AS count
  FROM events e`;

app.get('/api/events', needUser, (req, res) => {
  res.json(all(`${EVENT_LIST} ORDER BY e.date, e.id`));
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
  res.json({ event: ev, photos: all(`${PHOTO_SELECT} WHERE p.event_id = ? ORDER BY p.id`, ev.id) });
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
    if (cover && !get('SELECT 1 AS x FROM photos WHERE id = ? AND event_id = ?', cover, current.id)) return fail(res, 'That photo isn’t in this event.');
  }
  tx(() => {
    run('UPDATE events SET title = ?, date = ?, emoji = ?, description = ?, cover_photo_id = ? WHERE id = ?',
      ev.title, ev.date, ev.emoji, ev.description, cover, current.id);
    run('UPDATE photos SET date = ? WHERE event_id = ?', ev.date, current.id);
  });
  res.json({ ok: true });
});

app.delete('/api/events/:id', needUser, (req, res) => {
  const current = get('SELECT * FROM events WHERE id = ?', id(req.params.id));
  if (!current) return fail(res, 'Event not found.', 404);
  if (!canEdit(req.user, current.created_by)) return fail(res, 'Only the person who made this event (or the admin) can delete it.', 403);
  run('DELETE FROM events WHERE id = ?', current.id); // its photos stay on the timeline, just without the event
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

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'One of those photos is over 40 MB.' : `Upload problem: ${err.message}`;
    return fail(res, msg, 400);
  }
  console.error(err);
  if (res.headersSent) return next(err);
  fail(res, 'Something went wrong on the server.', 500);
});

ensureSetupCode();
app.listen(PORT, () => console.log(`  Family Scrapbook running at http://localhost:${PORT}\n`));
