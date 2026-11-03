'use strict';
/* LyricCast controller. Local-first: songs, schedules and presets live on this device (IndexedDB) and work offline.
   Signing in links the device to an account, so the same library opens on any device. */
const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
const DEF = { font: 'sans', weight: 700, size: 64, spacing: 0, lh: 1.15, color: '#ffffff', upper: false, outline: 0, outlineColor: '#000000', shadow: 12, shadowColor: '#000000',
  bar: true, barColor: '#0b0b14', barOpacity: 0.78, radius: 14, padX: 44, padY: 22, blur: 0, accent: true, accentColor: '#d4a84b', fit: 'text', pos: 'center', align: 'center',
  offX: 0, offY: 90, anim: 'fade', dur: 300, rows: 1, showTag: false, showNext: false, nextScale: 0.55 };
const D = { songs: [], schedules: [], presets: [], tomb: {}, set: {}, style: Object.assign({}, DEF), session: null, draft: null, account: null };
const KEYS = ['songs', 'schedules', 'presets', 'tomb', 'set', 'style', 'session', 'draft', 'account'];
let ws = null, wsFails = 0, outputs = 0, lat = null, serverLive = { visible: false }, libRev = -1, pingT = null;
let SEL = null, LV = null, frozen = false, ED = null, syncing = false, syncAgain = false, syncState = '', reorder = false, view = 'lyr', styleBusy = false;

/* ---------- storage ---------- */
const Store = (() => { let db = null;
  const open = () => new Promise(res => { try { const r = indexedDB.open('lyriccast', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { db = r.result; res(); }; r.onerror = r.onblocked = () => res(); } catch (e) { res(); } });
  const get = k => new Promise(res => { if (db) { try { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(); return; } catch (e) {} }
    try { const v = localStorage.getItem('lc_' + k); res(v ? JSON.parse(v) : undefined); } catch (e) { res(); } });
  const set = (k, v) => new Promise(res => { if (db) { try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); return; } catch (e) {} }
    try { localStorage.setItem('lc_' + k, JSON.stringify(v)); res(true); } catch (e) { res(false); } });
  return { open, get, set }; })();
const persist = k => Store.set(k, D[k]);
async function loadAll() { await Store.open(); for (const k of KEYS) { const v = await Store.get(k); if (v !== undefined && v !== null) D[k] = v; }
  D.style = Object.assign({}, DEF, D.style); try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {} }

