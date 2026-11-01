'use strict';
/* LyricCast controller. Local-first: songs, schedules and presets live on this device (IndexedDB)
   and work offline. A linked session only carries the live line to vMix and a merged backup. */
const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
const DEF = { font: 'sans', weight: 700, size: 64, spacing: 0, lh: 1.15, color: '#ffffff', upper: false, outline: 0, outlineColor: '#000000', shadow: 12, shadowColor: '#000000',
  bar: true, barColor: '#0b0b14', barOpacity: 0.78, radius: 14, padX: 44, padY: 22, blur: 0, accent: true, accentColor: '#d4a84b', fit: 'text', pos: 'center', align: 'center',
  offX: 0, offY: 90, anim: 'fade', dur: 300, rows: 1, showTag: false, showNext: false, nextScale: 0.55 };
const D = { songs: [], schedules: [], presets: [], tomb: {}, set: {}, style: Object.assign({}, DEF), session: null, draft: null };
const KEYS = ['songs', 'schedules', 'presets', 'tomb', 'set', 'style', 'session', 'draft'];
let ws = null, wsFails = 0, outputs = 0, lat = null, serverLive = { visible: false }, libRev = -1, pingT = null, online = false;
let PV = null, LV = null, frozen = false, ED = null, syncing = false, syncAgain = false, syncState = '', linking = false;

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
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14));
const hue = s => { s = String(s).toLowerCase().replace(/\d+/g, '').trim(); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} };
const canLive = () => !!(D.session && ws && ws.readyState === 1);
const findSong = id => D.songs.find(s => s.id === id);
const curSched = () => D.schedules.find(s => s.id === D.set.sched) || D.schedules[0] || null;
function touch(key, obj) { if (obj) obj.updated = Date.now(); persist(key); syncSoon(); }
function tombstone(id) { D.tomb[id] = Date.now(); persist('tomb'); }

/* ---------- song parsing ---------- */
const LBL = /^\[(.+)\]$|^(verse|chorus|pre-?chorus|bridge|intro|outro|tag|interlude|ending|refrain|hook|coda|vamp)\s*\d*\s*:?$/i;
function sections(text) {
  const lines = String(text || '').split('\n'), out = [], hasLbl = lines.some(l => LBL.test(l.trim()));
  let cur = null, part = 0;
  const start = name => { cur = { name, lines: [] }; out.push(cur); };
  for (const raw of lines) { const t = raw.trim();
    if (!t) { if (!hasLbl && cur && cur.lines.length) cur = null; continue; }
    const m = t.match(LBL); if (m) { start((m[1] || t).replace(/:$/, '').trim()); continue; }
    if (!cur) start(hasLbl ? 'Lyrics' : 'Part ' + (++part));
    cur.lines.push(t); }
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
  const j = await r.json().catch(() => ({})); return { r, j };
}
async function api(path, method, body, noRestore) {
  if (!D.session) throw new Error('Not linked to vMix yet');
  let { r, j } = await raw(path, method, body);
  if (r.status === 401 && !noRestore) { if (await restore()) ({ r, j } = await raw(path, method, body)); }
  if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
}
// If the host lost its data (free hosts restart), re-register the same code and key, then re-send our style.
async function restore() {
  try { const r = await fetch('/api/session/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(D.session) }); const j = await r.json();
    if (!r.ok) return false; if (j.fresh) await raw('/style', 'POST', { style: D.style }); return true; } catch (e) { return false; }
}

/* ---------- library sync (merge both ways; nothing is overwritten blindly) ---------- */
const mergeCol = (a, b, tomb) => { const m = new Map(); a.concat(b || []).forEach(x => { const o = m.get(x.id); if (!o || x.updated > o.updated) m.set(x.id, x); });
  return Array.from(m.values()).filter(x => !(tomb[x.id] >= x.updated)); };
function mergeIn(lib) {
  const before = JSON.stringify([D.songs, D.schedules, D.presets]);
  Object.keys(lib.tomb || {}).forEach(k => { D.tomb[k] = Math.max(D.tomb[k] || 0, lib.tomb[k]); });
  D.songs = mergeCol(D.songs, lib.songs, D.tomb); D.schedules = mergeCol(D.schedules, lib.schedules, D.tomb); D.presets = mergeCol(D.presets, lib.presets, D.tomb);
  if (before !== JSON.stringify([D.songs, D.schedules, D.presets])) { ['songs', 'schedules', 'presets', 'tomb'].forEach(persist); renderAll(); }
}
let syncT = null; function syncSoon() { clearTimeout(syncT); syncT = setTimeout(sync, 1200); }
async function sync() {
  if (!canLive()) { syncState = D.session ? 'Saved on this device. Will sync when online.' : 'Saved on this device.'; return updStatus(); }
  if (syncing) { syncAgain = true; return; } syncing = true;
  try { const r = await api('/library', 'PUT', { lib: { songs: D.songs, schedules: D.schedules, presets: D.presets, tomb: D.tomb } }); libRev = r.rev; mergeIn(r.lib); syncState = 'Saved on this device and backed up to the server.'; }
  catch (e) { syncState = 'Saved on this device. Backup pending.'; }
  syncing = false; updStatus(); if (syncAgain) { syncAgain = false; sync(); }
}

/* ---------- realtime ---------- */
function connect() {
  if (!D.session || linking) return; clearTimeout(connect.t);
  if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?code=' + D.session.code + '&role=control&key=' + encodeURIComponent(D.session.key));
  ws.onopen = async () => { wsFails = 0; $('#banner').classList.remove('on'); clearInterval(pingT); ping(); pingT = setInterval(ping, 5000); updStatus(); await afterConnect(); };
  ws.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; }
    if (d.t === 'state') { serverLive = d.state; const ns = JSON.stringify(d.state.style); if (ns !== JSON.stringify(D.style) && !styleBusy) { D.style = Object.assign({}, DEF, d.state.style); persist('style'); syncDesign(); pushLocal(); } updClear(); }
    else if (d.t === 'presence') { outputs = d.outputs; updStatus(); }
    else if (d.t === 'pong') { lat = Date.now() - d.ts; updStatus(); }
    else if (d.t === 'lib' && d.rev !== libRev) sync(); };
  ws.onclose = async e => { clearInterval(pingT); updStatus();
    if (e.code === 4001) { $('#banner').textContent = 'The control key was rejected. Unlink and join again.'; $('#banner').classList.add('on'); return; }
    if (e.code === 4004) await restore();
    const wait = Math.min(500 * Math.pow(2, wsFails++), 8000); if (wsFails > 1) { $('#banner').textContent = 'vMix link lost. Your songs are safe. Reconnecting.'; $('#banner').classList.add('on'); }
    connect.t = setTimeout(connect, wait); };
}
const ping = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })); };
async function afterConnect() {
  try { const d = await api('/data'); serverLive = d.state;
    if (D.set.pendStyle) { const r = await api('/style', 'POST', { style: D.style }); D.style = r.style; D.set.pendStyle = false; persist('set'); }
    else { D.style = Object.assign({}, DEF, d.state.style); }
    persist('style'); libRev = d.libRev; mergeIn(d.lib); syncDesign(); pushLocal(); updClear(); await sync(); if (!$('#pvReal').src) $('#pvReal').src = '/o/' + D.session.code + '?preview=1'; renderLive();
  } catch (e) { toast(e.message); }
}
function updStatus() {
  const on = canLive();
  $('#cdot').className = 'dot' + (!D.session ? '' : on ? (outputs ? ' ok' : ' mid') : '');
  $('#ctext').textContent = !D.session ? 'Not linked to vMix' : !on ? 'Offline' : outputs ? outputs + (outputs === 1 ? ' output live' : ' outputs live') : 'No output yet';
  const s = $('#stat'); if (s) s.textContent = (on ? 'Connected to server' + (lat != null ? ' (' + lat + ' ms)' : '') : 'Not connected') + '. ' + (outputs ? outputs + (outputs === 1 ? ' vMix output is' : ' outputs are') + ' connected.' : 'No output connected yet. Open the link in vMix.') + ' ' + syncState;
  const st = $('#store'); if (st) st.textContent = D.songs.length + ' songs, ' + D.schedules.length + ' schedules and ' + D.presets.length + ' presets are stored on this device and work offline. ' + (syncState || '');
  const ov = $('#monOv'); if (ov) { ov.hidden = on; ov.textContent = !D.session ? 'Not linked to vMix. Open Connect to create a session.' : 'Offline. Lines cannot be sent until the link returns.'; }
  ['#goLive', '#next', '#prev', '#clear'].forEach(s => { const b = $(s); if (b) b.title = on ? '' : 'Link to vMix to send lines'; });
}

