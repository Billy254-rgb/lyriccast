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
let db = { sessions: {} };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!db.sessions) db.sessions = {}; } catch (e) { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    const tmp = FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, FILE, () => {}); });
  }, 400);
}

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
app.use(express.json({ limit: '3mb' }));

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
app.get('/manifest.webmanifest', sendPage('manifest.webmanifest'));
app.get('/icon.svg', sendPage('icon.svg'));
app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/session', limiter(10, 3600000), (req, res) => {
  const code = newCode(), key = crypto.randomBytes(18).toString('hex');
  db.sessions[code] = { key, created: Date.now(), songs: [], presets: [], style: Object.assign({}, DEFAULT_STYLE),
    live: { line: '', next: '', title: '', artist: '', tag: false, visible: false, rev: 0 } };
  save(); res.json({ code, key });
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
app.get('/api/s/:code/data', auth, (req, res) => res.json({ songs: req.ses.songs, presets: req.ses.presets, state: pub(req.ses) }));

function cleanSong(b, old) {
  const lyrics = clean(b.lyrics, 30000).replace(/\r\n?/g, '\n');
  return { id: old ? old.id : crypto.randomBytes(6).toString('hex'), title: clean(b.title, 120).trim() || 'Untitled',
    artist: clean(b.artist, 120).trim(), lyrics, fav: !!b.fav, updated: Date.now() };
}
function upsert(ses, b) {
  const i = b.id ? ses.songs.findIndex(x => x.id === b.id) : -1;
  if (i < 0 && ses.songs.length >= MAX_SONGS) return null;
  const s = cleanSong(b, i >= 0 ? ses.songs[i] : null);
  if (i >= 0) ses.songs[i] = s; else ses.songs.push(s);
  return s;
}
app.post('/api/s/:code/songs', auth, (req, res) => {
  const s = upsert(req.ses, req.body || {}); if (!s) return res.status(400).json({ error: 'Song limit reached' });
  save(); bc(req.code, { t: 'songs', songs: req.ses.songs }, 'control'); res.json(s);
});
app.post('/api/s/:code/songs/bulk', auth, (req, res) => {
  const list = Array.isArray(req.body && req.body.songs) ? req.body.songs.slice(0, 500) : [];
  let n = 0; list.forEach(b => { if (b && typeof b === 'object' && upsert(req.ses, { title: b.title, artist: b.artist, lyrics: b.lyrics, fav: b.fav })) n++; });
  save(); bc(req.code, { t: 'songs', songs: req.ses.songs }, 'control'); res.json({ added: n });
});
app.delete('/api/s/:code/songs/:id', auth, (req, res) => {
  req.ses.songs = req.ses.songs.filter(x => x.id !== req.params.id); save();
  bc(req.code, { t: 'songs', songs: req.ses.songs }, 'control'); res.json({ ok: true });
});
app.post('/api/s/:code/songs/delete', auth, (req, res) => {
  const ids = new Set(Array.isArray(req.body && req.body.ids) ? req.body.ids : []);
  req.ses.songs = req.ses.songs.filter(x => !ids.has(x.id)); save();
  bc(req.code, { t: 'songs', songs: req.ses.songs }, 'control'); res.json({ ok: true });
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
app.post('/api/s/:code/presets', auth, (req, res) => {
  const list = Array.isArray(req.body && req.body.presets) ? req.body.presets.slice(0, 100) : [];
  req.ses.presets = list.map(p => ({ id: clean(p.id, 24) || crypto.randomBytes(4).toString('hex'), name: clean(p.name, 60) || 'Preset', style: cleanStyle(p.style) }));
  save(); bc(req.code, { t: 'presets', presets: req.ses.presets }, 'control'); res.json({ presets: req.ses.presets });
});
app.post('/api/s/:code/regenerate', auth, (req, res) => {
  const code = newCode(); db.sessions[code] = req.ses; delete db.sessions[req.code]; save();
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

server.listen(PORT, () => console.log('LyricCast running on port ' + PORT));