/* ---------- helpers ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = n => '<svg class="i" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14));
const hue = s => { s = String(s).toLowerCase().replace(/\d+/g, '').trim(); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} };
const canLive = () => !!(D.session && ws && ws.readyState === 1);
const findSong = id => D.songs.find(s => s.id === id);
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const fmtDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : ''; };
const schLabel = sc => [fmtDate(sc.date), sc.name].filter(Boolean).join(' \u00b7 ') || 'Schedule';
const sortedScheds = () => D.schedules.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
const curSched = () => D.schedules.find(s => s.id === D.set.sched) || D.schedules.find(s => s.date === today()) || sortedScheds()[0] || null;
function touch(key, obj) { if (obj) obj.updated = Date.now(); persist(key); syncSoon(); }
function tombstone(id) { D.tomb[id] = Date.now(); persist('tomb'); }
const refKey = r => r.type === 'song' ? 's:' + r.songId : 't:' + r.id;

/* ---------- dialogs and sheets ---------- */
let layerCancel = () => {};
function openLayer(html) { const L = $('#layer'); L.innerHTML = '<div class="scrim" data-x="1"></div><div class="box" role="dialog" aria-modal="true">' + html + '</div>'; L.hidden = false; document.body.classList.add('lock'); return L.querySelector('.box'); }
function closeLayer() { const L = $('#layer'); L.hidden = true; L.innerHTML = ''; document.body.classList.remove('lock'); layerCancel = () => {}; }
$('#layer').addEventListener('click', e => { if (e.target.dataset && e.target.dataset.x) layerCancel(); });
function dlg(o) {
  return new Promise(res => {
    const fields = (o.fields || []).map(x => '<label for="d_' + x.id + '">' + esc(x.label) + '</label>' + (x.type === 'textarea'
      ? '<textarea id="d_' + x.id + '" style="min-height:' + (x.h || 140) + 'px" maxlength="' + (x.max || 5000) + '">' + esc(x.value || '') + '</textarea>'
      : '<input id="d_' + x.id + '" type="' + (x.type || 'text') + '" value="' + esc(x.value || '') + '" maxlength="' + (x.max || 120) + '" autocomplete="off">')).join('');
    const acts = o.actions || [{ label: o.ok || 'OK', value: 'ok', cls: o.danger ? 'danger' : 'pri' }];
    const box = openLayer('<h3>' + esc(o.title) + '</h3>' + (o.msg ? '<p class="m">' + esc(o.msg) + '</p>' : '') + fields +
      '<div class="dbtn"><button class="btn" data-v="">Cancel</button>' + acts.map(a => '<button class="btn ' + (a.cls || '') + '" data-v="' + a.value + '">' + esc(a.label) + '</button>').join('') + '</div>');
    const done = v => { const vals = {}; (o.fields || []).forEach(x => { vals[x.id] = box.querySelector('#d_' + x.id).value; }); closeLayer(); res(v ? { act: v, vals } : null); };
    layerCancel = () => done('');
    box.querySelectorAll('[data-v]').forEach(b => b.onclick = () => done(b.dataset.v));
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); done(acts[0].value); } });
    const f = box.querySelector('input,textarea'); if (f) setTimeout(() => { f.focus(); if (f.select && f.type === 'text') f.select(); }, 60);
  });
}
const confirmD = (title, msg, ok) => dlg({ title, msg, ok: ok || 'Delete', danger: true }).then(r => !!r);
function sheet(title, items) {
  const box = openLayer((title ? '<h3>' + esc(title) + '</h3>' : '') + items.map((it, i) => '<button class="sheetbtn' + (it.danger ? ' danger' : '') + '" data-i="' + i + '">' + (it.icon ? ic(it.icon) : '') + '<span style="flex:1">' + esc(it.label) + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>' + (it.check ? ic('check') : '') + '</button>').join(''));
  layerCancel = closeLayer; box.querySelectorAll('.sheetbtn').forEach(b => b.onclick = () => { const it = items[+b.dataset.i]; closeLayer(); it.fn && it.fn(); });
}

/* ---------- song parsing ---------- */
const LBL = /^\[(.+)\]$|^(verse|chorus|pre-?chorus|bridge|intro|outro|tag|interlude|ending|refrain|hook|coda|vamp)\s*\d*\s*:?$/i;
function sections(text) {
  const lines = String(text || '').split('\n'), out = [], hasLbl = lines.some(l => LBL.test(l.trim()));
  let cur = null, part = 0; const start = name => { cur = { name, lines: [] }; out.push(cur); };
  for (const raw of lines) { const t = raw.trim();
    if (!t) { if (!hasLbl && cur && cur.lines.length) cur = null; continue; }
    const m = t.match(LBL); if (m) { start((m[1] || t).replace(/:$/, '').trim()); continue; }
    if (!cur) start(hasLbl ? 'Lyrics' : 'Part ' + (++part)); cur.lines.push(t); }
  return out.filter(s => s.lines.length);
}
const validArr = (a, n) => Array.isArray(a) && a.length && a.every(i => Number.isInteger(i) && i >= 0 && i < n) ? a : null;
function modelOf(ref) {
  if (ref.type === 'song') {
    const s = findSong(ref.songId); if (!s) return { kind: 'song', title: 'Song removed', artist: '', slides: [], gone: true };
    const secs = sections(s.text), order = validArr(s.arrangement, secs.length) || secs.map((_, i) => i), slides = [];
    order.forEach((si, pos) => secs[si].lines.forEach(t => slides.push({ text: t, sec: secs[si].name, pos })));
    return { kind: 'song', title: s.title, artist: s.artist, slides };
  }
  return { kind: 'text', title: ref.title || 'Text', artist: '', slides: String(ref.text || '').split('\n').map(x => x.trim()).filter(Boolean).map(t => ({ text: t, sec: '', pos: 0 })) };
}

/* ---------- server api ---------- */
async function raw(path, method, body) {
  let r; try { r = await fetch('/api/s/' + D.session.code + path, { method: method || 'GET', headers: { 'content-type': 'application/json', 'x-key': D.session.key }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('Offline'); }
  return { r, j: await r.json().catch(() => ({})) };
}
async function api(path, method, body) {
  if (!D.session) throw new Error('Not linked to vMix yet');
  let { r, j } = await raw(path, method, body);
  if (r.status === 401 && await restore()) ({ r, j } = await raw(path, method, body));
  if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
}
// If the host lost its data, re-register the same code and key, then re-send our style.
async function restore() {
  try { const r = await fetch('/api/session/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(D.session) }); const j = await r.json();
    if (!r.ok) return false; if (j.fresh) await raw('/style', 'POST', { style: D.style }); return true; } catch (e) { return false; }
}
async function auth(path, body) {
  let r; try { r = await fetch('/api/auth/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { throw new Error('You are offline. Your songs still work.'); }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
}

/* ---------- library sync (merge both ways, never overwrite blindly) ---------- */
const mergeCol = (a, b, tomb) => { const m = new Map(); a.concat(b || []).forEach(x => { const o = m.get(x.id); if (!o || x.updated > o.updated) m.set(x.id, x); });
  return Array.from(m.values()).filter(x => !(tomb[x.id] >= x.updated)); };
function mergeIn(lib) {
  const before = JSON.stringify([D.songs, D.schedules, D.presets]);
  Object.keys(lib.tomb || {}).forEach(k => { D.tomb[k] = Math.max(D.tomb[k] || 0, lib.tomb[k]); });
  D.songs = mergeCol(D.songs, lib.songs, D.tomb); D.schedules = mergeCol(D.schedules, lib.schedules, D.tomb); D.presets = mergeCol(D.presets, lib.presets, D.tomb);
  if (before !== JSON.stringify([D.songs, D.schedules, D.presets])) { ['songs', 'schedules', 'presets', 'tomb'].forEach(persist); renderAll(); }
}
let syncT = null; const syncSoon = () => { clearTimeout(syncT); syncT = setTimeout(sync, 1200); };
async function sync() {
  if (!canLive()) { syncState = D.session ? 'Saved on this device. Will sync when online.' : 'Saved on this device only.'; return updStatus(); }
  if (syncing) { syncAgain = true; return; } syncing = true;
  try { const r = await api('/library', 'PUT', { lib: { songs: D.songs, schedules: D.schedules, presets: D.presets, tomb: D.tomb } }); libRev = r.rev; mergeIn(r.lib); syncState = 'Saved on this device and backed up to your account.'; }
  catch (e) { syncState = 'Saved on this device. Backup pending.'; }
  syncing = false; updStatus(); if (syncAgain) { syncAgain = false; sync(); }
}

/* ---------- realtime ---------- */
function connect() {
  if (!D.session) return; clearTimeout(connect.t);
  if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?code=' + D.session.code + '&role=control&key=' + encodeURIComponent(D.session.key));
  ws.onopen = async () => { wsFails = 0; $('#banner').classList.remove('on'); clearInterval(pingT); ping(); pingT = setInterval(ping, 5000); updStatus(); await afterConnect(); };
  ws.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; }
    if (d.t === 'state') { serverLive = d.state; if (JSON.stringify(d.state.style) !== JSON.stringify(D.style) && !styleBusy) { D.style = Object.assign({}, DEF, d.state.style); persist('style'); syncDesign(); pushLocal(); } renderLive(); }
    else if (d.t === 'presence') { outputs = d.outputs; updStatus(); }
    else if (d.t === 'pong') { lat = Date.now() - d.ts; updStatus(); }
    else if (d.t === 'lib' && d.rev !== libRev) sync(); };
  ws.onclose = async e => { clearInterval(pingT); updStatus();
    if (e.code === 4001) { $('#banner').textContent = 'The control key was rejected. Sign out and sign in again.'; $('#banner').classList.add('on'); return; }
    if (e.code === 4004) await restore();
    const wait = Math.min(500 * Math.pow(2, wsFails++), 8000); if (wsFails > 1) { $('#banner').textContent = 'vMix link lost. Your songs are safe. Reconnecting.'; $('#banner').classList.add('on'); }
    connect.t = setTimeout(connect, wait); };
}
const ping = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })); };
async function afterConnect() {
  try { const d = await api('/data'); serverLive = d.state;
    if (D.set.pendStyle) { const r = await api('/style', 'POST', { style: D.style }); D.style = r.style; D.set.pendStyle = false; persist('set'); } else D.style = Object.assign({}, DEF, d.state.style);
    persist('style'); libRev = d.libRev; mergeIn(d.lib); syncDesign(); pushLocal(); await sync();
    const f = $('#pvReal'); if (!f.getAttribute('src')) f.src = '/o/' + D.session.code + '?preview=1'; renderLive();
  } catch (e) { toast(e.message); }
}
function updStatus() {
  const on = canLive();
  $('#cdot').className = 'dot' + (!D.session ? ' off' : on ? (outputs ? ' ok' : ' mid') : '');
  const txt = !D.session ? 'Not linked' : !on ? 'Offline' : outputs ? outputs + (outputs === 1 ? ' output live' : ' outputs live') : 'No output yet';
  $('#ctext').textContent = txt; $('#outInfo').textContent = !D.session ? '' : on ? (outputs ? outputs + (outputs === 1 ? ' output' : ' outputs') : 'No output yet') : 'Offline';
  const s = $('#stat'); if (s) s.textContent = (on ? 'Connected to server' + (lat != null ? ' (' + lat + ' ms)' : '') : 'Not connected') + '. ' + (outputs ? outputs + (outputs === 1 ? ' vMix output is' : ' outputs are') + ' connected.' : 'No output connected yet. Open the link in vMix.') + ' ' + syncState;
  const st = $('#store'); if (st) st.textContent = D.songs.length + ' songs, ' + D.schedules.length + ' schedules and ' + D.presets.length + ' presets are stored on this device and work offline. ' + (syncState || '');
  const ov = $('#monOv'); ov.hidden = on; ov.textContent = !D.session ? 'Not linked to vMix. Open Connect to sign in or create a session.' : 'Offline. Lines cannot be sent until the link returns.';
  $('#acHint').hidden = !!D.account;
}

/* ---------- local style preview ---------- */
function post(frame, p) { frame._p = p; try { frame.contentWindow.postMessage({ lc: 1, state: p }, location.origin); } catch (e) {} }
function payloadFor(m, i) { const s = m && m.slides[i]; if (!s) return null;
  return { line: s.text, next: m.slides[i + 1] ? m.slides[i + 1].text : '', title: m.title, artist: m.artist, tag: m.kind === 'song' && i === 0, visible: true, style: D.style }; }
function pushLocal() { const p = (LV && LV.idx >= 0 && payloadFor(LV.m, LV.idx)) || (SEL && payloadFor(SEL.m, 0)) || { line: 'Your lyric line appears here', next: '', title: '', artist: '', tag: false, visible: true, style: D.style }; post($('#pvLocal2'), p); }
function fitMon() { [['#mon1', '#pvReal'], ['#mon3', '#pvLocal2']].forEach(p => { const m = $(p[0]); if (m && m.clientWidth) $(p[1]).style.transform = 'scale(' + (m.clientWidth / 1920) + ')'; }); }

/* ---------- lyrics pane ---------- */
function gridHtml(m, active, next) {
  if (!m || !m.slides.length) return '<div class="empty"><b>No lines</b>' + (m && m.gone ? 'This song was removed from the library.' : 'Add lyrics to this item.') + '</div>';
  let h = '', last = -1;
  m.slides.forEach((s, i) => { if (s.sec && s.pos !== last) { last = s.pos; h += '<div class="lbl" data-pos="' + s.pos + '" style="color:hsl(' + hue(s.sec) + ',70%,62%);border-color:currentColor">' + esc(s.sec) + '</div>'; }
    h += '<button class="sl' + (i === active ? ' on' : '') + (i === next ? ' nx' : '') + '" data-i="' + i + '">' + esc(s.text) + '</button>'; });
  return h;
}
function chipsFor(m, cls) { let h = '', seen = {}; if (m) m.slides.forEach((s, i) => { if (s.sec && !seen[s.pos]) { seen[s.pos] = 1; h += '<button class="chip" data-i="' + i + '" data-pos="' + s.pos + '" style="color:hsl(' + hue(s.sec) + ',70%,62%)">' + esc(s.sec) + '</button>'; } }); return h; }
function renderLyrics(scroll) {
  const m = SEL && SEL.m, live = LV && SEL && LV.key === SEL.key ? LV.idx : -1;
  $('#lyTitle').textContent = m ? m.title : 'Lyrics';
  $('#lySub').textContent = m ? [m.artist, m.slides.length + ' lines'].filter(Boolean).join(' \u00b7 ') : 'Choose a song from your schedule or search';
  $('#lyLines').innerHTML = m ? gridHtml(m, live, live >= 0 ? live + 1 : -1) : '<div class="empty"><b>No song selected</b>Tap a song in your schedule, or search the library on the left, to see its lyrics here.</div>';
  $('#lyChips').innerHTML = chipsFor(m);
  const sc = curSched(), inSched = !!(SEL && sc && sc.items.some(i => refKey(i) === SEL.key));
  $('#lyAdd').hidden = !(SEL && SEL.ref.type === 'song' && !inSched && !SEL.m.gone); $('#lyEdit').hidden = !SEL || SEL.m.gone;
  $('#startSong').disabled = !m || !m.slides.length;
  if (scroll) { const a = $('#lyLines .sl.on'); if (a) a.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
function select(ref, itemId) { SEL = { ref, m: modelOf(ref), key: refKey(ref), itemId: itemId || null }; renderLyrics(); markItems(); pushLocal(); }
$('#lyLines').onclick = e => { const b = e.target.closest('.sl'); if (b) lineTap(+b.dataset.i); };
$('#lyChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const l = $('#lyLines .lbl[data-pos="' + b.dataset.pos + '"]'); if (l) l.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
$('#startSong').onclick = () => lineTap(0);
$('#lyAdd').onclick = () => { if (SEL && SEL.ref.type === 'song') { addItem({ type: 'song', songId: SEL.ref.songId }); toast('Added to schedule'); renderLyrics(); } };
$('#lyEdit').onclick = () => { if (!SEL) return; if (SEL.ref.type === 'song') { setView('songs'); openEd(findSong(SEL.ref.songId)); } else editText(SEL.ref); };

/* ---------- live ---------- */
function lineTap(i) {
  if (!SEL || !SEL.m.slides[i]) return;
  if (!frozen && !canLive()) return toast('Not connected to vMix. Your songs still work offline.');
  if (!LV || LV.key !== SEL.key) LV = { ref: SEL.ref, m: SEL.m, key: SEL.key, idx: -1, itemId: SEL.itemId };
  sendLine(i);
}
async function sendLine(i, force) {
  const m = LV.m, s = m.slides[i]; if (!s) return;
  if (frozen && !force) { LV.idx = i; renderLive(); renderLyrics(true); return toast('Frozen. The output is held. Tap Freeze to release.'); }
  if (!canLive()) return toast('Not connected to vMix. Your songs still work offline.');
  LV.idx = i; renderLive(); renderLyrics(true); pushLocal(); buzz();
  try { await api('/live', 'POST', { line: s.text, next: m.slides[i + 1] ? m.slides[i + 1].text : '', title: m.title, artist: m.artist, tag: m.kind === 'song' && i === 0, visible: true }); }
  catch (e) { toast(e.message); }
}
function selectNextItem(fromKey) { const sc = curSched(); if (!sc) return false; const i = sc.items.findIndex(x => refKey(x) === fromKey), n = sc.items[i + 1]; if (i < 0 || !n) return false; select(n, n.id); return n; }
function step(d) {
  if (!LV) { if (SEL && d > 0) lineTap(0); return; }
  const i = LV.idx + d; if (i < 0) return sendLine(0);
  if (i >= LV.m.slides.length) { const n = selectNextItem(LV.key); toast(n ? 'End of song. Up next: ' + modelOf(n).title : 'End of song.'); return; }
  sendLine(i);
}
async function setVisible(v) { if (!canLive()) return toast('Not connected to vMix.'); buzz(); try { await api('/live', 'POST', { visible: v }); } catch (e) { toast(e.message); } }
function doFreeze() { frozen = !frozen; if (!frozen && LV && LV.idx >= 0) sendLine(LV.idx, true); renderLive(); }
function renderLive() {
  const m = LV && LV.m, s = m && LV.idx >= 0 ? m.slides[LV.idx] : null, vis = !!(serverLive && serverLive.visible);
  $('#lvTitle').textContent = m ? m.title : 'Nothing live';
  $('#nowT').textContent = s ? s.text : 'Nothing on screen'; $('#nxtT').textContent = m && s ? (m.slides[LV.idx + 1] ? m.slides[LV.idx + 1].text : 'End of song') : '';
  $('#chips').innerHTML = chipsFor(m);
  $('#hide').disabled = !vis; $('#show').disabled = vis || !s; $('#show').classList.toggle('hold', !vis && !!s); $('#freeze').classList.toggle('on', frozen); $('#freeze').lastChild.textContent = frozen ? 'Release' : 'Freeze';
  $('#next').disabled = !LV && !SEL; $('#prev').disabled = !LV;
  $('#miniT').innerHTML = s ? esc(s.text) + '<small>' + esc(m.title) + (vis ? '' : ' \u00b7 hidden') + (frozen ? ' \u00b7 frozen' : '') + '</small>' : 'Nothing live';
  $('#mHide').innerHTML = ic(vis ? 'eyeoff' : 'eye'); $('#mHide').setAttribute('aria-label', vis ? 'Hide' : 'Show'); $('#mHide').disabled = !s;
  markItems(); pushLocal();
}
$('#chips').onclick = e => { const b = e.target.closest('.chip'); if (b && LV) sendLine(+b.dataset.i); };
$('#next').onclick = () => step(1); $('#prev').onclick = () => step(-1); $('#hide').onclick = () => setVisible(false); $('#show').onclick = () => setVisible(true); $('#freeze').onclick = doFreeze;
$('#mNext').onclick = () => step(1); $('#mPrev').onclick = () => step(-1); $('#mHide').onclick = () => setVisible(!(serverLive && serverLive.visible));
(() => { let x0 = null, y0 = null; const el = $('#mon1'); el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null; if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1); }, { passive: true }); })();

/* ---------- schedule ---------- */
function markItems() { $$('#schItems .it').forEach(el => { const k = el.dataset.k; el.classList.toggle('sel', !!SEL && SEL.key === k); el.classList.toggle('lv', !!LV && LV.key === k); }); }
function renderSchedule() {
  const sc = curSched(); $('#schLbl').textContent = sc ? schLabel(sc) : 'Create a schedule'; $('#reord').disabled = !sc || !sc.items.length; $('#schMore').disabled = !sc;
  $('#reord').setAttribute('aria-pressed', reorder); $('#reord').classList.toggle('pri', reorder);
  if (!sc) { $('#schItems').innerHTML = '<div class="empty"><b>Plan your service</b>Create a schedule for a day, then add songs and text items in the order you will use them.<br><br><button class="btn pri" id="emptyNew">New schedule</button></div>'; const b = $('#emptyNew'); if (b) b.onclick = newSchedule; return; }
  $('#schItems').innerHTML = sc.items.length ? sc.items.map((it, i) => { const m = modelOf(it);
    return '<div class="it" data-id="' + esc(it.id) + '" data-k="' + esc(refKey(it)) + '"><div class="line"><button class="main" data-a="open"><span class="n">' + (i + 1) + '</span><div class="tx"><b>' + esc(m.title) + '</b><span class="s">' + (it.type === 'text' ? 'Text' : esc(m.artist || 'Song')) + ' \u00b7 ' + m.slides.length + ' lines' + (it.note ? ' \u00b7 ' + esc(it.note) : '') + '</span></div></button>' +
      '<button class="btn icon sm go" data-a="go" aria-label="Go live from the first line">' + ic('play') + '</button></div>' +
      (reorder ? '<div class="ro"><button class="btn sm icon" data-a="up" aria-label="Move up">' + ic('up') + '</button><button class="btn sm icon" data-a="dn" aria-label="Move down">' + ic('down') + '</button><button class="btn sm" data-a="note">Note</button>' + (it.type === 'text' ? '<button class="btn sm" data-a="edit">Edit text</button>' : '') + '<button class="btn sm icon danger" data-a="rm" aria-label="Remove from schedule">' + ic('x') + '</button></div>' : '') + '</div>'; }).join('')
    : '<div class="empty"><b>This schedule is empty</b>Search the library above and tap Add, or add a text item below.</div>';
  markItems();
}
function ensureSched() { let sc = curSched(); if (!sc) { sc = { id: uid(), name: 'Service', date: today(), items: [], updated: Date.now() }; D.schedules.push(sc); D.set.sched = sc.id; persist('set'); } return sc; }
function addItem(it) { const sc = ensureSched(); sc.items.push(Object.assign({ id: uid(), note: '' }, it)); touch('schedules', sc); renderSchedule(); }
async function newSchedule() { const r = await dlg({ title: 'New schedule', ok: 'Create', fields: [{ id: 'n', label: 'Name', value: 'Service' }, { id: 'd', label: 'Date', type: 'date', value: today() }] }); if (!r) return;
  const sc = { id: uid(), name: r.vals.n.trim().slice(0, 120) || 'Service', date: r.vals.d || today(), items: [], updated: Date.now() }; D.schedules.push(sc); D.set.sched = sc.id; persist('set'); touch('schedules'); renderSchedule(); renderLyrics(); }
$('#schBtn').onclick = () => sheet('Schedules', sortedScheds().map(sc => ({ label: schLabel(sc), sub: sc.items.length + (sc.items.length === 1 ? ' item' : ' items'), check: curSched() && curSched().id === sc.id, fn: () => { D.set.sched = sc.id; persist('set'); renderSchedule(); renderLyrics(); } }))
  .concat([{ label: 'New schedule', icon: 'plus', fn: newSchedule }]));
$('#schMore').onclick = () => { const sc = curSched(); if (!sc) return; sheet(schLabel(sc), [
  { label: 'Rename or change date', icon: 'edit', fn: async () => { const r = await dlg({ title: 'Schedule details', ok: 'Save', fields: [{ id: 'n', label: 'Name', value: sc.name }, { id: 'd', label: 'Date', type: 'date', value: sc.date || today() }] }); if (!r) return; sc.name = r.vals.n.trim().slice(0, 120) || 'Service'; sc.date = r.vals.d || ''; touch('schedules', sc); renderSchedule(); } },
  { label: 'Duplicate to another day', sub: 'Copies every item', icon: 'list', fn: async () => { const d = new Date(); d.setDate(d.getDate() + 7); const r = await dlg({ title: 'Duplicate schedule', ok: 'Duplicate', fields: [{ id: 'n', label: 'Name', value: sc.name }, { id: 'd', label: 'Date', type: 'date', value: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }] }); if (!r) return;
    const c = JSON.parse(JSON.stringify(sc)); c.id = uid(); c.name = r.vals.n.trim().slice(0, 120) || sc.name; c.date = r.vals.d || ''; c.items.forEach(i => i.id = uid()); c.updated = Date.now(); D.schedules.push(c); D.set.sched = c.id; persist('set'); touch('schedules'); renderSchedule(); toast('Schedule duplicated'); } },
  { label: 'Delete schedule', sub: 'Songs stay in your library', icon: 'trash', danger: true, fn: async () => { if (!await confirmD('Delete this schedule?', '"' + schLabel(sc) + '" will be removed. Your songs stay in the library.')) return; tombstone(sc.id); D.schedules = D.schedules.filter(s => s.id !== sc.id); D.set.sched = ''; persist('set'); touch('schedules'); renderAll(); } }]); };
$('#reord').onclick = () => { reorder = !reorder; renderSchedule(); };
$('#schItems').onclick = async e => { const b = e.target.closest('button'); if (!b) return; const row = b.closest('.it'), sc = curSched(), i = sc.items.findIndex(x => x.id === row.dataset.id), it = sc.items[i], a = b.dataset.a;
  if (a === 'open') { select(it, it.id); if (innerWidth < 1000) setView('lyr'); }
  else if (a === 'go') { select(it, it.id); if (innerWidth < 1000) setView('lyr'); lineTap(0); }
  else if (a === 'up' && i > 0) { sc.items.splice(i - 1, 0, sc.items.splice(i, 1)[0]); touch('schedules', sc); renderSchedule(); }
  else if (a === 'dn' && i < sc.items.length - 1) { sc.items.splice(i + 1, 0, sc.items.splice(i, 1)[0]); touch('schedules', sc); renderSchedule(); }
  else if (a === 'note') { const r = await dlg({ title: 'Note for this item', ok: 'Save', fields: [{ id: 'n', label: 'For example: sing verses 1, 2 and 4', value: it.note || '', max: 300 }] }); if (!r) return; it.note = r.vals.n.trim(); touch('schedules', sc); renderSchedule(); }
  else if (a === 'edit') editText(it);
  else if (a === 'rm') { sc.items.splice(i, 1); touch('schedules', sc); renderSchedule(); renderLyrics(); } };
async function editText(it) { const r = await dlg({ title: it ? 'Edit text item' : 'Add text or announcement', ok: it ? 'Save' : 'Add to schedule', fields: [{ id: 't', label: 'Title', value: it ? it.title : '' }, { id: 'b', label: 'Text (each line is one projected line)', type: 'textarea', value: it ? it.text : '', h: 160 }] }); if (!r) return;
  const body = r.vals.b.trim(); if (!body) return toast('Type the text to project');
  if (it) { it.title = r.vals.t.trim() || 'Text'; it.text = body; touch('schedules', curSched()); renderSchedule(); if (SEL && SEL.key === refKey(it)) select(it, it.id); } else addItem({ type: 'text', title: r.vals.t.trim() || 'Text', text: body }); }
$('#addText').onclick = () => editText(null);

/* ---------- search (the whole library, not only the schedule) ---------- */
function renderSearch() {
  const raw = $('#sq').value.trim(), q = raw.toLowerCase(), on = !!q; $('#col-sch').classList.toggle('searching', on); $('#sres').hidden = !on; if (!on) return;
  const sc = curSched(), inS = new Set(sc ? sc.items.filter(i => i.songId).map(i => i.songId) : []);
  const l = D.songs.filter(s => (s.title + ' ' + s.artist + ' ' + s.text).toLowerCase().includes(q)).sort((a, b) => (b.title.toLowerCase().startsWith(q) - a.title.toLowerCase().startsWith(q)) || a.title.localeCompare(b.title)).slice(0, 60);
  $('#sres').innerHTML = (l.length ? l.map(s => '<div class="res" data-id="' + esc(s.id) + '"><button class="t" data-a="view"><b>' + esc(s.title) + '</b><span>' + esc(s.artist || 'No artist') + '</span></button>' + (inS.has(s.id) ? '<span class="tag">IN SCHEDULE</span>' : '<button class="btn sm pri" data-a="add">Add</button>') + '</div>').join('')
    : '<div class="empty"><b>No songs match</b>Nothing in your library for "' + esc(raw) + '".<br><br><button class="btn pri" id="resNew">Write "' + esc(raw.slice(0, 40)) + '" now</button></div>');
  const nb = $('#resNew'); if (nb) nb.onclick = () => { setView('songs'); openEd(null, null, raw); };
}
$('#sq').oninput = renderSearch;
$('#sq').addEventListener('keydown', e => { if (e.key === 'Escape') { $('#sq').value = ''; renderSearch(); } });
$('#sres').onclick = e => { const b = e.target.closest('button'); if (!b || !b.dataset.a) return; const id = b.closest('.res').dataset.id;
  if (b.dataset.a === 'view') { select({ type: 'song', songId: id }); if (innerWidth < 1000) setView('lyr'); }
  else if (b.dataset.a === 'add') { addItem({ type: 'song', songId: id }); toast('Added to schedule'); renderSearch(); } };
$('#sNew').onclick = () => { setView('songs'); openEd(null, null, $('#sq').value.trim()); };

/* ---------- songs view ---------- */
function renderSongs() {
  const q = $('#q').value.trim().toLowerCase(), l = D.songs.filter(s => !q || (s.title + ' ' + s.artist).toLowerCase().includes(q)).sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.title.localeCompare(b.title));
  $('#songs').innerHTML = l.length ? l.map(s => '<div class="song" data-id="' + esc(s.id) + '"><button class="t" data-a="edit"><b>' + esc(s.title) + '</b><span class="s">' + esc(s.artist || 'No artist') + '</span></button>' +
    '<button class="btn icon sm ghost star' + (s.fav ? ' f' : '') + '" data-a="fav" aria-label="Favourite">' + (s.fav ? '\u2605' : '\u2606') + '</button><button class="btn icon sm ghost" data-a="sched" aria-label="Add to schedule">' + ic('plus') + '</button><button class="btn icon sm ghost" data-a="use" aria-label="Show lyrics">' + ic('lyrics') + '</button></div>').join('')
    : '<div class="empty"><b>' + (D.songs.length ? 'No matches' : 'Your library is empty') + '</b>' + (D.songs.length ? 'Try a different search.' : 'Tap New to write your first song. It is saved on this device and works offline.') + '</div>';
  updStatus();
}
$('#q').oninput = renderSongs;
$('#songs').onclick = e => { const b = e.target.closest('button'); if (!b) return; const id = b.closest('.song').dataset.id, s = findSong(id), a = b.dataset.a;
  if (a === 'edit') openEd(s); else if (a === 'fav') { s.fav = !s.fav; touch('songs', s); renderSongs(); }
  else if (a === 'sched') { addItem({ type: 'song', songId: id }); toast('Added to schedule'); }
  else if (a === 'use') { select({ type: 'song', songId: id }); setView('lyr'); } };
