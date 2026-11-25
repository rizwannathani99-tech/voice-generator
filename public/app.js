'use strict';
/* ===== safe helpers ===== */
const mem = {};
const store = {
  get(k) { try { const v = window.localStorage.getItem(k); return v === null ? (mem[k] ?? null) : v; } catch { return mem[k] ?? null; } },
  set(k, v) { mem[k] = String(v); try { window.localStorage.setItem(k, String(v)); } catch { /* blocked storage: memory fallback */ } },
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const html = (strs, ...vals) => new Raw(strs.reduce((a, s, i) => a + s + (i < vals.length ? (vals[i] instanceof Raw ? vals[i].s : Array.isArray(vals[i]) ? vals[i].map((v) => (v instanceof Raw ? v.s : esc(v))).join('') : esc(vals[i])) : ''), ''));
const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const fmtDate = (ms) => new Date(ms).toLocaleString();
const nf = (n) => Number(n || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), err ? 7000 : 3500);
}
class SignedOut extends Error {}
async function api(method, url, body, opts = {}) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method, credentials: 'same-origin',
      headers: body !== undefined && !opts.raw ? { 'Content-Type': 'application/json' } : opts.raw ? { 'Content-Type': 'application/octet-stream' } : {},
      body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
    });
  } catch { throw new Error('Could not reach the studio server — check that it is running and your connection is working.'); }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const msg = (data && data.error) || `The server answered HTTP ${res.status} without details.`;
    if (res.status === 401 && !/HeyGen/.test(msg) && !opts.noSignout && S.authed) { S.authed = false; setTimeout(boot, 0); throw new SignedOut('You are signed out — please log in again.'); }
    throw new Error(msg);
  }
  return data;
}
const get = (u) => api('GET', u), post = (u, b) => api('POST', u, b ?? {}), put = (u, b) => api('PUT', u, b), patch = (u, b) => api('PATCH', u, b), del = (u) => api('DELETE', u);

/* ===== state ===== */
const S = { authed: false, status: null, settings: null, voice: null, profiles: [], page: '', bootDone: false };
try { S.voice = JSON.parse(store.get('voice') || 'null'); } catch { S.voice = null; }
function setVoice(v) { S.voice = v ? { voice_id: v.voice_id, name: v.name, language: v.language, preview_url: v.preview_url || null } : null; store.set('voice', JSON.stringify(S.voice)); }

const PAGES = [
  ['dashboard', 'Dashboard', '▦'], ['tts', 'Text to Speech', '🎙'], ['dialogue', 'Multi-Narrator', '👥'], ['library', 'Voice Library', '♫'], ['design', 'Voice Design', '✦'],
  ['clone', 'Voice Cloning', '⎘'], ['voices', 'My Voices', '★'], ['history', 'Audio History', '⏱'], ['usage', 'Usage & Analytics', '▤'],
  ['api', 'API Settings', '🔑'],
];
const PACES = [{ v: 0.9, n: 'Natural (recommended)', d: '0.90x' }, { v: 0.85, n: 'Calm / Slow', d: '0.85x' }, { v: 1, n: 'Normal (original speed)', d: '1.00x' }];
const paceName = (p) => { p = Math.round(p * 100) / 100; return p === 0.9 ? 'Natural' : p === 0.85 ? 'Calm' : p === 1 ? 'Original' : 'Custom'; };
const modelName = () => (S.settings && S.settings.model) || (S.status && S.status.model) || '';

/* ===== error boundary ===== */
function fatal(e) {
  console.error(e);
  $('#app').innerHTML = `<div class="center-screen"><div class="card" style="max-width:420px"><h2>Voice Studio hit a problem</h2><p class="sub">${esc(e && e.message || e)}</p><button class="btn" onclick="location.reload()">Reload the studio</button></div></div>`;
}
window.addEventListener('error', (ev) => { if (!S.bootDone) fatal(ev.error || ev.message); });
window.addEventListener('unhandledrejection', (ev) => { if (!S.bootDone) fatal(ev.reason); });

/* ===== boot ===== */
async function boot() {
  $('#app').innerHTML = '<div class="boot"><div class="spinner"></div><div>Starting Voice Studio…</div></div>';
  let sess;
  try { sess = await api('GET', '/session', undefined, { noSignout: true }); }
  catch (e) {
    $('#app').innerHTML = `<div class="center-screen"><div class="card" style="max-width:420px"><h2>Voice Studio could not start</h2><p class="sub">${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div></div>`;
    $('#retry').onclick = boot; return;
  }
  S.bootDone = true;
  S.authed = true; // login removed: the studio opens straight to the Dashboard
  try {
    const [st, se, pr] = await Promise.all([get('/status'), get('/settings'), get('/profiles')]);
    S.status = st; S.settings = se; S.profiles = pr;
  } catch (e) { if (e instanceof SignedOut) return; return fatal(e); }
  const def = S.profiles.find((p) => p.is_default);
  if (def) setVoice({ voice_id: def.voice_id, name: def.voice_name || def.name, language: def.language });
  shell(); route();
}

function authScreen(mode) {
  const setup = mode === 'setup';
  $('#app').innerHTML = `<div class="center-screen"><div class="card auth">
    <div class="brand" style="justify-content:center"><div class="logo">V</div><div><b>VOICE STUDIO</b><small>PROFESSIONAL AI VOICE STUDIO</small></div></div>
    <h2>${setup ? 'Create your admin login' : 'Sign in'}</h2>
    <p class="sub">${setup ? 'This is the only account that can open the studio. Use at least 8 characters for the password.' : 'Enter your studio login.'}</p>
    <div class="field"><label>Username</label><input type="text" id="u" autocomplete="username"></div>
    <div class="field"><label>Password</label><input type="password" id="p" autocomplete="${setup ? 'new-password' : 'current-password'}"></div>
    <div id="msg"></div><button class="btn" id="go" style="width:100%">${setup ? 'Create account & open studio' : 'Sign in'}</button></div></div>`;
  const go = async () => {
    const u = $('#u').value, p = $('#p').value, msg = $('#msg'); msg.innerHTML = '';
    if (!u.trim()) { msg.innerHTML = '<div class="alert err">Please enter a username.</div>'; return; }
    if (!p) { msg.innerHTML = '<div class="alert err">Please enter a password.</div>'; return; }
    $('#go').disabled = true;
    try { await api('POST', setup ? '/setup' : '/login', { username: u, password: p }, { noSignout: true }); boot(); }
    catch (e) { msg.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; $('#go').disabled = false; }
  };
  $('#go').onclick = go; $('#p').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

/* ===== shell ===== */
function statusLine() {
  const st = S.status;
  if (!st) return '<div class="status"><span class="dot"></span>Checking connection…</div>';
  return st.connected ? `<div class="status ok"><span class="dot"></span>API connected — HeyGen · ${esc(modelName())}</div>`
    : '<div class="status bad"><span class="dot"></span>API not connected</div>';
}
function shell() {
  $('#app').innerHTML = `<div class="layout">
    <aside class="side" id="side"><div class="brand"><div class="logo">V</div><div><b>VOICE STUDIO</b><small>AI · HEYGEN</small></div></div>
      <nav class="nav">${PAGES.map(([id, n, ic]) => `<a href="#/${id}" data-p="${id}"><span>${ic}</span>${esc(n)}</a>`).join('')}</nav>
      <div id="statusline">${statusLine()}</div></aside>
    <div class="main"><div class="topbar"><button id="burger" aria-label="Menu">☰</button><b>VOICE STUDIO</b></div>
      <div class="content" id="content"></div>
      <div class="footer" id="footer"></div></div></div>`;
  $('#burger').onclick = () => $('#side').classList.toggle('open');
  refreshFooter();
}
function refreshFooter() { const f = $('#footer'); if (f) f.textContent = `Professional AI Voice Studio · Voices and generation by HeyGen (${modelName()})`; const s = $('#statusline'); if (s) s.innerHTML = statusLine(); }
async function reloadStatus() { try { S.status = await get('/status'); S.settings = await get('/settings'); } catch { /* keep */ } refreshFooter(); return S.status; }

let activeTimers = [];
function clearTimers() { activeTimers.forEach(clearInterval); activeTimers = []; }
window.addEventListener('hashchange', () => { if (S.authed) route(); });
async function route() {
  clearTimers();
  const id = (location.hash.replace('#/', '') || 'dashboard');
  const page = PAGES.find((p) => p[0] === id) ? id : 'dashboard';
  S.page = page;
  $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.p === page));
  $('#side').classList.remove('open');
  const c = $('#content');
  c.innerHTML = '<div class="boot" style="min-height:40vh"><div class="spinner"></div></div>';
  try { await PAGE[page](c); }
  catch (e) { if (e instanceof SignedOut) return; console.error(e); c.innerHTML = `<div class="alert err">${esc(e.message)}</div><button class="btn ghost" onclick="route()">Retry</button>`; }
  window.scrollTo(0, 0);
}
function head(t, s) { return html`<h1>${t}</h1><p class="sub">${s}</p>`.s; }
const notConnected = () => '<div class="alert warn">API not connected — add your HeyGen API key in <a href="#/api">API Settings</a>.</div>';