/* ---------- local preview frames ---------- */
function post(frame, payload) { frame._p = payload; try { frame.contentWindow.postMessage({ lc: 1, state: payload }, location.origin); } catch (e) {} }
function payloadFor(m, i) {
  const s = m && m.slides[i]; if (!s) return { line: '', visible: false, style: D.style };
  return { line: s.text, next: m.slides[i + 1] ? m.slides[i + 1].text : '', title: m.title, artist: m.artist, tag: m.kind === 'song' && i === 0, visible: true, style: D.style };
}
function pushLocal() { const p = payloadFor(PV && PV.m, PV ? PV.sel : 0); post($('#pvLocal'), p);
  post($('#pvLocal2'), p.visible ? p : { line: 'Your lyric line appears here', next: '', title: '', artist: '', tag: false, visible: true, style: D.style }); }
function fitMon() { [['#mon1', '#pvReal'], ['#mon2', '#pvLocal'], ['#mon3', '#pvLocal2']].forEach(p => { const m = $(p[0]); if (m && m.clientWidth) $(p[1]).style.transform = 'scale(' + (m.clientWidth / 1920) + ')'; }); }

/* ---------- slides rendering ---------- */
function gridHtml(m, active, next) {
  if (!m || !m.slides.length) return '<div class="empty"><b>No lines</b>' + (m && m.gone ? 'This song was removed from the library.' : 'Add lyrics to this item.') + '</div>';
  let h = '', last = -1;
  m.slides.forEach((s, i) => { if (s.sec && s.pos !== last) { last = s.pos; h += '<div class="lbl" style="color:hsl(' + hue(s.sec) + ',70%,62%);border-color:currentColor">' + esc(s.sec) + '</div>'; }
    h += '<button class="sl' + (i === active ? ' on' : '') + (i === next ? ' nx' : '') + '" data-i="' + i + '">' + esc(s.text) + '</button>'; });
  return h;
}
function renderPrev() {
  const m = PV && PV.m; $('#pvTitle').textContent = m ? m.title : 'Nothing staged'; $('#goLive').disabled = !m || !m.slides.length;
  $('#prevSlides').innerHTML = m ? gridHtml(m, PV.sel, -1) : '<div class="empty"><b>Nothing staged</b>Tap a schedule item or a song to preview it here.</div>'; pushLocal();
}
function renderLive() {
  const m = LV && LV.m; $('#lvTitle').textContent = m ? m.title : 'Nothing live';
  $('#liveSlides').innerHTML = m ? gridHtml(m, LV.idx, LV.idx + 1) : '<div class="empty"><b>Nothing live</b>Stage an item in Preview, then press Go Live.</div>';
  let chips = '', seen = {}; if (m) m.slides.forEach((s, i) => { if (s.sec && !seen[s.pos]) { seen[s.pos] = 1; chips += '<button class="chip" data-i="' + i + '" style="color:hsl(' + hue(s.sec) + ',70%,62%)">' + esc(s.sec) + '</button>'; } });
  $('#chips').innerHTML = chips; markItems(); updClear();
  const a = $('#liveSlides .sl.on'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function updClear() { const v = serverLive && serverLive.visible; $('#clear').textContent = v ? 'Clear' : 'Show'; $('#clear').classList.toggle('act', !!v); }
function showPane(p) { $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.p === p)); $('#p-live').classList.toggle('on', p === 'live'); $('#p-prev').classList.toggle('on', p === 'prev'); setTimeout(fitMon, 20); }