const LBLS = ['Verse 1', 'Verse 2', 'Verse 3', 'Chorus', 'Pre-Chorus', 'Bridge', 'Intro', 'Outro', 'Tag'];
function openEd(s, draft, title) {
  ED = { id: s ? s.id : null, arr: draft ? draft.arr : (s ? s.arrangement : null) };
  $('#edTitle').textContent = s ? 'Edit song' : 'New song'; $('#eT').value = draft ? draft.title : s ? s.title : (title || ''); $('#eA').value = draft ? draft.artist : s ? s.artist : ''; $('#eL').value = draft ? draft.text : s ? s.text : '';
  $('#edNote').hidden = !draft; $('#eDel').hidden = !s; $('#edEmpty').hidden = true; $('#edForm').hidden = false; $('#v-songs').classList.add('editing');
  $('#lblChips').innerHTML = LBLS.map(l => '<button class="chip" data-l="' + l + '" style="color:hsl(' + hue(l) + ',70%,62%)">[' + l + ']</button>').join('');
  edInfo(); window.scrollTo(0, 0); if (!s && !draft) setTimeout(() => $('#eT').focus(), 60);
}
function closeEd() { clearTimeout(draftT); ED = null; D.draft = null; persist('draft'); $('#edForm').hidden = true; $('#edEmpty').hidden = false; $('#v-songs').classList.remove('editing'); }
function edInfo() { const secs = sections($('#eL').value), n = secs.reduce((a, s) => a + s.lines.length, 0);
  $('#eCount').textContent = n + (n === 1 ? ' line' : ' lines') + ' in ' + secs.length + (secs.length === 1 ? ' section' : ' sections') + ' will be projected';
  const auto = !validArr(ED.arr, secs.length), arr = auto ? secs.map((_, i) => i) : ED.arr;
  $('#arrNow').innerHTML = arr.length ? arr.map((si, p) => '<button class="chip" data-p="' + p + '" style="color:hsl(' + hue(secs[si].name) + ',70%,62%)">' + esc(secs[si].name) + ' \u2715</button>').join('') : '<span class="m">Add sections below.</span>';
  $('#arrAdd').innerHTML = secs.map((s, i) => '<button class="chip" data-s="' + i + '" style="color:hsl(' + hue(s.name) + ',70%,62%)">+ ' + esc(s.name) + '</button>').join('');
  $('#arrNote').textContent = auto ? 'The order follows your lyrics. Tap a section below to repeat it, or tap one above to remove it.' : 'Custom order for this song.'; $('#arrReset').hidden = auto; }
