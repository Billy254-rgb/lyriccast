'use strict';
// LyricCast server: Express + WebSocket, with SSE and polling fallbacks for the output page.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'lyriccast-data.json');
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const MAX_SONGS = 2000;

// ---------- storage (starts empty; nothing is seeded) ----------
// Without DATABASE_URL the data is a JSON file. With DATABASE_URL (any Postgres, for example a free Neon or Supabase database)
// the data is kept in Postgres, so it survives restarts and redeploys on hosts with no persistent disk.
const DATABASE_URL = process.env.DATABASE_URL || '';
let db = { sessions: {}, accounts: {} }, pool = null, saveTimer = null, writing = false, dirty = false;
async function initStore() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, max: 3, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
    await pool.query('create table if not exists lyriccast_kv (id text primary key, data jsonb not null)');
    const r = await pool.query("select data from lyriccast_kv where id = 'db'");
    if (r.rows[0]) db = r.rows[0].data;
    console.log('Storage: Postgres');
  } else {
    try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first run */ }
    console.log('Storage: file ' + FILE + ' (use DATABASE_URL to survive host restarts)');
  }
  if (!db.sessions) db.sessions = {}; if (!db.accounts) db.accounts = {};
}
async function flush() {
  if (writing) { dirty = true; return; } writing = true; dirty = false;
  try {
    if (pool) await pool.query("insert into lyriccast_kv (id, data) values ('db', $1) on conflict (id) do update set data = excluded.data", [JSON.stringify(db)]);
    else { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); }
  } catch (e) { console.error('Save failed:', e.message); }
  writing = false; if (dirty) flush();
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400); }
async function shutdown() { clearTimeout(saveTimer); await flush(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// ---------- style schema (one neutral default; presets are user-made only) ----------
const DEFAULT_STYLE = {
  font: 'sans', weight: 700, size: 64, spacing: 0, lh: 1.15, color: '#ffffff', upper: false,
  outline: 0, outlineColor: '#000000', shadow: 12, shadowColor: '#000000',
  bar: true, barColor: '#0b0b14', barOpacity: 0.78, radius: 14, padX: 44, padY: 22, blur: 0,
  accent: true, accentColor: '#d4a84b', fit: 'text', pos: 'center', align: 'center',
  offX: 0, offY: 90, anim: 'fade', dur: 300, rows: 1, showTag: false, showNext: false, nextScale: 0.55
};
const ENUM = { font: ['sans', 'serif', 'mono', 'rounded', 'condensed', 'display'], pos: ['left', 'center', 'right'],
  align: ['left', 'center', 'right'], anim: ['fade', 'slide', 'cut'], fit: ['text', 'full'] };
const NUM = { weight: [300, 900], size: [24, 160], spacing: [-2, 12], lh: [0.9, 1.8], outline: [0, 10], shadow: [0, 40],
  barOpacity: [0, 1], radius: [0, 80], padX: [0, 160], padY: [0, 100], blur: [0, 40], offX: [-800, 800], offY: [0, 700],
  dur: [0, 2000], rows: [1, 2], nextScale: [0.3, 0.9] };
const COLORS = ['color', 'outlineColor', 'shadowColor', 'barColor', 'accentColor'];
const BOOLS = ['upper', 'bar', 'accent', 'showTag', 'showNext'];
function cleanStyle(inp, base) {
  const out = Object.assign({}, base || DEFAULT_STYLE);
  if (!inp || typeof inp !== 'object') return out;
  for (const k in ENUM) if (ENUM[k].includes(inp[k])) out[k] = inp[k];
  for (const k in NUM) { const n = Number(inp[k]); if (inp[k] !== undefined && isFinite(n)) out[k] = Math.min(NUM[k][1], Math.max(NUM[k][0], n)); }
  for (const k of COLORS) if (typeof inp[k] === 'string' && /^#[0-9a-f]{6}$/i.test(inp[k])) out[k] = inp[k];
  for (const k of BOOLS) if (typeof inp[k] === 'boolean') out[k] = inp[k];
  return out;
}
const clean = (s, n = 400) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, n);

// ---------- sessions ----------
function newCode() {
  for (;;) {
    let c = '';
    const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += ALPHA[b[i] % ALPHA.length];
    if (!db.sessions[c]) return c;
  }
}
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const pub = s => Object.assign({}, s.live, { style: s.style });

// ---------- connected clients ----------
const clients = new Map(); // code -> Set({ws|res, role})
function add(code, c) { if (!clients.has(code)) clients.set(code, new Set()); clients.get(code).add(c); presence(code); }
function drop(code, c) { const s = clients.get(code); if (s) { s.delete(c); if (!s.size) clients.delete(code); } presence(code); }
function sendTo(c, msg) {
  const data = JSON.stringify(msg);
  try { if (c.ws) { if (c.ws.readyState === 1) c.ws.send(data); } else c.res.write('data: ' + data + '\n\n'); } catch (e) {}
}
function bc(code, msg, role) { (clients.get(code) || []).forEach(c => { if (!role || c.role === role) sendTo(c, msg); }); }
function presence(code) {
  const set = clients.get(code) || new Set(); let o = 0, k = 0;
  set.forEach(c => { if (c.role === 'output') o++; else if (c.role === 'control') k++; });
  bc(code, { t: 'presence', outputs: o, controllers: k }, 'control');
}

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.json({ limit: '6mb' }));

const hits = new Map();
function limiter(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.baseUrl + (req.route ? req.route.path : ''); const now = Date.now();
    let h = hits.get(k); if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > max) return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    next();
  };
}
setInterval(() => { const n = Date.now(); hits.forEach((v, k) => { if (v.reset < n) hits.delete(k); }); }, 60000).unref();
app.use('/api', limiter(900, 60000));

