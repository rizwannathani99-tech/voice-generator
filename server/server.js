'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./db');
const H = require('./heygen');
const A = require('./audio');

const { db } = D;
const PORT = Number(process.env.PORT) || 3000;
const MODELS = ['heygen-voice-1-turbo-free', 'heygen-voice-1-turbo', 'heygen-voice-1'];
const CHUNK_MAX = 4500; // safely under the 5,000-character limit
const DESIGN_LANGS = 'ar be bg ca cs da de el en es fa fi fil fr he hi hr hu id it ja ko mk ms nl pl pt ro ru sk sl sr sv ta th tl tr uk vi zh'.split(' ');

// ---------- startup checks (fail loudly) ----------
let FFMPEG_VERSION;
try { FFMPEG_VERSION = A.checkFfmpeg(); }
catch (e) { console.error('\nSTARTUP FAILED: ' + e.message + '\n'); process.exit(1); }
if (process.argv.includes('--check')) { console.log('OK — ' + FFMPEG_VERSION); process.exit(0); }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const now = () => Date.now();
const uid = () => crypto.randomUUID();

// ---------- cookies / auth ----------
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function setSessionCookie(req, res, token, expires) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expires).toUTCString()}${secure}`);
}
const hasAdmin = () => !!db.prepare('SELECT 1 FROM admin WHERE id = 1').get();
// Login was removed on request: the studio is single-user and only listens on localhost (see app.listen).
function auth(req, res, next) { next(); }
const attempts = new Map();
function throttle(req) {
  const k = req.ip; const a = attempts.get(k) || { n: 0, t: now() };
  if (now() - a.t > 10 * 60000) { a.n = 0; a.t = now(); }
  a.n++; attempts.set(k, a);
  if (a.n > 10) throw fail(429, 'Too many sign-in attempts — wait a few minutes and try again.');
}

app.get('/api/health', (req, res) => res.json({ ok: true, ffmpeg: FFMPEG_VERSION }));

app.get('/api/session', (req, res) => {
  res.json({ hasAdmin: true, authed: true });
});

function validCreds(username, password) {
  if (!username || !String(username).trim()) throw fail(400, 'Please enter a username.');
  if (!password) throw fail(400, 'Please enter a password.');
  if (String(password).length < 8) throw fail(400, 'Password must be at least 8 characters.');
}

app.post('/api/setup', wrap(async (req, res) => {
  if (hasAdmin()) throw fail(409, 'An admin account already exists — please log in.');
  const { username, password } = req.body || {};
  validCreds(username, password);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admin (id, username, salt, hash) VALUES (1, ?, ?, ?)').run(String(username).trim(), salt, D.hashPassword(password, salt));
  const s = D.createSession(); setSessionCookie(req, res, s.token, s.expires);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  throttle(req);
  const { username, password } = req.body || {};
  if (!username || !password) throw fail(400, 'Please enter your username and password.');
  const a = db.prepare('SELECT * FROM admin WHERE id = 1').get();
  if (!a) throw fail(400, 'No admin account exists yet — create one first.');
  const ok = a.username === String(username).trim() &&
    crypto.timingSafeEqual(Buffer.from(D.hashPassword(password, a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  if (!ok) throw fail(401, 'Wrong username or password.');
  attempts.delete(req.ip);
  const s = D.createSession(); setSessionCookie(req, res, s.token, s.expires);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  D.destroySession(cookie(req, 'sid'));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// everything below requires a session
app.use('/api', auth);

app.post('/api/account/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!current) throw fail(400, 'Enter your current password.');
  if (!next || String(next).length < 8) throw fail(400, 'New password must be at least 8 characters.');
  const a = db.prepare('SELECT * FROM admin WHERE id = 1').get();
  const ok = crypto.timingSafeEqual(Buffer.from(D.hashPassword(current, a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  if (!ok) throw fail(401, 'Current password is incorrect.');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admin SET salt = ?, hash = ? WHERE id = 1').run(salt, D.hashPassword(next, salt));
  res.json({ ok: true });
}));

// ---------- API key & settings ----------
const ENV_FILES = ['key.env.txt', 'key.env', '.env'].map((f) => path.join(D.ROOT, f));
function readEnvFileKey() {
  for (const f of ENV_FILES) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const l of lines) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      const v = (m ? m[2] : l).trim().replace(/^["']|["']$/g, '');
      if (v.length >= 16 && !/\s/.test(v)) return { file: path.basename(f), key: v };
    }
  }
  return null;
}
const requireKey = () => { const k = D.getApiKey(); if (!k) throw new H.NotConnectedError(); return k; };

async function verifyAndSave(key) {
  const v = await H.verifyKey(key);        // 1) lightweight live check — invalid keys throw here
  D.saveApiKey(key);                       // 2) only now saved (encrypted)
  D.setSetting('api_ok', '1');
  return v;
}

function settingsOut() {
  return {
    model: D.getSetting('model'), pace: Number(D.getSetting('pace')), polish: D.getSetting('polish') === '1',
    emotion: Number(D.getSetting('emotion')), ttsLanguage: D.getSetting('tts_language') || '', models: MODELS,
  };
}
const voiceCounts = () => ({
  library: db.prepare("SELECT COUNT(*) c FROM voices WHERE kind='public'").get().c,
  cloned: db.prepare("SELECT COUNT(*) c FROM voices WHERE kind='private'").get().c,
  profiles: db.prepare('SELECT COUNT(*) c FROM profiles').get().c,
});

app.get('/api/status', (req, res) => {
  const key = D.getApiKey();
  const env = !key ? readEnvFileKey() : null;
  res.json({
    connected: !!key && D.getSetting('api_ok') === '1', hasKey: !!key, last4: key ? D.getSetting('api_key_last4') : null,
    model: D.getSetting('model'), envFile: env ? env.file : null, refresh: refreshState, counts: voiceCounts(),
  });
});

app.get('/api/settings', (req, res) => res.json(settingsOut()));
app.put('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.model !== undefined) {
    if (!MODELS.includes(b.model)) throw fail(400, `Unknown model "${b.model}". Choose one of: ${MODELS.join(', ')}.`);
    D.setSetting('model', b.model);
  }
  if (b.pace !== undefined) D.setSetting('pace', A.clampPace(b.pace));
  if (b.polish !== undefined) D.setSetting('polish', b.polish ? '1' : '0');
  if (b.emotion !== undefined) D.setSetting('emotion', Math.min(1, Math.max(0, Number(b.emotion) || 0)));
  if (b.ttsLanguage !== undefined) D.setSetting('tts_language', String(b.ttsLanguage).trim().toLowerCase());
  res.json(settingsOut());
}));

app.post('/api/key', wrap(async (req, res) => {
  const key = String((req.body || {}).key || '').trim();
  if (!key) throw fail(400, 'Paste your HeyGen API key first.');
  if (/\s/.test(key) || key.length < 16) throw fail(400, 'That does not look like a HeyGen API key (it should be one long string without spaces).');
  const v = await verifyAndSave(key);
  autoLoadLibrary();
  res.json({ ok: true, last4: key.slice(-4), via: v.via, user: v.user });
}));
app.post('/api/key/import-file', wrap(async (req, res) => {
  const e = readEnvFileKey();
  if (!e) throw fail(404, 'No key file found (looked for key.env.txt, key.env, .env in the studio folder).');
  const v = await verifyAndSave(e.key);
  autoLoadLibrary();
  res.json({ ok: true, last4: e.key.slice(-4), file: e.file, via: v.via });
}));
app.post('/api/key/test', wrap(async (req, res) => {
  const key = requireKey();
  try { const v = await H.verifyKey(key); D.setSetting('api_ok', '1'); res.json({ ok: true, via: v.via, user: v.user }); }
  catch (e) { if (e.status === 401) D.setSetting('api_ok', '0'); throw e; }
}));
app.delete('/api/key', (req, res) => { D.removeApiKey(); D.setSetting('api_ok', null); res.json({ ok: true }); });

// ---------- voice cache ----------
const upsertVoice = db.prepare(`INSERT INTO voices (voice_id, kind, name, language, gender, status, preview_url, tags, mode, locale, failure_reason, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(voice_id, kind) DO UPDATE SET name=excluded.name, language=excluded.language, gender=excluded.gender,
  status=excluded.status, preview_url=excluded.preview_url, tags=excluded.tags, mode=excluded.mode, locale=excluded.locale, failure_reason=excluded.failure_reason, created_at=excluded.created_at`);
function putVoice(v, kind) {
  upsertVoice.run(v.voice_id, kind, v.name ?? null, v.language ?? null, v.gender ?? null, v.status ?? null, v.preview_audio_url ?? null,
    v.tags ? JSON.stringify(v.tags) : null, v.mode ?? null, v.locale ?? null, v.failure_reason ?? null, v.created_at ?? null);
}
function replaceVoices(rows, kind) {
  db.exec('BEGIN');
  try { db.prepare('DELETE FROM voices WHERE kind = ?').run(kind); for (const v of rows) putVoice(v, kind); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
// HeyGen reports designed voices as "instant"; remember which ones WE created via design mode.
const designIds = () => { try { return new Set(JSON.parse(D.getSetting('design_ids') || '[]')); } catch { return new Set(); } };
const markDesigned = (id) => { const s = designIds(); s.add(id); D.setSetting('design_ids', JSON.stringify([...s])); };
const voiceOut = (r) => ({ ...r, mode: designIds().has(r.voice_id) ? 'design' : r.mode, tags: r.tags ? JSON.parse(r.tags) : [] });

let refreshState = { running: false, count: 0, pages: 0, error: null, doneAt: null };
async function refreshPublic() {
  if (refreshState.running) return refreshState;
  const key = requireKey();
  refreshState = { running: true, count: 0, pages: 0, error: null, doneAt: null };
  try {
    const rows = await H.listAllVoices(key, 'public', (count, pages) => { refreshState.count = count; refreshState.pages = pages; });
    replaceVoices(rows, 'public');
    refreshState.doneAt = now();
  } catch (e) { refreshState.error = e.message; }
  refreshState.running = false;
  return refreshState;
}
function autoLoadLibrary() {
  if (!D.getApiKey() || refreshState.running) return;
  if (db.prepare("SELECT COUNT(*) c FROM voices WHERE kind='public'").get().c === 0) refreshPublic().catch(() => {});
}

app.post('/api/voices/refresh', wrap(async (req, res) => {
  requireKey();
  if (!refreshState.running) refreshPublic().catch(() => {});
  res.json(refreshState);
}));
app.get('/api/voices/refresh-status', (req, res) => res.json({ ...refreshState, counts: voiceCounts() }));

app.get('/api/voices', (req, res) => {
  const { q = '', language = '', gender = '', status = '', kind = 'public' } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 24));
  const where = kind === 'all' ? ['1 = 1'] : ['kind = ?']; const args = kind === 'all' ? [] : [kind === 'private' ? 'private' : 'public'];
  for (const w of String(q).toLowerCase().split(/\s+/).filter(Boolean)) {
    where.push("(LOWER(COALESCE(name,'')) LIKE ? OR LOWER(COALESCE(language,'')) LIKE ? OR LOWER(COALESCE(tags,'')) LIKE ? OR LOWER(voice_id) = ?)");
    args.push(`%${w}%`, `%${w}%`, `%${w}%`, w);
  }
  if (language) { where.push('LOWER(language) = ?'); args.push(String(language).toLowerCase()); }
  if (gender) { where.push('gender = ?'); args.push(gender); }
  if (status) { where.push('status = ?'); args.push(status); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM voices WHERE ${w}`).get(...args).c;
  const items = db.prepare(`SELECT * FROM voices WHERE ${w} ORDER BY kind ASC, name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size).map(voiceOut);
  res.json({ items, total, page, pageSize: size });
});
app.get('/api/voices/languages', (req, res) => {
  res.json(db.prepare("SELECT language, COUNT(*) count FROM voices WHERE kind='public' AND language IS NOT NULL GROUP BY language ORDER BY count DESC").all());
});
app.get('/api/voices/lookup/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM voices WHERE voice_id = ? ORDER BY kind DESC').get(req.params.id);
  if (!r) throw fail(404, 'That voice is not in the local cache — refresh the library or private list.');
  res.json(voiceOut(r));
});

app.post('/api/voices/private/refresh', wrap(async (req, res) => {
  const key = requireKey();
  const rows = await H.listAllVoices(key, 'private');
  replaceVoices(rows, 'private');
  res.json({ ok: true, count: rows.length });
}));
app.post('/api/voices/:id/status', wrap(async (req, res) => {
  const key = requireKey();
  const v = await H.getVoice(key, req.params.id);
  putVoice(v, 'private');
  res.json(voiceOut(db.prepare("SELECT * FROM voices WHERE voice_id=? AND kind='private'").get(v.voice_id)));
}));

// ---------- saved profiles ----------
app.get('/api/profiles', (req, res) => res.json(db.prepare('SELECT * FROM profiles ORDER BY is_default DESC, name COLLATE NOCASE').all()));
app.post('/api/profiles', wrap(async (req, res) => {
  const { name, voiceId, voiceName, language, makeDefault } = req.body || {};
  if (!voiceId) throw fail(400, 'Pick a voice before saving a profile.');
  const nm = String(name || voiceName || '').trim();
  if (!nm) throw fail(400, 'Give the profile a name.');
  const dup = db.prepare('SELECT id FROM profiles WHERE voice_id = ? AND name = ?').get(voiceId, nm);
  let id = dup ? dup.id : Number(db.prepare('INSERT INTO profiles (name, voice_id, voice_name, language, is_default, created) VALUES (?,?,?,?,0,?)').run(nm, voiceId, voiceName || nm, language || null, now()).lastInsertRowid);
  if (makeDefault || db.prepare('SELECT COUNT(*) c FROM profiles').get().c === 1) {
    db.prepare('UPDATE profiles SET is_default = 0').run(); db.prepare('UPDATE profiles SET is_default = 1 WHERE id = ?').run(id);
  }
  res.json(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}));
app.patch('/api/profiles/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id)) throw fail(404, 'Profile not found.');
  const { name, isDefault } = req.body || {};
  if (name !== undefined) { if (!String(name).trim()) throw fail(400, 'Name cannot be empty.'); db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(String(name).trim(), id); }
  if (isDefault) { db.prepare('UPDATE profiles SET is_default = 0').run(); db.prepare('UPDATE profiles SET is_default = 1 WHERE id = ?').run(id); }
  res.json(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}));
app.delete('/api/profiles/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  if (p && p.is_default) { const n = db.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get(); if (n) db.prepare('UPDATE profiles SET is_default = 1 WHERE id = ?').run(n.id); }
  res.json({ ok: true });
});

// ---------- text to speech: plan -> generate chunk by chunk -> merge ----------
function readJobParams(b) {
  const text = String(b.text || '');
  if (!text.trim()) throw fail(400, 'Write or paste a script first.');
  if (!b.voiceId) throw fail(400, 'Choose a voice first (saved profile, library search, or Voice Library).');
  const language = String(b.language ?? D.getSetting('tts_language') ?? '').trim().toLowerCase();
  if (language && !/^[a-z]{2,3}$/.test(language)) throw fail(400, 'Language must be a lowercase base code such as en, hi or ur (no regional tags like en-US). Leave it blank to use the voice\'s own language.');
  return {
    text, language,
    pace: A.clampPace(b.pace ?? D.getSetting('pace')),
    polish: (b.polish ?? D.getSetting('polish') === '1') ? 1 : 0,
    emotion: Math.min(1, Math.max(0, Number(b.emotion ?? D.getSetting('emotion')))),
  };
}
function planJob(b) {
  requireKey();
  const p = readJobParams(b);
  const chunks = A.splitText(p.text, CHUNK_MAX);
  const id = uid();
  fs.mkdirSync(path.join(D.JOBS_DIR, id), { recursive: true });
  const vName = b.voiceName || (db.prepare('SELECT name FROM voices WHERE voice_id = ? LIMIT 1').get(b.voiceId) || {}).name || b.voiceId;
  db.prepare('INSERT INTO jobs (id,title,voice_id,voice_name,language,model,pace,polish,emotion,status,total,done,chars,chunks,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, String(b.title || 'Untitled script').slice(0, 120), b.voiceId, vName, p.language || null, D.getSetting('model'), p.pace, p.polish, p.emotion, 'planned', chunks.length, 0, chunks.reduce((n, c) => n + c.length, 0), JSON.stringify(chunks), now());
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}
// Multi-narrator: every block has its own voice; each block is split at sentence boundaries if it is long.
function planDialogue(b) {
  requireKey();
  const blocks = Array.isArray(b.blocks) ? b.blocks : [];
  if (!blocks.length) throw fail(400, 'Add at least one narrator block.');
  if (blocks.length > 80) throw fail(400, 'Too many blocks (maximum 80 per generation).');
  const items = [], names = [];
  blocks.forEach((bl, i) => {
    if (!bl.voiceId) throw fail(400, `Block ${i + 1}: choose a narrator (voice) first.`);
    if (!String(bl.text || '').trim()) throw fail(400, `Block ${i + 1}: write the text for this narrator.`);
    const nm = bl.voiceName || (db.prepare('SELECT name FROM voices WHERE voice_id = ? LIMIT 1').get(bl.voiceId) || {}).name || bl.voiceId;
    if (!names.includes(nm)) names.push(nm);
    for (const t of A.splitText(String(bl.text), CHUNK_MAX)) items.push({ t, v: bl.voiceId });
  });
  const p = readJobParams({ ...b, text: items[0].t, voiceId: items[0].v });
  const gap = Math.min(2, Math.max(0, Number(b.gap ?? 0.35) || 0));
  const id = uid();
  fs.mkdirSync(path.join(D.JOBS_DIR, id), { recursive: true });
  db.prepare('INSERT INTO jobs (id,title,voice_id,voice_name,language,model,pace,polish,emotion,status,total,done,chars,chunks,created,gap) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, String(b.title || 'Multi-narrator story').slice(0, 120), items[0].v, names.join(' + ').slice(0, 200), p.language || null, D.getSetting('model'), p.pace, p.polish, p.emotion, 'planned', items.length, 0, items.reduce((n, c) => n + c.t.length, 0), JSON.stringify(items), now(), gap);
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}
const getJob = (id) => { const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); if (!j) throw fail(404, 'That generation job no longer exists (it may have been cancelled).'); return j; };
const jobDir = (id) => path.join(D.JOBS_DIR, id);
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true });

async function stepJob(job) {
  const key = requireKey();
  if (job.done >= job.total) return { done: job.done, total: job.total, notes: [] };
  const notes = [];
  const item = JSON.parse(job.chunks)[job.done];
  const text = typeof item === 'string' ? item : item.t;
  const voiceId = (typeof item === 'object' && item.v) || job.voice_id;
  const t = await H.tts(key, { model: job.model, voiceId, text, language: job.language, expressiveness: job.emotion }, notes);
  const buf = await H.download(t.url);
  fs.writeFileSync(path.join(jobDir(job.id), `chunk_${String(job.done).padStart(3, '0')}.wav`), buf);
  db.prepare('UPDATE jobs SET done = done + 1, status = ? WHERE id = ?').run('generating', job.id);
  return { done: job.done + 1, total: job.total, notes };
}
async function finishJob(job) {
  if (job.done < job.total) throw fail(409, `Only ${job.done} of ${job.total} chunks are generated — keep generating before merging.`);
  const dir = jobDir(job.id);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('chunk_')).sort().map((f) => path.join(dir, f));
  if (files.length !== job.total) throw fail(500, `Chunk files are missing on the server (${files.length} of ${job.total}) — please regenerate.`);
  const id = uid();
  const out = path.join(D.AUDIO_DIR, `${id}.mp3`);
  let list = files;
  if (job.gap > 0) { // short natural pause whenever the narrator changes
    const items = JSON.parse(job.chunks); const sil = path.join(dir, 'gap.wav');
    await A.makeSilence(files[0], sil, job.gap);
    list = [];
    files.forEach((f, i) => { if (i > 0 && items[i].v !== items[i - 1].v) list.push(sil); list.push(f); });
  }
  const dur = await A.mergeAndProcess(list, path.join(dir, 'list.txt'), out, { pace: job.pace, polish: !!job.polish });
  db.prepare('INSERT INTO history (id,title,voice_id,voice_name,chars,duration,pace,pace_label,chunks,file,model,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, job.title, job.voice_id, job.voice_name, job.chars, dur, job.pace, A.paceLabel(job.pace), job.total, `${id}.mp3`, job.model, now());
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id); rmDir(dir);
  return db.prepare('SELECT * FROM history WHERE id = ?').get(id);
}

app.post('/api/jobs/plan', wrap(async (req, res) => {
  const j = planJob(req.body || {});
  res.json({ id: j.id, total: j.total, chars: j.chars });
}));
app.post('/api/jobs/plan-dialogue', wrap(async (req, res) => {
  const j = planDialogue(req.body || {});
  res.json({ id: j.id, total: j.total, chars: j.chars });
}));
app.post('/api/jobs/:id/step', wrap(async (req, res) => res.json(await stepJob(getJob(req.params.id)))));
app.post('/api/jobs/:id/finish', wrap(async (req, res) => res.json(await finishJob(getJob(req.params.id)))));
app.delete('/api/jobs/:id', (req, res) => { db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id); rmDir(jobDir(req.params.id)); res.json({ ok: true }); });

// short script: one HeyGen call in one request
app.post('/api/tts/generate', wrap(async (req, res) => {
  const job = planJob(req.body || {});
  try {
    if (job.total !== 1) throw fail(400, 'This script is long — use the chunked job flow.');
    const s = await stepJob(job);
    const entry = await finishJob(getJob(job.id));
    res.json({ ...entry, notes: s.notes });
  } catch (e) { db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id); rmDir(jobDir(job.id)); throw e; }
}));

// self-generated sample preview: goes through the exact same pipeline (pace included)
app.post('/api/tts/preview', wrap(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || 'Hello, this is a short preview of how this voice sounds when it reads your script.');
  const job = planJob({ ...b, text, title: 'Sample preview' });
  try { const s = await stepJob(job); const e = await finishJob(getJob(job.id)); res.json({ ...e, notes: s.notes }); }
  catch (e) { db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id); rmDir(jobDir(job.id)); throw e; }
}));

// ---------- history & usage ----------
const histOut = (r) => ({ id: r.id, title: r.title, voiceId: r.voice_id, voiceName: r.voice_name, chars: r.chars, duration: r.duration, pace: r.pace, paceLabel: r.pace_label, chunks: r.chunks, model: r.model, created: r.created });
app.get('/api/history', (req, res) => res.json(db.prepare('SELECT * FROM history ORDER BY created DESC').all().map(histOut)));
function historyFile(id) {
  const r = db.prepare('SELECT * FROM history WHERE id = ?').get(id);
  if (!r) throw fail(404, 'That audio entry no longer exists.');
  const f = path.join(D.AUDIO_DIR, r.file);
  if (!fs.existsSync(f)) throw fail(410, 'The audio file for this entry is missing on the server.');
  return { r, f };
}
app.get('/api/history/:id/audio', wrap(async (req, res) => { const { f } = historyFile(req.params.id); res.type('audio/mpeg').sendFile(f); }));
app.get('/api/history/:id/download', wrap(async (req, res) => {
  const { r, f } = historyFile(req.params.id);
  const base = (r.title || 'voiceover').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'voiceover';
  if (req.query.format === 'wav') {
    const tmp = path.join(D.JOBS_DIR, `${uid()}.wav`);
    await A.toWav(f, tmp);
    return res.download(tmp, `${base}.wav`, () => fs.rmSync(tmp, { force: true }));
  }
  res.download(f, `${base}.mp3`);
}));
app.delete('/api/history/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM history WHERE id = ?').get(req.params.id);
  if (r) { fs.rmSync(path.join(D.AUDIO_DIR, r.file), { force: true }); db.prepare('DELETE FROM history WHERE id = ?').run(r.id); }
  res.json({ ok: true });
});
function usage() {
  const t = db.prepare('SELECT COUNT(*) gens, COALESCE(SUM(chars),0) chars, COALESCE(SUM(duration),0) seconds FROM history').get();
  return {
    generations: t.gens, characters: t.chars, seconds: t.seconds,
    byVoice: db.prepare('SELECT voice_name name, voice_id, COUNT(*) generations, SUM(chars) chars FROM history GROUP BY voice_id ORDER BY chars DESC').all(),
    byDay: db.prepare("SELECT date(created/1000,'unixepoch','localtime') day, COUNT(*) generations, SUM(chars) chars FROM history GROUP BY day ORDER BY day DESC LIMIT 14").all(),
    recent: db.prepare('SELECT * FROM history ORDER BY created DESC LIMIT 8').all().map(histOut),
  };
}
app.get('/api/usage', (req, res) => res.json(usage()));
app.get('/api/dashboard', (req, res) => { const u = usage(); res.json({ counts: voiceCounts(), generations: u.generations, characters: u.characters, recent: u.recent }); });

// ---------- voice cloning (chunked upload -> stage -> transcode -> ONE HeyGen call) ----------
const MAX_SAMPLE = 16 * 1024 * 1024;
const stageFile = (id) => path.join(D.STAGE_DIR, `${id}.bin`);
const stageMeta = new Map();
app.post('/api/clone/init', wrap(async (req, res) => {
  const { filename = '', size, consent } = req.body || {};
  if (consent !== true) throw fail(400, 'You must confirm this is your own voice (or you have the owner\'s permission) before uploading.');
  if (!/\.(mp3|wav)$/i.test(filename)) throw fail(400, 'Only MP3 or WAV samples are accepted.');
  if (!(size > 0)) throw fail(400, 'The sample file is empty.');
  if (size > MAX_SAMPLE) throw fail(400, `The sample is ${(size / 1048576).toFixed(1)} MB — the limit is 16 MB.`);
  const id = uid();
  fs.writeFileSync(stageFile(id), Buffer.alloc(0));
  stageMeta.set(id, { size, filename, created: now() });
  res.json({ uploadId: id });
}));
app.put('/api/clone/:id/chunk', express.raw({ type: () => true, limit: '2mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'The upload chunk was empty.');
  const m = stageMeta.get(req.params.id);
  if (!m) throw fail(404, 'Upload session not found — start the upload again.');
  const f = stageFile(req.params.id);
  const have = fs.statSync(f).size;
  const offset = Number(req.query.offset);
  if (offset !== have) throw fail(409, `Upload out of sync (server has ${have} bytes, got offset ${offset}) — start the upload again.`);
  if (have + req.body.length > Math.min(m.size, MAX_SAMPLE)) throw fail(400, 'Received more data than the declared file size.');
  fs.appendFileSync(f, req.body);
  res.json({ received: have + req.body.length });
}));

function sniffAudio(file) {
  const b = Buffer.alloc(12); const fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  const wav = b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';
  const mp3 = b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  return wav || mp3;
}
app.post('/api/clone/:id/finish', wrap(async (req, res) => {
  const b = req.body || {};
  const id = req.params.id;
  // --- every check below happens BEFORE any HeyGen call ---
  if (b.consent !== true) throw fail(400, 'You must confirm this is your own voice (or you have the owner\'s explicit permission) before cloning.');
  const name = String(b.name || '').trim();
  if (name.length < 1 || name.length > 64) throw fail(400, 'Voice name must be 1–64 characters.');
  const language = String(b.language || '').trim().toLowerCase();
  if (language && !/^[a-z]{2,3}$/.test(language)) throw fail(400, 'Language must be a base code such as en or hi — or leave it blank (safest).');
  const m = stageMeta.get(id);
  if (!m || !fs.existsSync(stageFile(id))) throw fail(404, 'Staged sample not found — upload the file again.');
  const f = stageFile(id);
  const size = fs.statSync(f).size;
  try {
    if (size !== m.size) throw fail(400, `Upload incomplete: server received ${size} of ${m.size} bytes.`);
    if (size > MAX_SAMPLE) throw fail(400, 'The sample is larger than 16 MB.');
    if (!sniffAudio(f)) throw fail(400, 'That file is not a valid MP3 or WAV audio file.');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (b.sha256 && b.sha256 !== sha) throw fail(400, 'The uploaded bytes do not match the original file (checksum mismatch) — please upload again.');
    const key = requireKey();
    const small = f + '.mp3';
    await A.transcodeSample(f, small);
    const mini = fs.readFileSync(small);
    const voiceId = await H.createInstantVoice(key, { name, language, base64: mini.toString('base64'), mediaType: 'audio/mpeg' });
    putVoice({ voice_id: voiceId, name, language: language || null, status: 'PENDING', mode: 'instant', created_at: Math.floor(now() / 1000) }, 'private');
    fs.rmSync(small, { force: true });
    res.json({ voiceId, status: 'PENDING', stagedSha256: sha, originalBytes: size, sentBytes: mini.length });
  } finally { fs.rmSync(f, { force: true }); stageMeta.delete(id); }
}));

// ---------- voice design ----------
const LANG_NAMES = { en: 'english', hi: 'hindi', ur: 'urdu', es: 'spanish', fr: 'french', de: 'german', ar: 'arabic', pt: 'portuguese', it: 'italian', ja: 'japanese', ko: 'korean', zh: 'chinese' };
const STOP = new Set('a an the and or of with in on to for is are voice voices very quite sounds sound like'.split(' '));
app.post('/api/design/match', wrap(async (req, res) => {
  const { language = 'any', gender = '', description = '', tags = [] } = req.body || {};
  const tokens = [...new Set(`${description} ${(tags || []).join(' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)))];
  const code = String(language).toLowerCase();
  const rows = db.prepare("SELECT * FROM voices WHERE kind='public' AND status IN ('ACTIVE') OR (kind='public' AND status IS NULL)").all().map(voiceOut);
  if (!rows.length) throw fail(409, 'The voice library is empty — open the Voice Library page (or add your API key) so it can load first.');
  const wanted = LANG_NAMES[code];
  const langMatch = (v) => { const l = (v.language || '').toLowerCase(); return l === code || l.startsWith(code + '-') || (wanted && l === wanted); };
  const max = 5 + 4 + tokens.length * 3;
  const scored = [];
  for (const v of rows) {
    if (code !== 'any' && !langMatch(v)) continue;
    if (gender && v.gender && v.gender !== gender.toLowerCase()) continue;
    let s = 0;
    if (code !== 'any') s += 5;
    if (gender && v.gender === gender.toLowerCase()) s += 4;
    const hay = `${v.name || ''} ${v.tags.join(' ')} ${v.locale || ''}`.toLowerCase();
    const words = new Set(hay.split(/[^a-z0-9]+/));
    for (const t of tokens) {
      if (v.tags.some((x) => x.toLowerCase().split(/[^a-z0-9]+/).includes(t))) s += 3;
      else if (words.has(t) || hay.includes(t)) s += 1.5;
    }
    scored.push({ ...v, score: Math.min(100, Math.round((s / max) * 100)), raw: s });
  }
  scored.sort((a, b) => b.raw - a.raw || (a.name || '').localeCompare(b.name || ''));
  res.json({ items: scored.slice(0, 24), total: scored.length, tokens });
}));
app.post('/api/design/create', wrap(async (req, res) => {
  const key = requireKey();
  const { name, language = 'en', description } = req.body || {};
  const nm = String(name || '').trim();
  if (nm.length < 1 || nm.length > 64) throw fail(400, 'Voice name must be 1–64 characters.');
  const desc = String(description || '').trim();
  if (desc.length < 20 || desc.length > 500) throw fail(400, `The description must be 20–500 characters (it is ${desc.length}). Describe age, tone, accent and speaking style.`);
  const lang = String(language).toLowerCase() === 'any' ? 'en' : String(language).toLowerCase();
  if (!DESIGN_LANGS.includes(lang)) throw fail(400, `Voice design does not support language "${lang}". Supported: ${DESIGN_LANGS.join(', ')}.`);
  const voiceId = await H.createDesignedVoice(key, { name: nm, language: lang, description: desc });
  markDesigned(voiceId);
  putVoice({ voice_id: voiceId, name: nm, language: lang, status: 'PENDING', mode: 'design', created_at: Math.floor(now() / 1000) }, 'private');
  res.json({ voiceId, status: 'PENDING' });
}));