/* ---------- staging and going live ---------- */
function stage(ref, itemId) { PV = { ref, m: modelOf(ref), sel: 0, itemId: itemId || null }; renderPrev(); markItems(); }
async function sendLine(i, force) {
  const m = LV.m, s = m.slides[i]; if (!s) return;
  if (frozen && !force) { LV.idx = i; renderLive(); return toast('Frozen. Output is held. Tap Freeze to release.'); }
  if (!canLive()) return toast('Not connected to vMix. Your songs still work offline.');
  LV.idx = i; renderLive(); buzz();
  try { await api('/live', 'POST', { line: s.text, next: m.slides[i + 1] ? m.slides[i + 1].text : '', title: m.title, artist: m.artist, tag: m.kind === 'song' && i === 0, visible: true }); }
  catch (e) { toast(e.message); }
}
function goLive() { if (!PV || !PV.m.slides.length) return; if (!canLive()) return toast('Not connected to vMix. Open Connect to link a session.');
  LV = { ref: PV.ref, m: PV.m, idx: -1, itemId: PV.itemId }; showPane('live'); sendLine(PV.sel); }
function stageNext(fromId) { const sc = curSched(); if (!sc) return false; const i = sc.items.findIndex(x => x.id === fromId); const n = sc.items[i + 1]; if (i < 0 || !n) return false; stage(n, n.id); return true; }
function step(d) {
  if (!LV) { if (PV && d > 0) goLive(); return; }
  const i = LV.idx + d; if (i < 0) return sendLine(0);
  if (i >= LV.m.slides.length) { const ok = stageNext(LV.itemId); toast(ok ? 'End of item. Next item is staged in Preview.' : 'End of item.'); if (ok) showPane('prev'); return; }
  sendLine(i);
}
async function doClear() { if (!canLive()) return toast('Not connected to vMix.'); buzz(); try { await api('/live', 'POST', { visible: !(serverLive && serverLive.visible) }); } catch (e) { toast(e.message); } }
function doFreeze() { frozen = !frozen; $('#freeze').textContent = frozen ? 'Release' : 'Freeze'; $('#freeze').classList.toggle('act', frozen); if (!frozen && LV && LV.idx >= 0) sendLine(LV.idx, true); }
$('#liveSlides').onclick = e => { const b = e.target.closest('.sl'); if (b && LV) sendLine(+b.dataset.i); };
$('#chips').onclick = e => { const b = e.target.closest('.chip'); if (b && LV) sendLine(+b.dataset.i); };
$('#prevSlides').onclick = e => { const b = e.target.closest('.sl'); if (!b || !PV) return; const i = +b.dataset.i;
  if (PV.sel === i && b._t && Date.now() - b._t < 450) { goLive(); return; } PV.sel = i; b._t = Date.now(); renderPrev(); };
$('#goLive').onclick = goLive; $('#next').onclick = () => step(1); $('#prev').onclick = () => step(-1); $('#clear').onclick = doClear; $('#freeze').onclick = doFreeze;
$$('#seg button').forEach(b => b.onclick = () => showPane(b.dataset.p));
(() => { let x0 = null, y0 = null; const el = $('#mon1'); el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (Math.abs(dy) > 90) { const sc = curSched(); if (sc && LV) { const i = sc.items.findIndex(x => x.id === LV.itemId), n = sc.items[i + (dy < 0 ? 1 : -1)]; if (n) { stage(n, n.id); showPane('prev'); } } } }, { passive: true }); })();