const sendPage = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.get('/', sendPage('controller.html'));
app.get('/o/:code', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'output.html')); });
app.get('/sw.js', sendPage('sw.js'));
app.get('/app.js', sendPage('app.js'));
app.get('/manifest.webmanifest', sendPage('manifest.webmanifest'));
app.get('/icon.svg', sendPage('icon.svg'));
app.get('/healthz', (req, res) => res.send('ok'));

function makeSession(key) {
  return { key, created: Date.now(), style: Object.assign({}, DEFAULT_STYLE), libRev: 0,
    lib: { songs: [], schedules: [], presets: [], tomb: {} },
    live: { line: '', next: '', title: '', artist: '', tag: false, visible: false, rev: 0 } };
}
app.post('/api/session', limiter(10, 3600000), (req, res) => {
  const code = newCode(), key = crypto.randomBytes(18).toString('hex');
  db.sessions[code] = makeSession(key); save(); res.json({ code, key });
});
// Lets a controller re-register its own code and key if the server lost its data (for example a free host restart).
app.post('/api/session/restore', limiter(30, 3600000), (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase(), key = String((req.body && req.body.key) || '');
  if (!/^[A-HJKMNP-Z2-9]{6}$/.test(code) || !/^[a-f0-9]{36}$/.test(key)) return res.status(400).json({ error: 'Invalid code or key' });
  const s = db.sessions[code];
  if (s) return eq(key, s.key) ? res.json({ fresh: false }) : res.status(409).json({ error: 'That code belongs to another session' });
  db.sessions[code] = makeSession(key); save(); res.json({ fresh: true });
});


// ---------- accounts: a username and password that point to your session, so any device can open your songs ----------
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k)));
const lname = n => String(n || '').trim().toLowerCase();
app.post('/api/auth/register', limiter(10, 3600000), async (req, res) => {
  try {
    const b = req.body || {}, name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) return res.status(400).json({ error: 'Username must be 3 to 32 letters, numbers, dots, dashes or underscores.' });
    if (pw.length < 8 || pw.length > 128) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.accounts[lname(name)]) return res.status(409).json({ error: 'That username is taken. Try another, or sign in.' });
    let code = String(b.code || '').toUpperCase(), ses = db.sessions[code];
    if (ses && eq(String(b.key || ''), ses.key)) { if (Object.values(db.accounts).some(a => a.code === code)) return res.status(409).json({ error: 'This session already belongs to an account. Sign in instead.' }); }
    else { code = newCode(); ses = db.sessions[code] = makeSession(crypto.randomBytes(18).toString('hex')); }
    const salt = crypto.randomBytes(16).toString('hex');
    db.accounts[lname(name)] = { name, salt, hash: (await scrypt(pw, salt)).toString('hex'), code, created: Date.now() };
    save(); res.json({ code, key: ses.key, name });
  } catch (e) { res.status(500).json({ error: 'Could not create the account.' }); }
});
app.post('/api/auth/login', limiter(20, 900000), async (req, res) => {
  try {
    const b = req.body || {}, acc = db.accounts[lname(b.name)], pw = String(b.password || '').slice(0, 128);
    const salt = acc ? acc.salt : crypto.randomBytes(16).toString('hex'), h = (await scrypt(pw, salt)).toString('hex');
    if (!acc || !eq(h, acc.hash)) return res.status(401).json({ error: 'Wrong username or password.' });
    let ses = db.sessions[acc.code]; if (!ses) { ses = db.sessions[acc.code] = makeSession(crypto.randomBytes(18).toString('hex')); save(); }
    res.json({ code: acc.code, key: ses.key, name: acc.name });
  } catch (e) { res.status(500).json({ error: 'Could not sign in.' }); }
});