/* ===== modal ===== */
function ask(title, value = '', label = 'Name') {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="field"><label>${esc(label)}</label><input type="text" id="mi" value="${esc(value)}"></div><div class="row"><button class="btn" id="ok">Save</button><button class="btn ghost" id="no">Cancel</button></div></div>`;
    document.body.appendChild(bg); const i = $('#mi', bg); i.focus(); i.select();
    const done = (v) => { bg.remove(); resolve(v); };
    $('#ok', bg).onclick = () => done(i.value.trim() || null); $('#no', bg).onclick = () => done(null);
    i.onkeydown = (e) => { if (e.key === 'Enter') done(i.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}
const sure = (m) => confirm(m);

/* ===== waveform player ===== */
let currentAudio = null;
function mountPlayer(host, url, { onError } = {}) {
  host.innerHTML = `<div class="player"><button class="pp" aria-label="Play">▶</button><canvas></canvas><span class="t">00:00 / 00:00</span>
    <select title="Playback speed">${[0.75, 0.9, 1, 1.15, 1.25, 1.5, 2].map((s) => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}x</option>`).join('')}</select></div>`;
  const btn = $('.pp', host), cv = $('canvas', host), tm = $('.t', host), sp = $('select', host);
  const au = new Audio(url); au.preload = 'metadata';
  let peaks = null;
  const draw = () => {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w) return; cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    const n = Math.floor(w / 4), prog = au.duration ? au.currentTime / au.duration : 0;
    for (let i = 0; i < n; i++) {
      const p = peaks ? peaks[Math.floor((i / n) * peaks.length)] : 0.08;
      const bh = Math.max(2, p * h * 0.95);
      g.fillStyle = i / n < prog ? '#a78bfa' : '#43346b'; g.fillRect(i * 4, (h - bh) / 2, 2.4, bh);
    }
  };
  const time = () => { tm.textContent = `${mmss(au.currentTime)} / ${mmss(au.duration)}`; draw(); };
  au.addEventListener('timeupdate', time); au.addEventListener('loadedmetadata', time);
  au.addEventListener('ended', () => { btn.textContent = '▶'; time(); });
  au.addEventListener('error', () => { if (onError) onError(); host.insertAdjacentHTML('beforeend', '<div class="alert err">This audio could not be loaded or played.</div>'); });
  btn.onclick = () => {
    if (au.paused) { if (currentAudio && currentAudio !== au) currentAudio.pause(); currentAudio = au; au.play().catch((e) => toast('Playback blocked: ' + e.message, true)); btn.textContent = '❚❚'; }
    else { au.pause(); btn.textContent = '▶'; }
  };
  au.addEventListener('pause', () => { btn.textContent = '▶'; });
  sp.onchange = () => { au.playbackRate = Number(sp.value); };
  cv.onclick = (e) => { if (au.duration) { au.currentTime = ((e.clientX - cv.getBoundingClientRect().left) / cv.clientWidth) * au.duration; time(); } };
  fetch(url, { credentials: 'same-origin' }).then((r) => r.arrayBuffer()).then(async (b) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(b); ctx.close();
    const d = buf.getChannelData(0), N = 400, step = Math.floor(d.length / N) || 1; peaks = [];
    for (let i = 0; i < N; i++) { let m = 0; for (let j = 0; j < step; j += 16) m = Math.max(m, Math.abs(d[i * step + j] || 0)); peaks.push(m); }
    const mx = Math.max(...peaks) || 1; peaks = peaks.map((p) => Math.pow(p / mx, 0.7)); draw();
  }).catch(() => draw());
  requestAnimationFrame(draw);
  return au;
}

/* ===== shared voice-card actions ===== */
function useInStudio(v) { setVoice(v); toast(`Selected "${v.name}" for Text to Speech`); location.hash = '#/tts'; }
async function saveProfile(v, makeDefault) {
  const name = await ask(makeDefault ? 'Save as default voice profile' : 'Save voice profile', v.name, 'Profile name');
  if (!name) return;
  try { await post('/profiles', { name, voiceId: v.voice_id, voiceName: v.name, language: v.language, makeDefault }); S.profiles = await get('/profiles'); toast(`Profile "${name}" saved${makeDefault ? ' as default' : ''}`); }
  catch (e) { toast(e.message, true); }
}
function voiceCard(v, { extra = '', sel = false, defBtn = false } = {}) {
  return html`<div class="card voice ${sel ? 'sel' : ''}" data-id="${v.voice_id}">
    <div class="row sp"><h3>${v.name || '(unnamed)'}</h3><span class="badge ${v.status || ''}">${v.status || '—'}</span></div>
    <div class="mini">${[v.language, v.gender, v.mode].filter(Boolean).join(' · ') || 'language unknown'}</div>
    ${v.tags && v.tags.length ? raw(`<div class="mini" style="margin-top:4px">${esc(v.tags.slice(0, 5).join(' · '))}</div>`) : ''}
    ${v.preview_url ? raw(`<audio controls preload="none" src="${esc(v.preview_url)}"></audio>`) : raw('<div class="mini" style="margin:12px 0">No preview available yet</div>')}
    ${raw(extra)}
    <div class="row"><button class="btn sm" data-act="use">Use in Studio</button><button class="btn sm ghost" data-act="save">Save profile</button>${raw(defBtn ? '<button class="btn sm ghost" data-act="default">Save as default</button>' : '')}</div>
    <div class="mini" style="margin-top:8px">ID: ${v.voice_id}</div></div>`.s;
}
function bindCards(root, list) {
  $$('audio', root).forEach((a) => a.addEventListener('play', () => { if (currentAudio && currentAudio !== a) currentAudio.pause(); currentAudio = a; }));
  $$('.voice', root).forEach((el) => {
    const v = list.find((x) => x.voice_id === el.dataset.id); if (!v) return;
    const u = $('[data-act=use]', el), s = $('[data-act=save]', el), d = $('[data-act=default]', el);
    if (u) u.onclick = () => useInStudio(v); if (s) s.onclick = () => saveProfile(v, false); if (d) d.onclick = () => saveProfile(v, true);
  });
}

/* ===== PAGES ===== */
const PAGE = {};