let draftT = null;
function draftSave() { clearTimeout(draftT); draftT = setTimeout(() => { if (!ED) return; D.draft = { id: ED.id, title: $('#eT').value, artist: $('#eA').value, text: $('#eL').value, arr: ED.arr }; persist('draft'); }, 350); }
['#eT', '#eA', '#eL'].forEach(s => $(s).addEventListener('input', () => { if (!ED) return; edInfo(); draftSave(); }));
$('#lblChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const ta = $('#eL'), t = '[' + b.dataset.l + ']\n', p = ta.selectionStart, v = ta.value, pre = p && v[p - 1] !== '\n' ? '\n' : '';
  ta.value = v.slice(0, p) + pre + t + v.slice(ta.selectionEnd); ta.focus(); ta.selectionStart = ta.selectionEnd = p + pre.length + t.length; edInfo(); draftSave(); };
$('#arrNow').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const secs = sections($('#eL').value); const arr = (validArr(ED.arr, secs.length) || secs.map((_, i) => i)).slice(); arr.splice(+b.dataset.p, 1); ED.arr = arr; edInfo(); draftSave(); };
$('#arrAdd').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const secs = sections($('#eL').value); const arr = (validArr(ED.arr, secs.length) || (Array.isArray(ED.arr) ? [] : secs.map((_, i) => i))).slice(); arr.push(+b.dataset.s); ED.arr = arr; edInfo(); draftSave(); };
$('#arrReset').onclick = () => { ED.arr = null; edInfo(); draftSave(); };
$('#newSong').onclick = () => openEd(null); $('#eCancel').onclick = closeEd; $('#eBack').onclick = closeEd;
$('#eDel').onclick = async () => { const s = ED && findSong(ED.id); if (!s) return; const used = D.schedules.some(sc => sc.items.some(i => i.songId === s.id)); if (!await confirmD('Delete "' + s.title + '"?', used ? 'It is used in a schedule. This cannot be undone.' : 'This cannot be undone.')) return;
  tombstone(s.id); D.songs = D.songs.filter(x => x.id !== s.id); persist('songs'); closeEd(); syncSoon(); if (SEL && SEL.key === 's:' + s.id) SEL = null; renderAll(); };