// ---------- static + errors ----------
app.use('/api', (req, res, next) => next(fail(404, `Unknown API route: ${req.method} ${req.originalUrl}`)));
app.use(express.static(path.join(D.ROOT, 'public'), { etag: true, maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(D.ROOT, 'public', 'index.html')));
app.use((err, req, res, next) => { // eslint-disable-line
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  let msg = err.message || String(err);
  if (err.type === 'entity.parse.failed') msg = 'The request body was not valid JSON.';
  if (status === 500 && !err.heygen) msg = `Unexpected server error: ${msg}`;
  if (status >= 500 || err.heygen) console.error(`[${req.method} ${req.originalUrl}] ${msg}`);
  res.status(err.heygen && (err.status === 0 || !err.status) ? 502 : status === 401 && err.heygen ? 400 : status).json({ error: msg });
});

// cleanup stale jobs / stages
for (const j of db.prepare('SELECT id FROM jobs WHERE created < ?').all(now() - 24 * 3600000)) { db.prepare('DELETE FROM jobs WHERE id = ?').run(j.id); rmDir(jobDir(j.id)); }
for (const f of fs.readdirSync(D.STAGE_DIR)) fs.rmSync(path.join(D.STAGE_DIR, f), { force: true });

app.listen(PORT, process.env.HOST || '127.0.0.1', async () => {
  console.log(`\n  Voice Studio running →  http://localhost:${PORT}\n  ${FFMPEG_VERSION}\n`);
  // First run: pick up the key from key.env.txt (verified with the lightweight call before saving).
  if (!D.getApiKey()) {
    const e = readEnvFileKey();
    if (e) { try { await verifyAndSave(e.key); console.log(`  API key imported from ${e.file} (••••${e.key.slice(-4)})`); } catch (err) { console.log(`  Key in ${e.file} was NOT saved: ${err.message}`); } }
  }
  autoLoadLibrary();
});