/* ---------- schedule ---------- */
function markItems() { $$('#schItems .it').forEach(el => { el.classList.toggle('pv', !!PV && PV.itemId === el.dataset.id); el.classList.toggle('lv', !!LV && LV.itemId === el.dataset.id); }); }
function renderSchedule() {
  $('#schSel').innerHTML = D.schedules.length ? D.schedules.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('') : '<option value="">No schedules yet</option>';
  const sc = curSched(); if (sc) $('#schSel').value = sc.id;
  ['#schRen', '#schDup', '#schDel'].forEach(s => $(s).disabled = !sc);
  if (!sc) { $('#schItems').innerHTML = '<div class="card empty"><b>Build your service</b>Create a schedule, then add songs and text items in the order you will use them.</div>'; return; }
  $('#schItems').innerHTML = sc.items.length ? sc.items.map((it, i) => { const m = modelOf(it);
    return '<div class="it" data-id="' + esc(it.id) + '"><button class="main" data-a="stage"><span class="n">' + (i + 1) + '</span><div><b>' + esc(m.title) + '</b><span class="s">' + (it.type === 'text' ? 'Text' : esc(m.artist || 'Song')) + ' \u00b7 ' + m.slides.length + ' lines' + (it.note ? ' \u00b7 ' + esc(it.note) : '') + '</span></div></button>' +
      '<div class="acts"><button class="sm pri" data-a="live">Go Live</button><button class="sm" data-a="up" aria-label="Move up">\u2191</button><button class="sm" data-a="dn" aria-label="Move down">\u2193</button><button class="sm" data-a="note">Note</button>' + (it.type === 'text' ? '<button class="sm" data-a="edit">Edit</button>' : '') + '<button class="sm bad" data-a="rm" aria-label="Remove">\u2715</button></div></div>'; }).join('')
    : '<div class="card empty"><b>This schedule is empty</b>Add a song or a text item below.</div>';
  markItems();
}
function ensureSched() { let sc = curSched(); if (!sc) { sc = { id: uid(), name: 'Service ' + new Date().toLocaleDateString(), items: [], updated: Date.now() }; D.schedules.push(sc); D.set.sched = sc.id; persist('set'); } return sc; }
function addItem(it) { const sc = ensureSched(); sc.items.push(Object.assign({ id: uid(), note: '' }, it)); touch('schedules', sc); renderSchedule(); }
$('#schSel').onchange = function () { D.set.sched = this.value; persist('set'); renderSchedule(); };
$('#schNew').onclick = () => { const n = prompt('Schedule name', 'Service ' + new Date().toLocaleDateString()); if (!n) return; const sc = { id: uid(), name: n.trim().slice(0, 120), items: [], updated: Date.now() }; D.schedules.push(sc); D.set.sched = sc.id; persist('set'); touch('schedules'); renderSchedule(); };
$('#schRen').onclick = () => { const sc = curSched(); if (!sc) return; const n = prompt('Schedule name', sc.name); if (!n) return; sc.name = n.trim().slice(0, 120); touch('schedules', sc); renderSchedule(); };
$('#schDup').onclick = () => { const sc = curSched(); if (!sc) return; const c = JSON.parse(JSON.stringify(sc)); c.id = uid(); c.name = sc.name + ' copy'; c.items.forEach(i => i.id = uid()); c.updated = Date.now(); D.schedules.push(c); D.set.sched = c.id; persist('set'); touch('schedules'); renderSchedule(); };
$('#schDel').onclick = () => { const sc = curSched(); if (!sc || !confirm('Delete schedule "' + sc.name + '"? Songs stay in your library.')) return; tombstone(sc.id); D.schedules = D.schedules.filter(s => s.id !== sc.id); D.set.sched = ''; persist('set'); touch('schedules'); renderSchedule(); };
$('#schItems').onclick = e => { const b = e.target.closest('button'); if (!b) return; const row = b.closest('.it'), sc = curSched(), i = sc.items.findIndex(x => x.id === row.dataset.id), it = sc.items[i], a = b.dataset.a;
  if (a === 'stage') { stage(it, it.id); showPane('prev'); if (innerWidth < 1000) tab('live'); }
  else if (a === 'live') { stage(it, it.id); goLive(); if (innerWidth < 1000) tab('live'); }
  else if (a === 'up' && i > 0) { sc.items.splice(i - 1, 0, sc.items.splice(i, 1)[0]); touch('schedules', sc); renderSchedule(); }
  else if (a === 'dn' && i < sc.items.length - 1) { sc.items.splice(i + 1, 0, sc.items.splice(i, 1)[0]); touch('schedules', sc); renderSchedule(); }
  else if (a === 'note') { const n = prompt('Note for this item (for example the order of verses). Leave empty to clear.', it.note || ''); if (n === null) return; it.note = n.trim().slice(0, 300); touch('schedules', sc); renderSchedule(); }
  else if (a === 'edit') openTxt(it);
  else if (a === 'rm') { sc.items.splice(i, 1); touch('schedules', sc); renderSchedule(); } };
let txtEdit = null;
function openTxt(it) { txtEdit = it || null; $('#xT').value = it ? it.title : ''; $('#xB').value = it ? it.text : ''; $('#xS').textContent = it ? 'Save changes' : 'Add to schedule'; $('#txtForm').hidden = false; $('#picker').hidden = true; $('#xT').focus(); }
$('#addText').onclick = () => openTxt(null); $('#xC').onclick = () => { $('#txtForm').hidden = true; };
$('#xS').onclick = () => { const t = $('#xT').value.trim(), b = $('#xB').value.trim(); if (!b) return toast('Type the text to project');
  if (txtEdit) { txtEdit.title = t || 'Text'; txtEdit.text = b; const sc = curSched(); touch('schedules', sc); renderSchedule(); } else addItem({ type: 'text', title: t || 'Text', text: b });
  $('#txtForm').hidden = true; toast('Saved'); };