// public (read-only) endpoints used by the output page and vMix data sources
function getSes(req, res) { const s = db.sessions[String(req.params.code).toUpperCase()]; if (!s) res.status(404).json({ error: 'Session not found' }); return s; }
app.get('/api/s/:code/state', (req, res) => { const s = getSes(req, res); if (!s) return; res.set('Cache-Control', 'no-store'); res.json(pub(s)); });
app.get('/api/s/:code/current.json', (req, res) => { const s = getSes(req, res); if (!s) return; res.set('Cache-Control', 'no-store');
  res.json({ line: s.live.visible ? s.live.line : '', next: s.live.next, title: s.live.title, artist: s.live.artist, visible: s.live.visible }); });
app.get('/api/s/:code/current.txt', (req, res) => { const s = getSes(req, res); if (!s) return; res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
  res.send(s.live.visible ? s.live.line : ''); });
app.get('/api/s/:code/events', (req, res) => {
  const code = String(req.params.code).toUpperCase(), s = db.sessions[code]; if (!s) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); res.write('retry: 2000\n\n');
  const c = { res, role: req.query.role === 'preview' ? 'preview' : 'output' };
  sendTo(c, { t: 'state', state: pub(s) }); add(code, c);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(ka); drop(code, c); });
});

// control endpoints (need the private key)
function auth(req, res, next) {
  const code = String(req.params.code).toUpperCase(), s = db.sessions[code];
  if (!s || !eq(req.get('x-key') || '', s.key)) return res.status(401).json({ error: 'Invalid session or key' });
  req.code = code; req.ses = s; next();
}
// ---- library: the controller owns its data (stored on the device); the server keeps a merged backup copy ----
const arr = (a, n) => Array.isArray(a) ? a.slice(0, n) : [];
const ts = v => { v = Number(v); return isFinite(v) ? v : 0; };
const sid = v => clean(v, 40).replace(/[^\w-]/g, '');
function cleanLib(l) {
  l = l && typeof l === 'object' ? l : {};
  const tomb = {}; Object.keys(l.tomb && typeof l.tomb === 'object' ? l.tomb : {}).slice(0, 5000).forEach(k => { const id = sid(k); if (id) tomb[id] = ts(l.tomb[k]); });
  return {
    songs: arr(l.songs, MAX_SONGS).filter(x => x && sid(x.id)).map(x => ({ id: sid(x.id), title: clean(x.title, 120), artist: clean(x.artist, 120),
      text: clean(x.text, 30000).replace(/\r\n?/g, '\n'), arrangement: Array.isArray(x.arrangement) ? x.arrangement.slice(0, 300).map(n => Math.max(0, Math.min(500, parseInt(n, 10) || 0))) : null,
      fav: !!x.fav, updated: ts(x.updated) })),
    schedules: arr(l.schedules, 500).filter(x => x && sid(x.id)).map(x => ({ id: sid(x.id), name: clean(x.name, 120), date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) ? String(x.date) : '', updated: ts(x.updated),
      items: arr(x.items, 300).filter(i => i && sid(i.id)).map(i => ({ id: sid(i.id), type: i.type === 'text' ? 'text' : 'song', songId: sid(i.songId),
        title: clean(i.title, 120), text: clean(i.text, 5000), note: clean(i.note, 300) })) })),
    presets: arr(l.presets, 200).filter(x => x && sid(x.id)).map(x => ({ id: sid(x.id), name: clean(x.name, 60), style: cleanStyle(x.style), updated: ts(x.updated) })),
    tomb
  };
}
const mergeCol = (a, b, tomb) => { const m = new Map(); a.concat(b).forEach(x => { const o = m.get(x.id); if (!o || x.updated > o.updated) m.set(x.id, x); });
  return Array.from(m.values()).filter(x => !(tomb[x.id] >= x.updated)); };