PAGE.dashboard = async (c) => {
  const [d] = await Promise.all([get('/dashboard'), reloadStatus()]);
  const st = S.status;
  c.innerHTML = head('Dashboard', 'Your studio at a glance.') + (st.connected ? '' : notConnected()) + html`
    <div class="grid g4" style="margin-bottom:18px">
      <div class="card"><div class="stat">${st.connected ? 'Connected' : 'Not connected'}<small>HeyGen API · ${modelName()}</small></div></div>
      <div class="card"><div class="stat">${nf(d.counts.library)}<small>Voices in library</small></div></div>
      <div class="card"><div class="stat">${nf(d.counts.profiles)}<small>Saved profiles</small></div></div>
      <div class="card"><div class="stat">${nf(d.counts.cloned)}<small>Cloned / designed voices</small></div></div>
      <div class="card"><div class="stat">${nf(d.generations)}<small>Total generations</small></div></div>
      <div class="card"><div class="stat">${nf(d.characters)}<small>Total characters</small></div></div>
    </div>`.s + `<h2>Jump to</h2><div class="grid g4" style="margin-bottom:18px">${[['tts', '🎙 Text to Speech', 'Generate a voiceover'], ['library', '♫ Voice Library', 'Browse thousands of voices'], ['design', '✦ Voice Design', 'Find or create a voice'], ['clone', '⎘ Voice Cloning', 'Clone your own voice']].map(([id, t, s]) => `<a class="card shortcut" href="#/${id}"><b>${t}</b><div class="mini">${s}</div></a>`).join('')}</div>`
    + `<h2>Recent generations</h2><div class="card">${d.recent.length ? `<div class="table-wrap"><table><tr><th>Title</th><th>Voice</th><th>Chars</th><th>Length</th><th>Pace</th><th>Date</th></tr>${d.recent.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.voiceName)}</td><td>${nf(r.chars)}</td><td>${mmss(r.duration)}</td><td>${r.pace ? esc(r.paceLabel) + ' ' + r.pace.toFixed(2) + 'x' : '—'}</td><td>${fmtDate(r.created)}</td></tr>`).join('')}</table></div>` : '<span class="mini">Nothing generated yet — head to Text to Speech.</span>'}</div>`;
};

/* ---- Text to Speech ---- */
PAGE.tts = async (c) => {
  await reloadStatus();
  const se = S.settings; let pace = se.pace, emotion = se.emotion, polish = se.polish, job = null, busy = false;
  S.profiles = await get('/profiles');
  const mine = (await get('/voices?kind=private&status=ACTIVE&pageSize=100').catch(() => ({ items: [] }))).items;
  c.innerHTML = head('Text to Speech', 'Write or paste your script, pick a voice, and generate a natural-sounding voiceover.') + (S.status.connected ? '' : notConnected()) + `
  <div class="grid g2" style="grid-template-columns:minmax(0,3fr) minmax(0,2fr);align-items:start">
   <div>
    <div class="card"><div class="field"><label>Script title</label><input type="text" id="title" placeholder="e.g. Episode 12 narration"></div>
      <div class="field"><label>Script</label><textarea id="text" placeholder="Paste or type your script here…"></textarea>
      <div class="row sp" style="margin-top:6px"><span class="mini" id="counts">0 characters · 0 words</span><button class="btn ghost sm" id="clear">Clear</button></div></div>
      <div class="field"><label>Language code (optional)</label><input type="text" id="lang" value="${esc(se.ttsLanguage)}" placeholder="e.g. en, hi, ur — leave blank for the voice's own language"><div class="hint">Sent to HeyGen only if filled. Use a base code (en, hi…), not en-US.</div></div>
      <div class="hint" style="margin-bottom:14px">Tip for cloned (instant) voices: you can add audio tags inside the script, such as <b>[laughs]</b>, for more human reactions.</div>
      <div id="genmsg"></div>
      <div class="row"><button class="btn" id="gen">🎙 Generate voiceover</button><button class="btn danger" id="cancel" style="display:none">Cancel</button></div>
      <div id="prog" style="display:none;margin-top:14px"><div class="progress"><i id="bar" style="width:0"></i></div><div class="mini" id="progtxt" style="margin-top:6px"></div></div>
      <div id="result"></div></div>
   </div>
   <div>
    <div class="card"><h2>Voice</h2>
      <div class="field"><label>Saved voice profiles</label><select id="prof"><option value="">— choose a saved profile —</option>${S.profiles.map((p) => `<option value="${p.id}" ${S.voice && S.voice.voice_id === p.voice_id ? 'selected' : ''}>${esc(p.name)}${p.is_default ? ' ★ default' : ''}</option>`).join('')}${mine.length ? `<optgroup label="My cloned / designed voices">${mine.map((v) => `<option value="v:${esc(v.voice_id)}" ${S.voice && S.voice.voice_id === v.voice_id ? 'selected' : ''}>${esc(v.name)} (${v.mode === 'design' ? 'designed' : 'cloned'})</option>`).join('')}</optgroup>` : ''}</select></div>
      <div class="field"><label>Search the voice library (name or language)</label><input type="search" id="vq" placeholder="e.g. narrator, english, deep…"><div class="vlist" id="vlist" style="display:none"></div></div>
      <div id="selvoice"></div></div>
    <div class="card"><h2>Pace — Keep it Natural</h2>
      <div class="pace" id="pacebtns"></div>
      <input type="range" id="pslide" min="0.80" max="1.05" step="0.01"><div class="row sp mini"><span>0.80x slower</span><b id="pread"></b><span>1.05x</span></div>
      <div class="hint">HeyGen's raw output speaks fast, so a natural slow-down is applied once to the final audio (pitch preserved). Your choice is remembered.</div></div>
    <div class="card"><h2>Human delivery</h2>
      <div class="field"><label>Emotion intensity: <b id="eread"></b></label><input type="range" id="emo" min="0" max="1" step="0.05"><div class="hint">1.00 = fullest expressiveness (default). Lower for a calmer, flatter read. Works with cloned/instant voices; other voices ignore it and the studio tells you.</div></div>
      <label style="display:flex;gap:10px;align-items:flex-start;color:var(--text);cursor:pointer"><input type="checkbox" id="polish" style="margin-top:4px"><span>Studio polish<span class="hint" style="display:block">Rumble filter + loudness levelling (−16 LUFS, YouTube-ready) so every file sounds consistent.</span></span></label></div>
   </div></div>`;
  const text = $('#text'), titleEl = $('#title'), langEl = $('#lang');
  text.value = store.get('draft_text') || ''; titleEl.value = store.get('draft_title') || '';
  const updCounts = () => { const t = text.value; $('#counts').textContent = `${nf(t.length)} characters · ${nf((t.trim().match(/\S+/g) || []).length)} words` + (t.length > 4500 ? ` · will run as ${Math.ceil(t.length / 4500)}+ chunks` : ''); store.set('draft_text', t); };
  text.oninput = updCounts; titleEl.oninput = () => store.set('draft_title', titleEl.value); updCounts();
  $('#clear').onclick = () => { text.value = ''; updCounts(); };
  langEl.onchange = () => put('/settings', { ttsLanguage: langEl.value }).catch((e) => toast(e.message, true));

  // voice selection
  const renderSel = () => {
    const v = S.voice, el = $('#selvoice');
    if (!v) { el.innerHTML = '<div class="alert info">No voice selected yet. Pick a saved profile or search above, or use the Voice Library.</div>'; return; }
    el.innerHTML = `<div class="result" style="margin-top:0"><b>${esc(v.name)}</b><div class="mini">Language: ${esc(v.language || 'unknown')}<br>Voice ID: ${esc(v.voice_id)}</div>
      ${v.preview_url ? `<audio controls preload="none" src="${esc(v.preview_url)}" style="width:100%;margin-top:8px;height:34px"></audio><div class="mini">Official HeyGen preview</div>` : ''}
      <button class="btn ghost sm" id="sprev" style="margin-top:8px">Generate sample preview</button><div id="prevout"></div></div>`;
    $$('audio', el).forEach((a) => a.addEventListener('play', () => { if (currentAudio && currentAudio !== a) currentAudio.pause(); currentAudio = a; }));
    $('#sprev').onclick = async (ev) => {
      const b = ev.target; b.disabled = true; b.innerHTML = '<span class="spinner sm"></span> Generating…'; $('#prevout').innerHTML = '';
      try {
        const r = await post('/tts/preview', { voiceId: v.voice_id, voiceName: v.name, language: langEl.value, pace, polish, emotion });
        $('#prevout').innerHTML = '<div id="pp" style="margin-top:8px"></div>' + (r.notes || []).map((n) => `<div class="alert info">${esc(n)}</div>`).join('') + `<div class="mini">Sample · ${mmss(r.duration)} · Pace ${esc(r.pace_label || paceName(r.pace))} ${r.pace.toFixed(2)}x</div>`;
        mountPlayer($('#pp'), `/api/history/${r.id}/audio`);
      } catch (e) { $('#prevout').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
      b.disabled = false; b.textContent = 'Generate sample preview';
    };
  };
  renderSel();
  $('#prof').onchange = (e) => { const pv = mine.find((x) => 'v:' + x.voice_id === e.target.value); if (pv) { setVoice(pv); renderSel(); return; } const p = S.profiles.find((x) => String(x.id) === e.target.value); if (p) { setVoice({ voice_id: p.voice_id, name: p.voice_name || p.name, language: p.language }); renderSel(); } };
  let vt; $('#vq').oninput = (e) => {
    clearTimeout(vt); const q = e.target.value.trim(), list = $('#vlist');
    if (!q) { list.style.display = 'none'; return; }
    vt = setTimeout(async () => {
      try {
        const r = await get(`/voices?kind=all&q=${encodeURIComponent(q)}&pageSize=12`); list.style.display = 'block';
        if (!r.items.length) { list.innerHTML = '<div style="cursor:default"><span class="mini">No cached voices match. (Library may still be loading, or that language has no voices — this is real data.)</span></div>'; return; }
        list.innerHTML = r.items.map((v, i) => `<div data-i="${i}"><span>${esc(v.name)}</span><span class="mini">${esc(v.language || '?')} · ${esc(v.status || '')}</span></div>`).join('');
        $$('div[data-i]', list).forEach((d) => d.onclick = () => { setVoice(r.items[d.dataset.i]); list.style.display = 'none'; $('#vq').value = ''; $('#prof').value = ''; renderSel(); });
      } catch (err) { list.style.display = 'block'; list.innerHTML = `<div style="cursor:default" class="alert err">${esc(err.message)}</div>`; }
    }, 250);
  };

  // pace + delivery
  const savePace = (v) => { pace = v; store.set('pace', v); drawPace(); put('/settings', { pace: v }).catch((e) => toast(e.message, true)); };
  const drawPace = () => {
    $('#pacebtns').innerHTML = PACES.map((p) => `<button data-v="${p.v}" class="${Math.abs(pace - p.v) < 0.001 ? 'on' : ''}"><b>${p.n}</b><span>${p.d}</span></button>`).join('')
      + (PACES.every((p) => Math.abs(pace - p.v) > 0.001) ? `<button class="on"><b>Custom</b><span>${pace.toFixed(2)}x</span></button>` : '');
    $$('#pacebtns button[data-v]').forEach((b) => b.onclick = () => savePace(Number(b.dataset.v)));
    $('#pslide').value = pace; $('#pread').textContent = `${paceName(pace)} ${pace.toFixed(2)}x`;
  };
  $('#pslide').oninput = (e) => { pace = Number(e.target.value); drawPace(); }; $('#pslide').onchange = (e) => savePace(Number(e.target.value));
  drawPace();
  $('#emo').value = emotion; $('#eread').textContent = emotion.toFixed(2);
  $('#emo').oninput = (e) => { emotion = Number(e.target.value); $('#eread').textContent = emotion.toFixed(2); }; $('#emo').onchange = () => put('/settings', { emotion }).catch(() => {});
  $('#polish').checked = polish; $('#polish').onchange = (e) => { polish = e.target.checked; put('/settings', { polish }).catch(() => {}); };

  // generation
  const setProg = (pct, txt) => { $('#prog').style.display = 'block'; $('#bar').style.width = pct + '%'; $('#progtxt').textContent = txt; };
  const showResult = (r, notes) => {
    const chunks = r.chunks || 1;
    $('#result').innerHTML = `<div class="result"><div class="alert ok" style="margin-top:0">Done — ${nf(r.chars)} characters in ${chunks} chunk${chunks > 1 ? 's' : ''}, ${chunks > 1 ? 'combined into one file' : 'one file'} (${mmss(r.duration)}) · Pace: ${esc(r.pace_label || paceName(r.pace))} ${r.pace.toFixed(2)}x</div>
      ${(notes || []).map((n) => `<div class="alert info">${esc(n)}</div>`).join('')}<div id="mainplayer"></div>
      <div class="row" style="margin-top:12px"><a class="btn sm" href="/api/history/${r.id}/download">⬇ Download MP3</a><a class="btn ghost sm" href="/api/history/${r.id}/download?format=wav">Download WAV</a><button class="btn ghost sm" id="regen">↻ Regenerate</button><a class="btn ghost sm" href="#/history">Saved to Audio History</a></div></div>`;
    mountPlayer($('#mainplayer'), `/api/history/${r.id}/audio`); $('#regen').onclick = () => generate();
  };
  const setBusy = (b) => { busy = b; $('#gen').disabled = b; $('#cancel').style.display = b ? '' : 'none'; };
  async function runJob(id, total) {
    const notes = [];
    for (;;) {
      const j = await post(`/jobs/${id}/step`);
      (j.notes || []).forEach((n) => { if (!notes.includes(n)) notes.push(n); });
      if (j.done >= total) break;
      setProg((j.done / (total + 1)) * 100, `Generating chunk ${j.done + 1} of ${total}…`);
      if (!job) throw new Error('Cancelled');
    }
    setProg((total / (total + 1)) * 100, 'Merging chunks into one file and applying pace…');
    const r = await post(`/jobs/${id}/finish`); setProg(100, 'Finished'); return { r, notes };
  }
  async function generate() {
    if (busy) return; const msg = $('#genmsg'); msg.innerHTML = ''; $('#result').innerHTML = '';
    if (!text.value.trim()) { msg.innerHTML = '<div class="alert err">Write or paste a script first.</div>'; return; }
    if (!S.voice) { msg.innerHTML = '<div class="alert err">Choose a voice first (saved profile, library search, or the Voice Library page).</div>'; return; }
    const body = { title: titleEl.value || 'Untitled script', text: text.value, voiceId: S.voice.voice_id, voiceName: S.voice.name, language: langEl.value, pace, polish, emotion };
    setBusy(true);
    try {
      if (text.value.length <= 4500) {
        setProg(30, 'Generating audio…'); const r = await post('/tts/generate', body); setProg(100, 'Finished'); showResult(r, r.notes);
      } else {
        setProg(2, 'Planning chunks at sentence boundaries…');
        const p = await post('/jobs/plan', body); job = p.id;
        try { const { r, notes } = await runJob(p.id, p.total); showResult(r, notes); job = null; }
        catch (e) {
          if (job) { msg.innerHTML = `<div class="alert err">${esc(e.message)}<div class="row" style="margin-top:8px"><button class="btn sm" id="resume">Resume from the failed chunk</button></div></div>`; $('#resume').onclick = async () => { msg.innerHTML = ''; setBusy(true); try { const { r, notes } = await runJob(p.id, p.total); showResult(r, notes); job = null; } catch (e2) { msg.innerHTML = `<div class="alert err">${esc(e2.message)}</div>`; } setBusy(false); }; }
        }
      }
    } catch (e) { msg.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; if (/API not connected/.test(e.message)) reloadStatus(); }
    setBusy(false);
  }
  $('#gen').onclick = generate;
  $('#cancel').onclick = async () => { const id = job; job = null; if (id) { try { await del(`/jobs/${id}`); } catch { /* ignore */ } } setProg(0, 'Cancelled — the job and its chunk files were discarded.'); setBusy(false); };
};

/* ---- Multi-Narrator (dialogue / story with several voices) ---- */
const NARR_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#a78bfa', '#ef4444', '#14b8a6', '#eab308'];
const EXPRESSIONS = ['[laughs]', '[chuckles]', '[sighs]', '[gasps]'];
async function pickVoice() {
  const [profiles, mine] = await Promise.all([get('/profiles'), get('/voices?kind=private&status=ACTIVE&pageSize=100')]);
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" style="max-width:520px"><h3>Choose narrator voice</h3><input type="search" id="pq" placeholder="Search the whole library by name or language…" style="margin-bottom:10px"><div class="vlist" id="pl" style="max-height:340px"></div><div class="row" style="margin-top:12px"><button class="btn ghost" id="pc">Cancel</button></div></div>`;
    document.body.appendChild(bg);
    const list = $('#pl', bg); let items = [];
    const done = (v) => { bg.remove(); resolve(v); };
    const draw = (head) => {
      list.innerHTML = items.map((x, i) => x.h ? `<div style="cursor:default;background:#150d29"><b class="mini">${esc(x.h)}</b></div>` : `<div data-i="${i}"><span>${esc(x.v.name)}</span><span class="mini">${esc(x.tag || x.v.language || '')}</span></div>`).join('') || '<div style="cursor:default"><span class="mini">No voices found.</span></div>';
      $$('div[data-i]', list).forEach((d) => d.onclick = () => done(items[d.dataset.i].v));
    };
    const initial = () => {
      items = [];
      if (profiles.length) { items.push({ h: 'Saved profiles' }); profiles.forEach((p) => items.push({ v: { voice_id: p.voice_id, name: p.voice_name || p.name, language: p.language, kind: 'profile' }, tag: p.name + (p.is_default ? ' ★' : '') })); }
      if (mine.items.length) { items.push({ h: 'My cloned / designed voices' }); mine.items.forEach((v) => items.push({ v, tag: v.mode === 'design' ? 'designed' : 'cloned' })); }
      if (!items.length) items.push({ h: 'Type above to search the voice library' });
      draw();
    };
    initial(); let t;
    $('#pq', bg).oninput = (e) => { clearTimeout(t); const q = e.target.value.trim(); if (!q) return initial(); t = setTimeout(async () => { try { const r = await get(`/voices?kind=all&q=${encodeURIComponent(q)}&pageSize=30`); items = r.items.map((v) => ({ v })); draw(); } catch (err) { list.innerHTML = `<div style="cursor:default" class="alert err">${esc(err.message)}</div>`; } }, 250); };
    $('#pc', bg).onclick = () => done(null); bg.onclick = (e) => { if (e.target === bg) done(null); };
  });
}
PAGE.dialogue = async (c) => {
  await reloadStatus(); const se = S.settings;
  let blocks = []; try { blocks = JSON.parse(store.get('dlg_blocks') || '[]'); } catch { blocks = []; }
  if (!Array.isArray(blocks) || !blocks.length) blocks = [{ voice: S.voice || null, text: '' }, { voice: null, text: '' }];
  let pace = se.pace, gap = Number(store.get('dlg_gap') ?? 0.35), job = null, busy = false;
  const save = () => store.set('dlg_blocks', JSON.stringify(blocks));
  const colorOf = (v) => { if (!v) return '#6b5f8f'; const ids = []; blocks.forEach((b) => { if (b.voice && !ids.includes(b.voice.voice_id)) ids.push(b.voice.voice_id); }); return NARR_COLORS[ids.indexOf(v.voice_id) % NARR_COLORS.length]; };
  c.innerHTML = head('Multi-Narrator', 'Build a story or conversation with several narrators. Each block has its own voice and text; everything is generated in order and merged into one file.') + (S.status.connected ? '' : notConnected()) + `
    <div id="blocks"></div>
    <button class="btn ghost" id="add" style="width:100%;border-style:dashed;font-size:22px;padding:16px;margin:4px 0 18px" title="Add another narrator block">＋ Add narrator</button>
    <div class="card"><div class="grid g3" style="align-items:end"><div><label>Pace</label><select id="dpace">${PACES.map((p) => `<option value="${p.v}">${p.n} — ${p.d}</option>`).join('')}<option value="custom" hidden>Custom</option></select></div>
      <div><label>Pause when the narrator changes (seconds)</label><input type="text" id="dgap" value="${gap}"></div>
      <div><label>Title</label><input type="text" id="dtitle" placeholder="e.g. Chapter 1 dialogue"></div></div>
      <div class="hint">Emotion intensity and Studio polish follow your Text to Speech settings. Pace is applied once to the final merged file.</div>
      <div id="dmsg"></div><div class="row" style="margin-top:12px"><button class="btn" id="dgen" style="min-width:220px">🎙 Generate</button><button class="btn danger" id="dcancel" style="display:none">Cancel</button><span class="mini" id="dstats"></span></div>
      <div id="dprog" style="display:none;margin-top:14px"><div class="progress"><i id="dbar" style="width:0"></i></div><div class="mini" id="dprogtxt" style="margin-top:6px"></div></div><div id="dresult"></div></div>`;
  $('#dtitle').value = store.get('dlg_title') || ''; $('#dtitle').oninput = (e) => store.set('dlg_title', e.target.value);
  const ps = $('#dpace'); const known = PACES.some((p) => Math.abs(p.v - pace) < 0.001); ps.value = known ? String(PACES.find((p) => Math.abs(p.v - pace) < 0.001).v) : 'custom';
  ps.onchange = () => { if (ps.value === 'custom') return; pace = Number(ps.value); put('/settings', { pace }).catch(() => {}); };
  $('#dgap').onchange = (e) => { gap = Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)); e.target.value = gap; store.set('dlg_gap', gap); };
  const stats = () => { const ch = blocks.reduce((n, b) => n + (b.text || '').length, 0); $('#dstats').textContent = `${blocks.length} block${blocks.length > 1 ? 's' : ''} · ${nf(ch)} characters`; };
  function draw() {
    $('#blocks').innerHTML = blocks.map((b, i) => `<div class="card" data-i="${i}" style="border-left:4px solid ${colorOf(b.voice)}">
      <div class="row sp" style="margin-bottom:10px"><div class="row"><span class="mini"><b>${i + 1}</b></span><button class="btn ghost sm" data-a="voice" style="border-color:${colorOf(b.voice)}">● ${b.voice ? esc(b.voice.name) : 'Select narrator'} ▾</button>
        ${b.voice && b.voice.kind === 'private' ? `<span style="position:relative"><button class="btn ghost sm" data-a="expr">‹› + Expression</button><div class="vlist" data-m="expr" style="display:none;position:absolute;z-index:5;width:170px;margin-top:4px">${EXPRESSIONS.map((x) => `<div data-x="${x}">${x}</div>`).join('')}</div></span>` : ''}</div>
        <div class="row"><button class="btn ghost sm" data-a="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button class="btn ghost sm" data-a="down" ${i === blocks.length - 1 ? 'disabled' : ''} title="Move down">↓</button><button class="btn danger sm" data-a="del" title="Remove block" ${blocks.length === 1 ? 'disabled' : ''}>✕</button></div></div>
      <textarea style="min-height:90px" placeholder="What does this narrator say?">${esc(b.text)}</textarea></div>`).join('');
    $$('#blocks .card').forEach((el) => {
      const i = Number(el.dataset.i), b = blocks[i];
      $('textarea', el).oninput = (e) => { b.text = e.target.value; save(); stats(); };
      $('[data-a=voice]', el).onclick = async () => { const v = await pickVoice(); if (!v) return; if (v.kind === 'profile' || !v.kind) { try { const full = await get(`/voices/lookup/${v.voice_id}`); v.kind = full.kind; } catch { v.kind = 'public'; } } b.voice = { voice_id: v.voice_id, name: v.name, language: v.language, kind: v.kind }; save(); draw(); };
      const ex = $('[data-a=expr]', el); if (ex) { const m = $('[data-m=expr]', el); ex.onclick = () => { m.style.display = m.style.display === 'none' ? 'block' : 'none'; }; $$('[data-x]', m).forEach((d) => d.onclick = () => { const ta = $('textarea', el), s = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, s) + d.dataset.x + ' ' + ta.value.slice(s); b.text = ta.value; save(); stats(); m.style.display = 'none'; ta.focus(); }); }
      $('[data-a=up]', el).onclick = () => { [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]]; save(); draw(); };
      $('[data-a=down]', el).onclick = () => { [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]]; save(); draw(); };
      $('[data-a=del]', el).onclick = () => { blocks.splice(i, 1); save(); draw(); };
    });
    stats();
  }
  draw();
  $('#add').onclick = () => { const last = blocks[blocks.length - 1]; blocks.push({ voice: null, text: '' }); save(); draw(); const t = $$('#blocks textarea'); t[t.length - 1].focus(); window.scrollTo(0, document.body.scrollHeight); void last; };
  const setProg = (pct, txt) => { $('#dprog').style.display = 'block'; $('#dbar').style.width = pct + '%'; $('#dprogtxt').textContent = txt; };
  const setBusy = (b2) => { busy = b2; $('#dgen').disabled = b2; $('#dcancel').style.display = b2 ? '' : 'none'; };
  async function run(id, total) {
    const notes = [];
    for (;;) {
      const j = await post(`/jobs/${id}/step`); (j.notes || []).forEach((n) => { if (!notes.includes(n)) notes.push(n); });
      if (j.done >= total) break; setProg((j.done / (total + 1)) * 100, `Generating part ${j.done + 1} of ${total}…`);
      if (!job) throw new Error('Cancelled');
    }
    setProg((total / (total + 1)) * 100, 'Merging all parts into one file and applying pace…');
    const r = await post(`/jobs/${id}/finish`); setProg(100, 'Finished'); return { r, notes };
  }
  const show = (r, notes) => {
    $('#dresult').innerHTML = `<div class="result"><div class="alert ok" style="margin-top:0">Done — ${nf(r.chars)} characters, ${r.chunks} part${r.chunks > 1 ? 's' : ''} by ${esc(r.voice_name)}, combined into one file (${mmss(r.duration)}) · Pace: ${esc(r.pace_label)} ${r.pace.toFixed(2)}x</div>${(notes || []).map((n) => `<div class="alert info">${esc(n)}</div>`).join('')}<div id="dplayer"></div>
      <div class="row" style="margin-top:12px"><a class="btn sm" href="/api/history/${r.id}/download">⬇ Download MP3</a><a class="btn ghost sm" href="/api/history/${r.id}/download?format=wav">Download WAV</a><a class="btn ghost sm" href="#/history">Saved to Audio History</a></div></div>`;
    mountPlayer($('#dplayer'), `/api/history/${r.id}/audio`);
  };
  $('#dgen').onclick = async () => {
    if (busy) return; const msg = $('#dmsg'); msg.innerHTML = ''; $('#dresult').innerHTML = '';
    const bad = (m) => { msg.innerHTML = `<div class="alert err">${esc(m)}</div>`; };
    for (let i = 0; i < blocks.length; i++) { if (!blocks[i].voice) return bad(`Block ${i + 1}: choose a narrator first.`); if (!blocks[i].text.trim()) return bad(`Block ${i + 1}: write the text for this narrator.`); }
    setBusy(true);
    try {
      setProg(2, 'Planning…');
      const p = await post('/jobs/plan-dialogue', { title: $('#dtitle').value || 'Multi-narrator story', blocks: blocks.map((b) => ({ voiceId: b.voice.voice_id, voiceName: b.voice.name, text: b.text })), pace, gap, language: S.settings.ttsLanguage });
      job = p.id;
      try { const { r, notes } = await run(p.id, p.total); show(r, notes); job = null; }
      catch (e) { if (job) { msg.innerHTML = `<div class="alert err">${esc(e.message)}<div class="row" style="margin-top:8px"><button class="btn sm" id="dres">Resume from the failed part</button></div></div>`; $('#dres').onclick = async () => { msg.innerHTML = ''; setBusy(true); try { const { r, notes } = await run(p.id, p.total); show(r, notes); job = null; } catch (e2) { msg.innerHTML = `<div class="alert err">${esc(e2.message)}</div>`; } setBusy(false); }; } }
    } catch (e) { bad(e.message); }
    setBusy(false);
  };
  $('#dcancel').onclick = async () => { const id = job; job = null; if (id) { try { await del(`/jobs/${id}`); } catch { /* ignore */ } } setProg(0, 'Cancelled — the job and its files were discarded.'); setBusy(false); };
};