$('#addSong').onclick = () => { $('#picker').hidden = !$('#picker').hidden; $('#txtForm').hidden = true; renderPicker(); };
function renderPicker() { const q = $('#pq').value.trim().toLowerCase(), l = D.songs.filter(s => !q || (s.title + ' ' + s.artist).toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title));
  $('#pList').innerHTML = l.length ? l.map(s => '<div class="song" data-id="' + esc(s.id) + '"><div class="t"><b>' + esc(s.title) + '</b><span>' + esc(s.artist || 'No artist') + '</span></div><button class="sm pri" data-a="add">Add</button></div>').join('') : '<div class="empty">' + (D.songs.length ? 'No matches.' : 'No songs yet. Add one in the Songs tab.') + '</div>'; }
$('#pq').oninput = renderPicker;
$('#pList').onclick = e => { const b = e.target.closest('[data-a=add]'); if (!b) return; addItem({ type: 'song', songId: b.closest('.song').dataset.id }); toast('Added to schedule'); };

/* ---------- songs ---------- */
function renderSongs() {
  const q = $('#q').value.trim().toLowerCase(), l = D.songs.filter(s => !q || (s.title + ' ' + s.artist).toLowerCase().includes(q)).sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.title.localeCompare(b.title));
  $('#songs').innerHTML = l.length ? l.map(s => '<div class="song" data-id="' + esc(s.id) + '"><button class="t" data-a="stage"><b>' + esc(s.title) + '</b><span>' + esc(s.artist || 'No artist') + '</span></button><button class="sm star' + (s.fav ? ' f' : '') + '" data-a="fav" aria-label="Favourite">' + (s.fav ? '\u2605' : '\u2606') + '</button><button class="sm" data-a="sched" aria-label="Add to schedule">+ Sched</button><button class="sm" data-a="edit">Edit</button><button class="sm bad" data-a="del" aria-label="Delete">\u2715</button></div>').join('')
    : '<div class="empty"><b>' + (D.songs.length ? 'No matches' : 'Your library is empty') + '</b>' + (D.songs.length ? 'Try a different search.' : 'Add your first song. It is saved on this device and works offline.') + '</div>';
  renderPicker(); updStatus();
}
$('#q').oninput = renderSongs;
$('#songs').onclick = e => { const b = e.target.closest('button'); if (!b) return; const id = b.closest('.song').dataset.id, s = findSong(id), a = b.dataset.a;
  if (a === 'stage') { stage({ type: 'song', songId: id }); showPane('prev'); if (innerWidth < 1000) tab('live'); }
  else if (a === 'fav') { s.fav = !s.fav; touch('songs', s); renderSongs(); }
  else if (a === 'sched') { addItem({ type: 'song', songId: id }); toast('Added to schedule'); }
  else if (a === 'edit') openEd(s);
  else if (a === 'del') { const used = D.schedules.some(sc => sc.items.some(i => i.songId === id)); if (!confirm('Delete "' + s.title + '"?' + (used ? ' It is used in a schedule.' : ''))) return; tombstone(id); D.songs = D.songs.filter(x => x.id !== id); persist('songs'); syncSoon(); renderAll(); } };

/* song editor with autosaved draft */
const LBLS = ['Verse 1', 'Verse 2', 'Verse 3', 'Chorus', 'Pre-Chorus', 'Bridge', 'Intro', 'Outro', 'Tag'];
function openEd(s, draft) {
  ED = { id: s ? s.id : null, arr: draft ? draft.arr : (s ? s.arrangement : null) };
  $('#edTitle').textContent = s ? 'Edit song' : 'New song'; $('#eT').value = draft ? draft.title : s ? s.title : ''; $('#eA').value = draft ? draft.artist : s ? s.artist : ''; $('#eL').value = draft ? draft.text : s ? s.text : '';
  $('#edNote').hidden = !draft; $('#edNote').textContent = 'Recovered your unsaved work. Save the song to keep it.';
  $('#lblChips').innerHTML = LBLS.map(l => '<button class="chip" data-l="' + l + '" style="color:hsl(' + hue(l) + ',70%,62%)">[' + l + ']</button>').join('');
  $('#libList').hidden = true; $('#libEdit').hidden = false; edInfo(); window.scrollTo(0, 0);
}
function closeEd() { clearTimeout(draftT); ED = null; D.draft = null; persist('draft'); $('#libEdit').hidden = true; $('#libList').hidden = false; }
function edInfo() { const secs = sections($('#eL').value), n = secs.reduce((a, s) => a + s.lines.length, 0); $('#eCount').textContent = n + (n === 1 ? ' line' : ' lines') + ' in ' + secs.length + (secs.length === 1 ? ' section' : ' sections') + ' will be projected';
  const auto = !validArr(ED.arr, secs.length), arr = auto ? secs.map((_, i) => i) : ED.arr;
  $('#arrNow').innerHTML = arr.length ? arr.map((si, p) => '<button class="chip" data-p="' + p + '" style="color:hsl(' + hue(secs[si].name) + ',70%,62%)">' + esc(secs[si].name) + ' \u2715</button>').join('') : '<span class="m">Add sections below.</span>';
  $('#arrAdd').innerHTML = secs.map((s, i) => '<button class="chip" data-s="' + i + '" style="color:hsl(' + hue(s.name) + ',70%,62%)">+ ' + esc(s.name) + '</button>').join('');
  $('#arrNote').textContent = auto ? 'The order follows your lyrics. Tap a section below to repeat it, or tap one above to remove it.' : 'Custom order for this song.'; $('#arrReset').hidden = auto; }