$('#eSave').onclick = async () => {
  const t = $('#eT').value.trim(), a = $('#eA').value.trim(), text = $('#eL').value.replace(/\r\n?/g, '\n'); if (!t) return toast('Give the song a title'); if (!text.trim()) return toast('Add some lyrics first');
  if (!ED.id && D.songs.some(s => s.title.toLowerCase() === t.toLowerCase() && s.artist.toLowerCase() === a.toLowerCase()) && !await dlg({ title: 'Song already exists', msg: 'A song with this title and artist is already in your library. Save another copy?', ok: 'Save anyway' })) return;
  const secs = sections(text), arr = validArr(ED.arr, secs.length); let s = ED.id && findSong(ED.id);
  if (s) Object.assign(s, { title: t, artist: a, text, arrangement: arr }); else { s = { id: uid(), title: t, artist: a, text, arrangement: arr, fav: false }; D.songs.push(s); }
  touch('songs', s); closeEd(); renderAll(); toast('Song saved on this device');
  if (SEL && SEL.key === 's:' + s.id) select(SEL.ref, SEL.itemId); if (LV && LV.key === 's:' + s.id) { LV.m = modelOf(LV.ref); renderLive(); } };
const pickFile = inp => new Promise(res => { inp.onchange = () => { res(Array.from(inp.files)); inp.value = ''; }; inp.click(); });
$('#impTxt').onclick = async () => { const fs = await pickFile($('#fTxt')); let n = 0; for (const f of fs) { const text = (await f.text()).replace(/\r\n?/g, '\n').slice(0, 30000); if (!text.trim()) continue; D.songs.push({ id: uid(), title: f.name.replace(/\.txt$/i, ''), artist: '', text, arrangement: null, fav: false, updated: Date.now() }); n++; }
  persist('songs'); syncSoon(); renderAll(); toast(n + ' imported'); };