function mergeLib(base, inc) {
  const tomb = Object.assign({}, base.tomb); Object.keys(inc.tomb).forEach(k => { tomb[k] = Math.max(tomb[k] || 0, inc.tomb[k]); });
  const keep = Object.keys(tomb).sort((x, y) => tomb[y] - tomb[x]).slice(0, 5000), t = {}; keep.forEach(k => { t[k] = tomb[k]; });
  return { songs: mergeCol(base.songs, inc.songs, t), schedules: mergeCol(base.schedules, inc.schedules, t), presets: mergeCol(base.presets, inc.presets, t), tomb: t };
}
function L(s) {
  if (!s.lib) { s.lib = cleanLib({ songs: (s.songs || []).map(x => ({ id: x.id, title: x.title, artist: x.artist, text: x.lyrics, fav: x.fav, updated: x.updated })), presets: s.presets });
    s.libRev = 0; delete s.songs; delete s.presets; }
  return s.lib;
}
app.get('/api/s/:code/data', auth, (req, res) => res.json({ lib: L(req.ses), libRev: req.ses.libRev || 0, state: pub(req.ses) }));
app.put('/api/s/:code/library', auth, (req, res) => {
  const merged = mergeLib(L(req.ses), cleanLib(req.body && req.body.lib));
  if (JSON.stringify(merged) !== JSON.stringify(req.ses.lib)) { req.ses.lib = merged; req.ses.libRev = (req.ses.libRev || 0) + 1; save(); bc(req.code, { t: 'lib', rev: req.ses.libRev }, 'control'); }
  res.json({ lib: req.ses.lib, rev: req.ses.libRev || 0 });
});
app.post('/api/s/:code/live', auth, (req, res) => {
  const b = req.body || {}, L = req.ses.live;
  if ('line' in b) { L.line = clean(b.line); L.next = clean(b.next); L.title = clean(b.title, 120); L.artist = clean(b.artist, 120); L.tag = !!b.tag; }
  if ('visible' in b) L.visible = !!b.visible;
  L.rev++; save(); bc(req.code, { t: 'state', state: pub(req.ses) }); res.json({ ok: true, rev: L.rev });
});
app.post('/api/s/:code/style', auth, (req, res) => {
  req.ses.style = cleanStyle(req.body && req.body.style, req.ses.style); req.ses.live.rev++; save();
  bc(req.code, { t: 'state', state: pub(req.ses) }); res.json({ style: req.ses.style });
});
app.post('/api/s/:code/regenerate', auth, (req, res) => {
  const code = newCode(); db.sessions[code] = req.ses; delete db.sessions[req.code];
  Object.keys(db.accounts).forEach(k => { if (db.accounts[k].code === req.code) db.accounts[k].code = code; }); save();
  (clients.get(req.code) || []).forEach(c => { try { c.ws ? c.ws.close(4004) : c.res.end(); } catch (e) {} });
  clients.delete(req.code); res.json({ code });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => res.status(400).json({ error: 'Bad request' }));

// ---------- websocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams, code = String(q.get('code') || '').toUpperCase(), s = db.sessions[code], role = q.get('role');
  if (!s) return ws.close(4004);
  if (role === 'control' && !eq(q.get('key') || '', s.key)) return ws.close(4001);
  const c = { ws, role: role === 'control' ? 'control' : role === 'preview' ? 'preview' : 'output' };
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  sendTo(c, { t: 'state', state: pub(s) }); add(code, c);
  ws.on('message', m => { try { const d = JSON.parse(m); if (d.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: d.ts })); } catch (e) {} });
  ws.on('close', () => drop(code, c)); ws.on('error', () => {});
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }), 25000).unref();

initStore().then(() => server.listen(PORT, () => console.log('LyricCast running on port ' + PORT))).catch(e => { console.error('Could not start:', e.message); process.exit(1); });