let draftT = null;
function draftSave() { if (!ED) return; clearTimeout(draftT); draftT = setTimeout(() => { if (!ED) return; D.draft = { id: ED.id, title: $('#eT').value, artist: $('#eA').value, text: $('#eL').value, arr: ED.arr }; persist('draft'); }, 350); }
['#eT', '#eA', '#eL'].forEach(s => $(s).addEventListener('input', () => { edInfo(); draftSave(); }));
$('#lblChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const ta = $('#eL'), t = '[' + b.dataset.l + ']\n', p = ta.selectionStart, v = ta.value, pre = p && v[p - 1] !== '\n' ? '\n' : '';
  ta.value = v.slice(0, p) + pre + t + v.slice(ta.selectionEnd); ta.focus(); ta.selectionStart = ta.selectionEnd = p + pre.length + t.length; edInfo(); draftSave(); };
$('#arrNow').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const secs = sections($('#eL').value); let arr = validArr(ED.arr, secs.length) || secs.map((_, i) => i); arr = arr.slice(); arr.splice(+b.dataset.p, 1); ED.arr = arr.length ? arr : []; edInfo(); draftSave(); };
$('#arrAdd').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const secs = sections($('#eL').value); const arr = (validArr(ED.arr, secs.length) || (Array.isArray(ED.arr) ? [] : secs.map((_, i) => i))).slice(); arr.push(+b.dataset.s); ED.arr = arr; edInfo(); draftSave(); };
$('#arrReset').onclick = () => { ED.arr = null; edInfo(); draftSave(); };
$('#newSong').onclick = () => openEd(null); $('#eCancel').onclick = closeEd;
$('#eSave').onclick = () => {
  const t = $('#eT').value.trim(), a = $('#eA').value.trim(), text = $('#eL').value.replace(/\r\n?/g, '\n'); if (!t) return toast('Give the song a title'); if (!text.trim()) return toast('Add some lyrics first');
  if (!ED.id && D.songs.some(s => s.title.toLowerCase() === t.toLowerCase() && s.artist.toLowerCase() === a.toLowerCase()) && !confirm('A song with this title and artist already exists. Save anyway?')) return;
  const secs = sections(text), arr = validArr(ED.arr, secs.length); let s = ED.id && findSong(ED.id);
  if (s) { Object.assign(s, { title: t, artist: a, text, arrangement: arr }); } else { s = { id: uid(), title: t, artist: a, text, arrangement: arr, fav: false }; D.songs.push(s); }
  touch('songs', s); closeEd(); renderAll(); toast('Song saved on this device');
  if (PV && PV.ref.songId === s.id) stage(PV.ref, PV.itemId); if (LV && LV.ref.songId === s.id) { LV.m = modelOf(LV.ref); renderLive(); } };
const pickFile = inp => new Promise(res => { inp.onchange = () => { res(Array.from(inp.files)); inp.value = ''; }; inp.click(); });
$('#impTxt').onclick = async () => { const fs = await pickFile($('#fTxt')); let n = 0; for (const f of fs) { const text = (await f.text()).replace(/\r\n?/g, '\n').slice(0, 30000); if (!text.trim()) continue; const s = { id: uid(), title: f.name.replace(/\.txt$/i, ''), artist: '', text, arrangement: null, fav: false, updated: Date.now() }; D.songs.push(s); n++; }
  persist('songs'); syncSoon(); renderAll(); toast(n + ' imported'); };
async function restoreFile() { const fs = await pickFile($('#fJson')); if (!fs[0]) return; try { const j = JSON.parse(await fs[0].text()); const now = Date.now();
  const songs = (j.songs || []).map(s => ({ id: s.id || uid(), title: String(s.title || 'Untitled'), artist: String(s.artist || ''), text: String(s.text != null ? s.text : s.lyrics || ''), arrangement: Array.isArray(s.arrangement) ? s.arrangement : null, fav: !!s.fav, updated: s.updated || now }));
  D.songs = mergeCol(D.songs, songs, D.tomb); D.schedules = mergeCol(D.schedules, j.schedules || [], D.tomb); D.presets = mergeCol(D.presets, (j.presets || []).map(p => Object.assign({ updated: now }, p)), D.tomb);
  ['songs', 'schedules', 'presets'].forEach(persist); syncSoon(); renderAll(); toast('Backup restored'); } catch (e) { toast('That file is not a valid backup'); } }