async function restoreFile() { const fs = await pickFile($('#fJson')); if (!fs[0]) return; try { const j = JSON.parse(await fs[0].text()), now = Date.now();
  const songs = (j.songs || []).map(s => ({ id: s.id || uid(), title: String(s.title || 'Untitled'), artist: String(s.artist || ''), text: String(s.text != null ? s.text : s.lyrics || ''), arrangement: Array.isArray(s.arrangement) ? s.arrangement : null, fav: !!s.fav, updated: s.updated || now }));
  D.songs = mergeCol(D.songs, songs, D.tomb); D.schedules = mergeCol(D.schedules, j.schedules || [], D.tomb); D.presets = mergeCol(D.presets, (j.presets || []).map(p => Object.assign({ updated: now }, p)), D.tomb);
  ['songs', 'schedules', 'presets'].forEach(persist); syncSoon(); renderAll(); toast('Backup restored'); } catch (e) { toast('That file is not a valid backup'); } }
function exportAll() { if (!D.songs.length && !D.schedules.length) return toast('Nothing to export yet'); const b = new Blob([JSON.stringify({ app: 'lyriccast', v: 2, songs: D.songs, schedules: D.schedules, presets: D.presets }, null, 1)], { type: 'application/json' }), a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'lyriccast-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
$('#impJson').onclick = restoreFile; $('#expImp').onclick = restoreFile; $('#expAll').onclick = exportAll; $('#expAll2').onclick = exportAll;

/* ---------- look (design studio) ---------- */
const FIELDS = {
  fText: [['font', 'Font', 'sel', ['sans', 'serif', 'mono', 'rounded', 'condensed', 'display']], ['weight', 'Weight', 'rng', 300, 900, 100], ['size', 'Size', 'rng', 24, 160, 1], ['spacing', 'Letter spacing', 'rng', -2, 12, .5], ['lh', 'Line height', 'rng', .9, 1.8, .05], ['color', 'Text colour', 'col'], ['outline', 'Outline', 'rng', 0, 10, .5], ['outlineColor', 'Outline colour', 'col'], ['shadow', 'Shadow blur', 'rng', 0, 40, 1], ['shadowColor', 'Shadow colour', 'col'], ['upper', 'Uppercase', 'chk'], ['rows', 'Max rows', 'sel', [1, 2]]],
  fBar: [['bar', 'Show bar', 'chk'], ['barColor', 'Bar colour', 'col'], ['barOpacity', 'Bar opacity', 'rng', 0, 1, .05], ['radius', 'Corner radius', 'rng', 0, 80, 1], ['padX', 'Side padding', 'rng', 0, 160, 1], ['padY', 'Vertical padding', 'rng', 0, 100, 1], ['blur', 'Background blur', 'rng', 0, 40, 1], ['accent', 'Accent stripe', 'chk'], ['accentColor', 'Accent colour', 'col'], ['fit', 'Bar width', 'sel', ['text', 'full']]],
  fPos: [['pos', 'Position', 'sel', ['left', 'center', 'right']], ['align', 'Text align', 'sel', ['left', 'center', 'right']], ['offX', 'Horizontal offset', 'rng', -800, 800, 5], ['offY', 'Distance from bottom', 'rng', 0, 700, 5], ['anim', 'Animation', 'sel', ['fade', 'slide', 'cut']], ['dur', 'Duration (ms)', 'rng', 0, 2000, 50], ['showTag', 'Show title with first line', 'chk'], ['showNext', 'Show next line preview', 'chk'], ['nextScale', 'Preview size', 'rng', .3, .9, .05]] };
function buildDesign() { Object.keys(FIELDS).forEach(id => { $('#' + id).innerHTML = FIELDS[id].map(f => { const k = f[0]; let h = '<div><label for="s_' + k + '">' + f[1] + '</label>';
  if (f[2] === 'sel') h += '<select id="s_' + k + '" data-k="' + k + '">' + f[3].map(o => '<option>' + o + '</option>').join('') + '</select>';
  else if (f[2] === 'rng') h += '<input id="s_' + k + '" data-k="' + k + '" type="range" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '">';
  else if (f[2] === 'col') h += '<input id="s_' + k + '" data-k="' + k + '" type="color">'; else h += '<input id="s_' + k + '" data-k="' + k + '" type="checkbox">'; return h + '</div>'; }).join(''); }); syncDesign(); }
function syncDesign() { $$('[id^=s_]').forEach(el => { const v = D.style[el.dataset.k]; if (v === undefined) return; if (el.type === 'checkbox') el.checked = !!v; else if (document.activeElement !== el) el.value = v; }); }
let sendT = null;
function onDesign(e) { const el = e.target; if (!el.id || el.id.indexOf('s_') !== 0) return; const k = el.dataset.k;
  D.style[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : (el.tagName === 'SELECT' && el.value !== '' && !isNaN(el.value)) ? Number(el.value) : el.value;
  persist('style'); pushLocal(); styleBusy = true; clearTimeout(sendT);
  sendT = setTimeout(async () => { if (canLive()) { try { const r = await api('/style', 'POST', { style: D.style }); D.style = Object.assign({}, DEF, r.style); persist('style'); D.set.pendStyle = false; } catch (x) { D.set.pendStyle = true; } } else D.set.pendStyle = true; persist('set'); styleBusy = false; }, 150); }
$('#v-look').addEventListener('input', onDesign); $('#v-look').addEventListener('change', onDesign);
function renderPresets() { $('#preSel').innerHTML = D.presets.length ? D.presets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') : '<option value="">No presets yet</option>'; }
$('#preSave').onclick = () => { const n = $('#preName').value.trim(); if (!n) return toast('Name the preset first'); D.presets.push({ id: uid(), name: n.slice(0, 60), style: Object.assign({}, D.style), updated: Date.now() }); $('#preName').value = ''; touch('presets'); renderPresets(); toast('Preset saved'); };
$('#preApply').onclick = () => { const p = D.presets.find(x => x.id === $('#preSel').value); if (!p) return toast('Pick a preset'); D.style = Object.assign({}, DEF, p.style); persist('style'); syncDesign(); pushLocal(); D.set.pendStyle = true; persist('set');
  if (canLive()) api('/style', 'POST', { style: D.style }).then(r => { D.style = Object.assign({}, DEF, r.style); D.set.pendStyle = false; persist('set'); persist('style'); }).catch(() => {}); toast('Preset applied'); };
$('#preDel').onclick = async () => { const id = $('#preSel').value; if (!id || !await confirmD('Delete this preset?', '')) return; tombstone(id); D.presets = D.presets.filter(p => p.id !== id); touch('presets'); renderPresets(); };

/* ---------- connect and account ---------- */
let acMode = 'reg';
function renderConnect() { const s = D.session; $('#hasSes').hidden = !s; $('#acIn').hidden = !(s && D.account); $('#acOut').hidden = !!(s && D.account);
  if (D.account) $('#acName').textContent = 'You are signed in as ' + D.account.name + '. Your songs open on every device you sign in on.';
  if (!s) return; $('#code').textContent = s.code; $('#url').textContent = location.origin + '/o/' + s.code; }
$('#acSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; acMode = b.dataset.m; $$('#acSeg button').forEach(x => x.classList.toggle('on', x === b)); $('#acP2w').hidden = acMode === 'log'; $('#acGo').textContent = acMode === 'log' ? 'Sign in' : 'Create account'; $('#acP').autocomplete = acMode === 'log' ? 'current-password' : 'new-password'; };
$('#acGo').onclick = async () => { const name = $('#acN').value.trim(), pw = $('#acP').value; if (!name || !pw) return toast('Enter a username and password');
  if (acMode === 'reg' && pw !== $('#acP2').value) return toast('The passwords do not match');
  const btn = $('#acGo'); btn.disabled = true;
  try { const j = acMode === 'log' ? await auth('login', { name, password: pw }) : await auth('register', { name, password: pw, code: D.session && D.session.code, key: D.session && D.session.key });
    D.account = { name: j.name }; persist('account'); $('#acP').value = $('#acP2').value = ''; await link({ code: j.code, key: j.key }); toast(acMode === 'log' ? 'Signed in. Syncing your songs.' : 'Account created'); }
  catch (e) { toast(e.message); } btn.disabled = false; };
const copy = t => { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied')).catch(() => { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Copy failed. Select the link and copy it.'); } a.remove(); }); };
$('#copy').onclick = () => copy(location.origin + '/o/' + D.session.code); $('#copyTxt').onclick = () => copy(location.origin + '/api/s/' + D.session.code + '/current.txt');
$('#showKey').onclick = () => { const b = $('#keyBox'); b.hidden = !b.hidden; b.textContent = D.session.key; $('#showKey').textContent = b.hidden ? 'Show control key' : 'Hide control key'; };
async function link(session) { D.session = session; persist('session'); $('#pvReal').removeAttribute('src'); renderConnect(); connect(); updStatus(); }
$('#mk').onclick = async () => { try { const r = await fetch('/api/session', { method: 'POST' }), j = await r.json(); if (!r.ok) throw new Error(j.error || 'Failed'); await link(j); toast('Session created'); } catch (e) { toast(e.message === 'Failed to fetch' ? 'You are offline. Everything else still works.' : e.message); } };
$('#jn').onclick = async () => { const code = $('#jc').value.trim().toUpperCase(), key = $('#jk').value.trim(); if (!code || !key) return toast('Enter both the code and the key');
  try { const r = await fetch('/api/s/' + code + '/data', { headers: { 'x-key': key } }); if (!r.ok) return toast('Code or key not recognised'); await link({ code, key }); toast('Joined'); } catch (e) { toast('You are offline.'); } };