/* ---- Voice Library ---- */
PAGE.library = async (c) => {
  await reloadStatus();
  c.innerHTML = head('Voice Library', 'Browse ready-made HeyGen voices (served from the local cache).') + (S.status.connected ? '' : notConnected()) + `
  <div class="card"><div class="grid g4" style="align-items:end"><div><label>Search name or language</label><input type="search" id="q" placeholder="e.g. narrator"></div>
    <div><label>Language</label><select id="lg"><option value="">All languages</option></select></div>
    <div><label>Gender</label><select id="gd"><option value="">Any</option><option value="female">Female</option><option value="male">Male</option></select></div>
    <div><button class="btn ghost" id="refresh" style="width:100%">↻ Refresh from HeyGen</button></div></div><div id="loadmsg"></div></div>
  <div id="vgrid"></div><div class="pager" id="pager"></div>`;
  let page = 1; const q = $('#q'), lg = $('#lg'), gd = $('#gd');
  async function langs() { const l = await get('/voices/languages'); lg.innerHTML = '<option value="">All languages</option>' + l.map((x) => `<option value="${esc(x.language)}">${esc(x.language)} (${nf(x.count)})</option>`).join(''); }
  async function load() {
    const r = await get(`/voices?q=${encodeURIComponent(q.value)}&language=${encodeURIComponent(lg.value)}&gender=${gd.value}&page=${page}&pageSize=24`);
    const pages = Math.max(1, Math.ceil(r.total / 24));
    $('#vgrid').innerHTML = r.items.length ? `<div class="grid gv">${r.items.map((v) => voiceCard(v, { sel: S.voice && S.voice.voice_id === v.voice_id })).join('')}</div>`
      : `<div class="card"><b>No voices found.</b><div class="mini">${S.status.counts.library ? 'No cached voice matches those filters. This is real data from HeyGen — for example, there are currently no Hindi/Urdu-coded public voices — not an error.' : 'The library cache is empty.'}</div></div>`;
    bindCards($('#vgrid'), r.items);
    $('#pager').innerHTML = r.total ? `<button class="btn ghost sm" id="pv" ${page <= 1 ? 'disabled' : ''}>← Prev</button><span class="mini">Page ${page} of ${pages} · ${nf(r.total)} voices</span><button class="btn ghost sm" id="nx" ${page >= pages ? 'disabled' : ''}>Next →</button>` : '';
    if ($('#pv')) { $('#pv').onclick = () => { page--; load(); window.scrollTo(0, 0); }; $('#nx').onclick = () => { page++; load(); window.scrollTo(0, 0); }; }
  }
  let t; const reload = () => { clearTimeout(t); t = setTimeout(() => { page = 1; load().catch((e) => toast(e.message, true)); }, 250); };
  q.oninput = reload; lg.onchange = reload; gd.onchange = reload;
  async function watch() {
    const m = $('#loadmsg'); if (!m) return;
    const iv = setInterval(async () => {
      try {
        const r = await get('/voices/refresh-status');
        if (!$('#loadmsg')) { clearInterval(iv); return; }
        if (r.running) m.innerHTML = `<div class="alert info"><span class="spinner sm"></span> Loading voices from HeyGen… ${nf(r.count)} so far (page ${r.pages})</div>`;
        else { clearInterval(iv); if (r.error) m.innerHTML = `<div class="alert err">${esc(r.error)}</div>`; else { m.innerHTML = `<div class="alert ok">Voice library ready — ${nf(r.counts.library)} voices cached.</div>`; S.status.counts = r.counts; await langs(); await load(); } }
      } catch (e) { clearInterval(iv); m.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
    }, 1500); activeTimers.push(iv);
  }
  $('#refresh').onclick = async () => { try { await post('/voices/refresh'); watch(); } catch (e) { $('#loadmsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; } };
  await langs(); await load();
  // AUTO-LOAD: no manual refresh needed when connected and the cache is empty
  if (S.status.connected && !S.status.counts.library) { try { await post('/voices/refresh'); watch(); } catch (e) { $('#loadmsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; } }
  else if (S.status.refresh && S.status.refresh.running) watch();
};

/* ---- Voice Design ---- */
PAGE.design = async (c) => {
  await reloadStatus();
  const LANGS = [['any', 'Any language'], ['en', 'English'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['ar', 'Arabic'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']];
  const TAGS = ['professional narrator', 'documentary narrator', 'educational professor', 'storytelling', 'corporate presenter', 'news presenter', 'friendly conversational', 'calm', 'energetic promotional', 'cinematic', 'deep voice'];
  let lang = 'any', tags = new Set();
  c.innerHTML = head('Voice Design', 'Find the best matching real voices, or have HeyGen design a brand-new one from a description.') + (S.status.connected ? '' : notConnected()) + `
  <div class="card"><h2>Step 1 — Language</h2><div class="chips" id="langs"></div></div>
  <div class="card"><h2>Step 2 — Voice type</h2><div class="grid g2"><div><label>Voice type</label><select id="gender"><option value="">No preference</option><option value="female">Female</option><option value="male">Male</option></select></div></div>
    <div class="field" style="margin-top:14px"><label>Describe age, depth, accent and delivery</label><textarea id="desc" style="min-height:90px" placeholder="e.g. a warm, confident male voice in his 40s, deep and calm, slight British accent, measured documentary pace"></textarea><div class="hint" id="dcount">0 / 500</div></div>
    <label>Quick tags</label><div class="chips" id="tags"></div>
    <div class="row" style="margin-top:16px"><button class="btn" id="find">Find matching voices</button></div><div id="findmsg"></div></div>
  <div id="results"></div>
  <div class="card"><h2>✦ Create a genuinely designed voice (HeyGen design mode)</h2><p class="sub" style="margin-bottom:12px">This asks HeyGen to synthesise a <b>new</b> voice from your description. It is separate from the library matches above and is labelled "design" in My Voices. Needs a 20–500 character description; language "Any" uses English.</p>
    <div class="field"><label>New voice name</label><input type="text" id="dname" placeholder="e.g. Calm Documentary Narrator"></div><button class="btn" id="dcreate">Create designed voice</button><div id="dout"></div></div>`;
  $('#langs').innerHTML = LANGS.map(([k, n]) => `<span class="chip ${k === lang ? 'on' : ''}" data-k="${k}">${n}</span>`).join('');
  $$('#langs .chip').forEach((e) => e.onclick = () => { lang = e.dataset.k; $$('#langs .chip').forEach((x) => x.classList.toggle('on', x === e)); });
  $('#tags').innerHTML = TAGS.map((t) => `<span class="chip" data-t="${t}">${t}</span>`).join('');
  $$('#tags .chip').forEach((e) => e.onclick = () => { const t = e.dataset.t; tags.has(t) ? tags.delete(t) : tags.add(t); e.classList.toggle('on'); });
  $('#desc').oninput = (e) => { $('#dcount').textContent = `${e.target.value.length} / 500`; };
  $('#find').onclick = async (ev) => {
    const b = ev.target; b.disabled = true; $('#findmsg').innerHTML = ''; $('#results').innerHTML = '';
    try {
      const r = await post('/design/match', { language: lang, gender: $('#gender').value, description: $('#desc').value, tags: [...tags] });
      if (!r.items.length) { $('#results').innerHTML = '<div class="card"><b>No voices match.</b><div class="mini">Real result: the library has no voices for that exact combination (e.g. no Hindi/Urdu-coded public voices). Try "Any language", or create a designed voice below.</div></div>'; }
      else {
        $('#results').innerHTML = `<h2>${nf(r.total)} matches — top ${r.items.length} <span class="mini">(matched on: ${esc(r.tokens.join(', ') || 'language/gender only')})</span></h2><div class="grid gv">${r.items.map((v) => voiceCard(v, { defBtn: true, extra: `<div class="row sp mini" style="margin-bottom:8px"><span>Match score</span><b>${v.score}%</b></div><div class="progress" style="margin-bottom:10px"><i style="width:${v.score}%"></i></div>` })).join('')}</div>`;
        bindCards($('#results'), r.items);
      }
    } catch (e) { $('#findmsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
    b.disabled = false;
  };
  $('#dcreate').onclick = async (ev) => {
    const b = ev.target, out = $('#dout'); out.innerHTML = ''; b.disabled = true;
    try {
      const r = await post('/design/create', { name: $('#dname').value, language: lang, description: `${$('#desc').value} ${[...tags].join(', ')}`.trim() });
      out.innerHTML = `<div class="alert info" id="dstat"><span class="spinner sm"></span> Designed voice created (ID ${esc(r.voiceId)}) — waiting for HeyGen…</div>`;
      await pollVoice(r.voiceId, (v) => { $('#dstat').innerHTML = `Status: <span class="badge ${v.status}">${v.status}</span> ${esc(v.failure_reason || '')}`; });
      const v = await post(`/voices/${r.voiceId}/status`);
      out.innerHTML = `<div class="grid gv" style="margin-top:12px">${voiceCard({ ...v, mode: 'designed voice' })}</div>`; bindCards(out, [v]);
    } catch (e) { out.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
    b.disabled = false;
  };
};
async function pollVoice(id, onUpdate, maxMs = 240000) {
  const t0 = Date.now();
  for (;;) {
    const v = await post(`/voices/${id}/status`); if (onUpdate) onUpdate(v);
    if (v.status === 'ACTIVE' || v.status === 'FAILED') return v;
    if (Date.now() - t0 > maxMs) return v;
    await sleep(3000);
  }
}

/* ---- Voice Cloning ---- */
function wavFromBuffer(buf) {
  const ch = buf.getChannelData(0), n = ch.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, ch[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([ab], { type: 'audio/wav' });
}
async function blobToWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dec = await ctx.decodeAudioData(await blob.arrayBuffer()); ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 24000), 24000); const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start();
  return wavFromBuffer(await off.startRendering());
}
PAGE.clone = async (c) => {
  await reloadStatus(); let file = null, recorder = null, chunks = [], timer = null, running = false;
  c.innerHTML = head('Voice Cloning', 'Create a copy of a voice from a short audio sample.') + (S.status.connected ? '' : notConnected()) + `
  <div class="alert info">Cloning uses HeyGen's real <b>Instant Voice Clone</b> API (a separate call from the Turbo TTS model). Success depends on your HeyGen account's permissions. If HeyGen rejects a request, the exact HeyGen error is shown and nothing is saved. No clone is ever simulated.</div>
  <div class="card"><div class="grid g2"><div class="field"><label>New voice name (1–64 characters)</label><input type="text" id="cname" maxlength="64"></div>
    <div class="field"><label>Language code (optional)</label><input type="text" id="clang" placeholder="leave blank"><div class="hint">A wrong language code makes HeyGen reject instant clones with HTTP 400 — blank is the safe default.</div></div></div>
    <label>Voice sample — MP3 or WAV, max 16 MB (about one minute of clear speech works best)</label>
    <div class="drop" id="drop"><div>⬆ Drag &amp; drop your sample here, or click to choose a file</div><input type="file" id="fi" accept=".mp3,.wav,audio/mpeg,audio/wav" style="display:none"></div>
    <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="rec">● Record in browser</button><span class="mini" id="rectime"></span></div>
    <div id="sample" style="margin-top:10px"></div>
    <label style="display:flex;gap:10px;align-items:flex-start;color:var(--text);cursor:pointer;margin-top:14px"><input type="checkbox" id="consent" style="margin-top:4px"><span>I confirm this is my own voice, or I have the voice owner's explicit permission to clone it.</span></label>
    <div id="cmsg"></div>
    <ul class="steps" id="steps" style="display:none"><li id="s1">Sample validated</li><li id="s2">Voice ownership confirmed</li><li id="s3">Sent to HeyGen — clone created, status checked</li></ul>
    <button class="btn" id="go" style="margin-top:12px">Create cloned voice</button></div>
  <h2>Your cloned voices</h2><div id="mine"></div>`;
  const show = () => { $('#sample').innerHTML = file ? `<div class="mini">${esc(file.name)} · ${(file.size / 1048576).toFixed(2)} MB</div><div id="sp" style="margin-top:6px"></div>` : ''; if (file) mountPlayer($('#sp'), URL.createObjectURL(file)); };
  const pick = (f) => { if (!f) return; file = f; show(); };
  $('#drop').onclick = () => $('#fi').click(); $('#fi').onchange = (e) => pick(e.target.files[0]);
  $('#drop').ondragover = (e) => { e.preventDefault(); $('#drop').classList.add('over'); }; $('#drop').ondragleave = () => $('#drop').classList.remove('over');
  $('#drop').ondrop = (e) => { e.preventDefault(); $('#drop').classList.remove('over'); pick(e.dataTransfer.files[0]); };
  $('#rec').onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); recorder = new MediaRecorder(stream); chunks = []; let s = 0;
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); recorder = null; $('#rec').textContent = '● Record in browser'; $('#rectime').textContent = 'Converting…';
        try { const wav = await blobToWav(new Blob(chunks)); pick(new File([wav], 'recording.wav', { type: 'audio/wav' })); $('#rectime').textContent = ''; } catch (e) { $('#rectime').textContent = ''; $('#cmsg').innerHTML = `<div class="alert err">Could not process the recording: ${esc(e.message)}</div>`; }
      };
      recorder.start(); $('#rec').textContent = '■ Stop recording'; timer = setInterval(() => { s++; $('#rectime').textContent = `Recording… ${mmss(s)}`; }, 1000); activeTimers.push(timer);
    } catch (e) { $('#cmsg').innerHTML = `<div class="alert err">Microphone unavailable: ${esc(e.message)}</div>`; }
  };
  const mark = (id, st) => { const li = $('#' + id); li.className = st; };
  async function loadMine() {
    const r = await get('/voices?kind=private&pageSize=100'); const l = r.items.filter((v) => v.mode !== 'design');
    $('#mine').innerHTML = l.length ? `<div class="grid gv">${l.map((v) => voiceCard(v)).join('')}</div>` : '<div class="card mini">No cloned voices yet.</div>'; bindCards($('#mine'), l);
  }
  $('#go').onclick = async () => {
    if (running) return; const msg = $('#cmsg'); msg.innerHTML = ''; const name = $('#cname').value.trim();
    const bad = (m) => { msg.innerHTML = `<div class="alert err">${esc(m)}</div>`; };
    if (!name || name.length > 64) return bad('Enter a voice name (1–64 characters).');
    if (!file) return bad('Choose or record a voice sample first.');
    if (!/\.(mp3|wav)$/i.test(file.name)) return bad('Only MP3 or WAV samples are accepted.');
    if (file.size > 16 * 1048576) return bad(`The sample is ${(file.size / 1048576).toFixed(1)} MB — the limit is 16 MB.`);
    if (!$('#consent').checked) return bad('Please tick the confirmation that this is your own voice or you have the owner\'s permission.');
    running = true; $('#go').disabled = true; $('#steps').style.display = ''; ['s1', 's2', 's3'].forEach((s) => mark(s, ''));
    try {
      mark('s1', 'run'); const init = await post('/clone/init', { filename: file.name, size: file.size, consent: true });
      const buf = new Uint8Array(await file.arrayBuffer()); const CH = 512 * 1024;
      for (let o = 0; o < buf.length; o += CH) await api('PUT', `/clone/${init.uploadId}/chunk?offset=${o}`, buf.slice(o, o + CH), { raw: true });
      let sha = null; try { sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { /* no subtle crypto */ }
      mark('s1', 'done'); mark('s2', 'done'); mark('s3', 'run');
      const r = await post(`/clone/${init.uploadId}/finish`, { name, language: $('#clang').value, consent: true, sha256: sha });
      const v = await pollVoice(r.voiceId);
      if (v.status === 'ACTIVE') { mark('s3', 'done'); msg.innerHTML = `<div class="alert ok">Clone ACTIVE — voice ID ${esc(v.voice_id)}. (Uploaded ${(r.originalBytes / 1024).toFixed(0)} KB, sent ${(r.sentBytes / 1024).toFixed(0)} KB after transcoding.)</div>`; }
      else if (v.status === 'FAILED') { msg.innerHTML = `<div class="alert err">HeyGen marked the clone FAILED: ${esc(v.failure_reason || 'no reason given')}. Nothing was usable.</div>`; }
      else { msg.innerHTML = `<div class="alert warn">The clone is still PENDING at HeyGen. Check it later from My Voices → Refresh status.</div>`; }
      await loadMine();
    } catch (e) { msg.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
    running = false; $('#go').disabled = false;
  };
  await loadMine();
};

/* ---- My Voices ---- */
PAGE.voices = async (c) => {
  await reloadStatus();
  async function draw() {
    const [profiles, priv] = await Promise.all([get('/profiles'), get('/voices?kind=private&pageSize=100')]); S.profiles = profiles;
    c.innerHTML = head('My Voices', 'Saved profiles and your cloned / designed voices.') + `<h2>Saved voice profiles</h2><div class="card">${profiles.length ? `<div class="table-wrap"><table><tr><th>Name</th><th>Voice</th><th>Language</th><th></th></tr>${profiles.map((p) => `<tr><td><b>${esc(p.name)}</b> ${p.is_default ? '<span class="badge ACTIVE">default</span>' : ''}</td><td>${esc(p.voice_name || '')}<div class="mini">${esc(p.voice_id)}</div></td><td>${esc(p.language || '—')}</td><td><div class="row"><button class="btn sm" data-a="use" data-id="${p.id}">Use</button>${p.is_default ? '' : `<button class="btn sm ghost" data-a="def" data-id="${p.id}">Set default</button>`}<button class="btn sm ghost" data-a="ren" data-id="${p.id}">Rename</button><button class="btn sm danger" data-a="del" data-id="${p.id}">Delete</button></div></td></tr>`).join('')}</table></div>` : '<span class="mini">No saved profiles yet — use "Save profile" on any voice in the Voice Library or Voice Design.</span>'}</div>
    <div class="row sp"><h2>Cloned &amp; designed voices</h2><button class="btn ghost sm" id="rp">↻ Refresh private list</button></div><div id="pmsg"></div>
    ${priv.items.length ? `<div class="grid gv">${priv.items.map((v) => voiceCard(v, { extra: `<button class="btn sm ghost" data-act="st" style="margin-bottom:8px">↻ Refresh status</button>${v.failure_reason ? `<div class="alert err">${esc(v.failure_reason)}</div>` : ''}` })).join('')}</div>` : '<div class="card mini">No cloned or designed voices cached yet. Click "Refresh private list" to load them from HeyGen.</div>'}`;
    $$('button[data-a]', c).forEach((b) => b.onclick = async () => {
      const p = profiles.find((x) => String(x.id) === b.dataset.id); try {
        if (b.dataset.a === 'use') return useInStudio({ voice_id: p.voice_id, name: p.voice_name || p.name, language: p.language });
        if (b.dataset.a === 'def') await patch(`/profiles/${p.id}`, { isDefault: true });
        if (b.dataset.a === 'ren') { const n = await ask('Rename profile', p.name, 'Profile name'); if (!n) return; await patch(`/profiles/${p.id}`, { name: n }); }
        if (b.dataset.a === 'del') { if (!sure(`Delete profile "${p.name}"?`)) return; await del(`/profiles/${p.id}`); }
        await draw();
      } catch (e) { toast(e.message, true); }
    });
    $('#rp').onclick = async (ev) => { ev.target.disabled = true; try { const r = await post('/voices/private/refresh'); toast(`Loaded ${r.count} private voices`); await draw(); } catch (e) { $('#pmsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; ev.target.disabled = false; } };
    bindCards(c, priv.items);
    $$('.voice', c).forEach((el) => { const b = $('[data-act=st]', el); if (b) b.onclick = async () => { b.disabled = true; try { await post(`/voices/${el.dataset.id}/status`); await draw(); } catch (e) { toast(e.message, true); b.disabled = false; } }; });
  }
  await draw();
};

/* ---- Audio History ---- */
PAGE.history = async (c) => {
  const list = await get('/history');
  c.innerHTML = head('Audio History', 'Every voiceover you generated. Entries stay until you delete them.') + (list.length ? list.map((r) => `<div class="card" data-id="${r.id}"><div class="row sp"><div><b>${esc(r.title)}</b><div class="mini">${esc(r.voiceName)} · ${nf(r.chars)} characters · ${mmss(r.duration)} · ${r.pace ? 'Pace: ' + esc(r.paceLabel) + ' ' + r.pace.toFixed(2) + 'x' : 'no pace recorded'} · ${fmtDate(r.created)}</div></div>
    <div class="row"><button class="btn sm" data-a="play">▶ Play</button><a class="btn sm ghost" href="/api/history/${r.id}/download">⬇ MP3</a><a class="btn sm ghost" href="/api/history/${r.id}/download?format=wav">WAV</a><button class="btn sm danger" data-a="del">Delete</button></div></div><div class="pl" style="margin-top:10px"></div></div>`).join('') : '<div class="card mini">No generations yet.</div>');
  $$('.card[data-id]', c).forEach((el) => {
    $('[data-a=play]', el).onclick = () => { const h = $('.pl', el); if (!h.firstChild) { const a = mountPlayer(h, `/api/history/${el.dataset.id}/audio`); a.addEventListener('canplay', () => a.play().catch(() => {}), { once: true }); } };
    $('[data-a=del]', el).onclick = async () => { if (!sure('Delete this audio permanently?')) return; try { await del(`/history/${el.dataset.id}`); el.remove(); toast('Deleted'); } catch (e) { toast(e.message, true); } };
  });
};

/* ---- Usage ---- */
PAGE.usage = async (c) => {
  const u = await get('/usage'); const mx = Math.max(1, ...u.byDay.map((d) => d.chars));
  c.innerHTML = head('Usage & Analytics', 'Computed only from your real generation history.') + html`<div class="grid g3" style="margin-bottom:18px">
    <div class="card"><div class="stat">${nf(u.generations)}<small>Total generations</small></div></div>
    <div class="card"><div class="stat">${nf(u.characters)}<small>Total characters used</small></div></div>
    <div class="card"><div class="stat">${mmss(u.seconds)}<small>Total audio generated</small></div></div></div>`.s
    + `<div class="grid g2"><div class="card"><h2>Characters by voice</h2>${u.byVoice.length ? `<div class="table-wrap"><table><tr><th>Voice</th><th>Generations</th><th>Characters</th></tr>${u.byVoice.map((v) => `<tr><td>${esc(v.name)}</td><td>${nf(v.generations)}</td><td>${nf(v.chars)}</td></tr>`).join('')}</table></div>` : '<span class="mini">No data yet.</span>'}</div>
    <div class="card"><h2>Activity — last days</h2>${u.byDay.length ? `<div class="bars" style="margin-bottom:26px">${[...u.byDay].reverse().map((d) => `<div style="height:${Math.max(3, (d.chars / mx) * 100)}%" title="${esc(d.day)}: ${nf(d.chars)} chars, ${d.generations} generations"><span>${esc(d.day.slice(5))}</span></div>`).join('')}</div>` : '<span class="mini">No data yet.</span>'}</div></div>
    <div class="card"><h2>Recent activity</h2>${u.recent.length ? `<div class="table-wrap"><table><tr><th>Title</th><th>Voice</th><th>Chars</th><th>Date</th></tr>${u.recent.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.voiceName)}</td><td>${nf(r.chars)}</td><td>${fmtDate(r.created)}</td></tr>`).join('')}</table></div>` : '<span class="mini">No data yet.</span>'}</div>`;
};

/* ---- API Settings ---- */
PAGE.api = async (c) => {
  await reloadStatus(); const st = S.status, se = S.settings;
  c.innerHTML = head('API Settings', 'Connect your HeyGen API key and choose the speech model.') + `
  <div class="card"><div class="row sp"><div><h2>Connection status</h2><span class="badge ${st.connected ? 'ACTIVE' : 'FAILED'}">${st.connected ? 'Connected' : 'Not connected'}</span> ${st.last4 ? `<span class="mini">Key ••••${esc(st.last4)}</span>` : ''}</div>
    <div class="row"><button class="btn ghost" id="test" ${st.hasKey ? '' : 'disabled'}>Test connection</button><button class="btn danger" id="rm" ${st.hasKey ? '' : 'disabled'}>Remove key</button></div></div><div id="tmsg"></div></div>
  <div class="card"><h2>Add your HeyGen API key</h2><div class="field"><label>HeyGen API key</label><input type="password" id="key" autocomplete="off" placeholder="Paste your key here"></div>
    <div class="row"><button class="btn" id="save">Verify &amp; save key</button>${st.envFile ? `<button class="btn ghost" id="imp">Import from ${esc(st.envFile)}</button>` : ''}</div>
    <div class="hint">The key is checked with one lightweight live call first, and saved (encrypted, server-side only) only if HeyGen accepts it. After saving, only the last 4 characters are ever shown.</div><div id="kmsg"></div></div>
  <div class="card"><h2>Text-to-speech model</h2><select id="model">${se.models.map((m) => `<option ${m === se.model ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <div class="hint">heygen-voice-1-turbo-free costs $0 during HeyGen's free window, which ends <b>30 Nov 2026</b>. Afterwards turbo is $4 and the full model $15 per 1M characters. You can switch the model here at any time — no rebuild needed.</div><div id="mmsg"></div></div>`;
  const done = async (el, ok, msg) => { el.innerHTML = `<div class="alert ${ok ? 'ok' : 'err'}">${esc(msg)}</div>`; await reloadStatus(); };
  $('#test').onclick = async () => { try { const r = await post('/key/test'); done($('#tmsg'), true, `Connected — key verified via ${r.via}.`); } catch (e) { done($('#tmsg'), false, e.message); } };
  $('#rm').onclick = async () => { if (!sure('Remove the saved API key?')) return; await del('/key'); await reloadStatus(); route(); };
  $('#save').onclick = async (ev) => {
    ev.target.disabled = true; $('#kmsg').innerHTML = '<div class="alert info"><span class="spinner sm"></span> Verifying with HeyGen…</div>';
    try { const r = await post('/key', { key: $('#key').value }); $('#key').value = ''; await reloadStatus(); route(); toast(`Key verified and saved (••••${r.last4})`); }
    catch (e) { $('#kmsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; ev.target.disabled = false; }
  };
  if ($('#imp')) $('#imp').onclick = async () => { try { const r = await post('/key/import-file'); await reloadStatus(); route(); toast(`Key imported from ${r.file} (••••${r.last4})`); } catch (e) { $('#kmsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; } };
  $('#model').onchange = async (e) => { try { S.settings = await put('/settings', { model: e.target.value }); refreshFooter(); $('#mmsg').innerHTML = `<div class="alert ok">Model switched to ${esc(e.target.value)} — used for all new generations.</div>`; } catch (err) { $('#mmsg').innerHTML = `<div class="alert err">${esc(err.message)}</div>`; } };
};

/* ---- Account ---- */
PAGE.account = async (c) => {
  c.innerHTML = head('Account Settings', 'Change your studio password.') + `<div class="card" style="max-width:480px"><div class="field"><label>Current password</label><input type="password" id="cur" autocomplete="current-password"></div>
    <div class="field"><label>New password (min 8 characters)</label><input type="password" id="nw" autocomplete="new-password"></div><div id="amsg"></div><button class="btn" id="chg">Change password</button></div>`;
  $('#chg').onclick = async () => {
    try { await post('/account/password', { current: $('#cur').value, next: $('#nw').value }); $('#amsg').innerHTML = '<div class="alert ok">Password changed.</div>'; $('#cur').value = $('#nw').value = ''; }
    catch (e) { $('#amsg').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  };
};

boot();