$('#impJson').onclick = restoreFile; $('#expImp').onclick = restoreFile;
$('#expAll').onclick = () => { if (!D.songs.length && !D.schedules.length) return toast('Nothing to export yet'); const b = new Blob([JSON.stringify({ app: 'lyriccast', v: 2, songs: D.songs, schedules: D.schedules, presets: D.presets }, null, 1)], { type: 'application/json' }), a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'lyriccast-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };

/* ---------- design studio ---------- */
const FIELDS = {
  fText: [['font', 'Font', 'sel', ['sans', 'serif', 'mono', 'rounded', 'condensed', 'display']], ['weight', 'Weight', 'rng', 300, 900, 100], ['size', 'Size', 'rng', 24, 160, 1], ['spacing', 'Letter spacing', 'rng', -2, 12, .5], ['lh', 'Line height', 'rng', .9, 1.8, .05], ['color', 'Text colour', 'col'], ['outline', 'Outline', 'rng', 0, 10, .5], ['outlineColor', 'Outline colour', 'col'], ['shadow', 'Shadow blur', 'rng', 0, 40, 1], ['shadowColor', 'Shadow colour', 'col'], ['upper', 'Uppercase', 'chk'], ['rows', 'Max rows', 'sel', [1, 2]]],
  fBar: [['bar', 'Show bar', 'chk'], ['barColor', 'Bar colour', 'col'], ['barOpacity', 'Bar opacity', 'rng', 0, 1, .05], ['radius', 'Corner radius', 'rng', 0, 80, 1], ['padX', 'Side padding', 'rng', 0, 160, 1], ['padY', 'Vertical padding', 'rng', 0, 100, 1], ['blur', 'Background blur', 'rng', 0, 40, 1], ['accent', 'Accent stripe', 'chk'], ['accentColor', 'Accent colour', 'col'], ['fit', 'Bar width', 'sel', ['text', 'full']]],
  fPos: [['pos', 'Position', 'sel', ['left', 'center', 'right']], ['align', 'Text align', 'sel', ['left', 'center', 'right']], ['offX', 'Horizontal offset', 'rng', -800, 800, 5], ['offY', 'Distance from bottom', 'rng', 0, 700, 5], ['anim', 'Animation', 'sel', ['fade', 'slide', 'cut']], ['dur', 'Duration (ms)', 'rng', 0, 2000, 50], ['showTag', 'Show title with first line', 'chk'], ['showNext', 'Show next line preview', 'chk'], ['nextScale', 'Preview size', 'rng', .3, .9, .05]] };
function buildDesign() { Object.keys(FIELDS).forEach(id => { $('#' + id).innerHTML = FIELDS[id].map(f => { const k = f[0]; let h = '<div><label for="s_' + k + '">' + f[1] + '</label>';
  if (f[2] === 'sel') h += '<select id="s_' + k + '" data-k="' + k + '">' + f[3].map(o => '<option>' + o + '</option>').join('') + '</select>';
  else if (f[2] === 'rng') h += '<input id="s_' + k + '" data-k="' + k + '" type="range" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '">';
  else if (f[2] === 'col') h += '<input id="s_' + k + '" data-k="' + k + '" type="color">'; else h += '<input id="s_' + k + '" data-k="' + k + '" type="checkbox">'; return h + '</div>'; }).join(''); }); syncDesign(); }
function syncDesign() { $$('[id^=s_]').forEach(el => { const v = D.style[el.dataset.k]; if (v === undefined) return; if (el.type === 'checkbox') el.checked = !!v; else if (document.activeElement !== el) el.value = v; }); }
let sendT = null, styleBusy = false;
function onDesign(e) { const el = e.target; if (!el.id || el.id.indexOf('s_') !== 0) return; const k = el.dataset.k;
  D.style[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : (el.tagName === 'SELECT' && el.value !== '' && !isNaN(el.value)) ? Number(el.value) : el.value;
  persist('style'); pushLocal(); styleBusy = true; clearTimeout(sendT);
  sendT = setTimeout(async () => { if (canLive()) { try { const r = await api('/style', 'POST', { style: D.style }); D.style = Object.assign({}, DEF, r.style); persist('style'); D.set.pendStyle = false; } catch (x) { D.set.pendStyle = true; } } else D.set.pendStyle = true; persist('set'); styleBusy = false; }, 150); }
$('#t-des').addEventListener('input', onDesign); $('#t-des').addEventListener('change', onDesign);
function renderPresets() { $('#preSel').innerHTML = D.presets.length ? D.presets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') : '<option value="">No presets yet</option>'; }
$('#preSave').onclick = () => { const n = $('#preName').value.trim(); if (!n) return toast('Name the preset first'); D.presets.push({ id: uid(), name: n.slice(0, 60), style: Object.assign({}, D.style), updated: Date.now() }); $('#preName').value = ''; touch('presets'); renderPresets(); toast('Preset saved'); };
$('#preApply').onclick = () => { const p = D.presets.find(x => x.id === $('#preSel').value); if (!p) return toast('Pick a preset'); D.style = Object.assign({}, DEF, p.style); persist('style'); syncDesign(); pushLocal(); D.set.pendStyle = true; persist('set'); if (canLive()) api('/style', 'POST', { style: D.style }).then(r => { D.style = Object.assign({}, DEF, r.style); D.set.pendStyle = false; persist('set'); persist('style'); }).catch(() => {}); toast('Preset applied'); };
$('#preDel').onclick = () => { const id = $('#preSel').value; if (!id || !confirm('Delete this preset?')) return; tombstone(id); D.presets = D.presets.filter(p => p.id !== id); touch('presets'); renderPresets(); };

/* ---------- connect tab ---------- */
function renderConnect() { const s = D.session; $('#noSes').hidden = !!s; $('#hasSes').hidden = !s; $('#leave').hidden = !s; if (!s) return;
  $('#code').textContent = s.code; $('#url').textContent = location.origin + '/o/' + s.code; }
const copy = t => { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied')).catch(() => { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Copy failed. Select the link and copy it.'); } a.remove(); }); };
$('#copy').onclick = () => copy(location.origin + '/o/' + D.session.code); $('#copyTxt').onclick = () => copy(location.origin + '/api/s/' + D.session.code + '/current.txt');
$('#showKey').onclick = () => { const b = $('#keyBox'); b.hidden = !b.hidden; b.textContent = D.session.key; $('#showKey').textContent = b.hidden ? 'Show control key' : 'Hide control key'; };
async function link(session) { linking = true; D.session = session; persist('session'); linking = false; renderConnect(); connect(); updStatus(); }
$('#mk').onclick = async () => { try { const r = await fetch('/api/session', { method: 'POST' }), j = await r.json(); if (!r.ok) throw new Error(j.error || 'Failed'); await link(j); toast('Session created'); } catch (e) { toast(e.message === 'Failed to fetch' ? 'You are offline. Everything else still works.' : e.message); } };
$('#jn').onclick = async () => { const code = $('#jc').value.trim().toUpperCase(), key = $('#jk').value.trim(); if (!code || !key) return toast('Enter both the code and the key');
  try { const r = await fetch('/api/s/' + code + '/data', { headers: { 'x-key': key } }); if (!r.ok) return toast('Code or key not recognised'); await link({ code, key }); toast('Joined'); } catch (e) { toast('You are offline.'); } };