$('#regen').onclick = async () => { if (!await confirmD('New output code?', 'The link in vMix stops working until you update it.', 'Change code')) return; try { const r = await api('/regenerate', 'POST'); D.session.code = r.code; persist('session'); $('#pvReal').removeAttribute('src'); renderConnect(); connect(); toast('New code ready'); } catch (e) { toast(e.message); } };
$('#leave').onclick = async () => { const r = await dlg({ title: 'Sign out?', msg: 'Your songs stay in your account. Choose whether to keep a copy on this device.', actions: [{ label: 'Sign out, keep songs here', value: 'keep', cls: 'pri' }, { label: 'Sign out and erase this device', value: 'erase', cls: 'danger' }] }); if (!r) return;
  if (ws) { ws.onclose = null; ws.close(); } ws = null; D.session = null; D.account = null; persist('session'); persist('account'); $('#pvReal').removeAttribute('src'); LV = null;
  if (r.act === 'erase') { D.songs = []; D.schedules = []; D.presets = []; D.tomb = {}; D.set = {}; SEL = null; ['songs', 'schedules', 'presets', 'tomb', 'set'].forEach(persist); }
  renderAll(); updStatus(); toast('Signed out'); };

/* ---------- views, menu, keys, boot ---------- */
function setView(v) { view = v; const g = ['sch', 'lyr', 'live'].includes(v) ? 'console' : v; document.body.dataset.v = v; document.body.dataset.g = g;
  $$('.bnav button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); $$('.dtabs button').forEach(b => b.classList.toggle('on', b.dataset.g === g));
  setTimeout(fitMon, 30); if (!(v === 'lyr' && innerWidth >= 1000)) window.scrollTo(0, 0); }
$$('.bnav button').forEach(b => b.onclick = () => setView(b.dataset.v));
$$('.dtabs button').forEach(b => b.onclick = () => setView(b.dataset.g === 'console' ? 'lyr' : b.dataset.g));
$('#pill').onclick = () => setView('connect');
$('#gear').onclick = () => sheet('Menu', [{ label: 'Look and feel', sub: 'Font, bar, position and presets', icon: 'edit', fn: () => setView('look') }, { label: 'Connect and account', sub: 'vMix link and sign in', icon: 'live', fn: () => setView('connect') },
  { label: 'Switch light or dark', icon: 'eye', fn: () => { const d = document.documentElement, n = d.dataset.theme === 'light' ? 'dark' : 'light'; d.dataset.theme = n; D.set.theme = n; persist('set'); } }]);
addEventListener('keydown', e => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !$('#layer').hidden) { if (e.key === 'Escape' && !$('#layer').hidden) layerCancel(); return; }
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); step(1); } else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'h' || e.key === 'H' || e.key === 'Escape') setVisible(false); else if (e.key === 's' || e.key === 'S') setVisible(true); else if (e.key === 'f' || e.key === 'F') doFreeze();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const sc = curSched(); if (!sc || !sc.items.length) return; const i = sc.items.findIndex(x => SEL && refKey(x) === SEL.key), n = sc.items[i < 0 ? 0 : Math.max(0, Math.min(sc.items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) select(n, n.id); }
  else if (e.key === '/') { e.preventDefault(); setView('sch'); $('#sq').focus(); } });
let wl = null; const wake = () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') navigator.wakeLock.request('screen').then(l => { wl = l; }).catch(() => {}); } catch (e) {} };
document.addEventListener('visibilitychange', wake);
addEventListener('online', () => { $('#banner').classList.remove('on'); if (D.session) connect(); });
addEventListener('offline', () => { $('#banner').textContent = 'You are offline. Songs and schedules still work and are saved on this device.'; $('#banner').classList.add('on'); updStatus(); });
addEventListener('resize', fitMon); if (window.ResizeObserver) { const ro = new ResizeObserver(fitMon); ['#mon1', '#mon3'].forEach(s => ro.observe($(s))); }
$('#pvLocal2').addEventListener('load', () => post($('#pvLocal2'), $('#pvLocal2')._p || { line: '', visible: false, style: D.style }));
function renderAll() { renderSchedule(); renderSongs(); renderPresets(); renderConnect(); renderSearch(); if (SEL) SEL.m = modelOf(SEL.ref); if (LV) LV.m = modelOf(LV.ref); renderLyrics(); renderLive(); updStatus(); }
(async () => {
  await loadAll(); if (D.set.theme) document.documentElement.dataset.theme = D.set.theme;
  $('#pvLocal2').src = '/o/LOCAL?local=1'; buildDesign();
  const sc = curSched(); if (sc && sc.items[0]) { SEL = { ref: sc.items[0], m: modelOf(sc.items[0]), key: refKey(sc.items[0]), itemId: sc.items[0].id }; }
  renderAll(); setView(innerWidth < 1000 && sc && sc.items.length ? 'sch' : 'lyr'); wake();
  if (D.draft && (D.draft.text || D.draft.title)) { const s = D.draft.id && findSong(D.draft.id); setView('songs'); openEd(s || null, D.draft); }
  if (D.session) connect(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