$('#regen').onclick = async () => { if (!confirm('Make a new output code? The link in vMix stops working until you update it.')) return; try { const r = await api('/regenerate', 'POST'); D.session.code = r.code; persist('session'); $('#pvReal').removeAttribute('src'); renderConnect(); connect(); toast('New code ready'); } catch (e) { toast(e.message); } };
$('#leave').onclick = () => { if (!confirm('Unlink vMix on this device? Your songs and schedules stay saved here.')) return; if (ws) { ws.onclose = null; ws.close(); } ws = null; D.session = null; persist('session'); $('#pvReal').removeAttribute('src'); renderConnect(); updStatus(); };
$('#theme').onclick = () => { const d = document.documentElement, n = d.dataset.theme === 'light' ? 'dark' : 'light'; d.dataset.theme = n; D.set.theme = n; persist('set'); };

/* ---------- tabs, keys, boot ---------- */
function tab(n) { $$('.tab').forEach(t => t.classList.toggle('on', t.id === 't-' + n)); $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === n));
  document.body.classList.toggle('con', ['live', 'sch', 'lib'].includes(n)); if (n === 'lib' && !ED) { $('#libEdit').hidden = true; $('#libList').hidden = false; } setTimeout(fitMon, 30); window.scrollTo(0, 0); }
$$('nav button').forEach(b => b.onclick = () => tab(b.dataset.t));
addEventListener('keydown', e => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); step(1); } else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'Enter') goLive();
  else if (e.key === 'b' || e.key === 'B' || e.key === 'Escape') doClear(); else if (e.key === 'f' || e.key === 'F') doFreeze();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const sc = curSched(); if (!sc) return; const i = sc.items.findIndex(x => x.id === (PV ? PV.itemId : null)), n = sc.items[(i < 0 ? (e.key === 'ArrowDown' ? 0 : sc.items.length - 1) : i + (e.key === 'ArrowDown' ? 1 : -1))]; if (n) stage(n, n.id); }
  else if (e.key === '/') { e.preventDefault(); tab('lib'); $('#q').focus(); } });
let wl = null; function wake() { try { if (navigator.wakeLock && document.visibilityState === 'visible') navigator.wakeLock.request('screen').then(l => { wl = l; }).catch(() => {}); } catch (e) {} }
document.addEventListener('visibilitychange', wake);
addEventListener('online', () => { $('#banner').classList.remove('on'); if (D.session) connect(); }); addEventListener('offline', () => { $('#banner').textContent = 'You are offline. Songs and schedules still work and are saved on this device.'; $('#banner').classList.add('on'); updStatus(); });
addEventListener('resize', fitMon); if (window.ResizeObserver) { const ro = new ResizeObserver(fitMon); ['#mon1', '#mon2', '#mon3'].forEach(s => ro.observe($(s))); }
['#pvLocal', '#pvLocal2'].forEach(s => $(s).addEventListener('load', () => { const f = $(s); post(f, f._p || { line: '', visible: false, style: D.style }); }));
function renderAll() { renderSongs(); renderSchedule(); renderPresets(); renderConnect(); updStatus(); if (PV) { PV.m = modelOf(PV.ref); } if (LV) { LV.m = modelOf(LV.ref); } renderPrev(); renderLive(); }
(async () => {
  await loadAll(); if (D.set.theme) document.documentElement.dataset.theme = D.set.theme;
  $('#pvLocal').src = '/o/LOCAL?local=1'; $('#pvLocal2').src = '/o/LOCAL?local=1'; buildDesign(); renderAll(); tab('live'); showPane('live'); wake();
  if (D.draft && (D.draft.text || D.draft.title)) { const s = D.draft.id && findSong(D.draft.id); tab('lib'); openEd(s || null, D.draft); }
  if (D.session) connect(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
