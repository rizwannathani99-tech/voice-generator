'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const STAGE_DIR = path.join(DATA_DIR, 'stage');
for (const d of [DATA_DIR, AUDIO_DIR, JOBS_DIR, STAGE_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'studio.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS voices (
  voice_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, language TEXT, gender TEXT, status TEXT,
  preview_url TEXT, tags TEXT, mode TEXT, locale TEXT, failure_reason TEXT, created_at INTEGER,
  PRIMARY KEY (voice_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_voices_kind ON voices(kind);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, voice_id TEXT NOT NULL, voice_name TEXT,
  language TEXT, is_default INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, title TEXT, voice_id TEXT, voice_name TEXT, language TEXT, model TEXT,
  pace REAL, polish INTEGER, emotion REAL, status TEXT, total INTEGER, done INTEGER, chars INTEGER,
  chunks TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY, title TEXT, voice_id TEXT, voice_name TEXT, chars INTEGER, duration REAL,
  pace REAL, pace_label TEXT, chunks INTEGER, file TEXT, model TEXT, created INTEGER
);
`);

try { db.exec('ALTER TABLE jobs ADD COLUMN gap REAL DEFAULT 0'); } catch { /* column already exists */ }

// ---------- encryption for the API key (AES-256-GCM, key file kept next to the DB) ----------
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const MASTER = Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- settings ----------
const DEFAULTS = { model: 'heygen-voice-1-turbo-free', pace: '0.9', polish: '1', emotion: '1', tts_language: '' };
function getSetting(k) {
  const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return r ? r.v : DEFAULTS[k] ?? null;
}
function setSetting(k, v) {
  if (v === null || v === undefined) db.prepare('DELETE FROM settings WHERE k = ?').run(k);
  else db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
function getApiKey() {
  const blob = getSetting('api_key_enc');
  if (!blob) return null;
  try { return decrypt(blob); } catch { return null; }
}
function saveApiKey(key) {
  setSetting('api_key_enc', encrypt(key));
  setSetting('api_key_last4', key.slice(-4));
}
function removeApiKey() { setSetting('api_key_enc', null); setSetting('api_key_last4', null); }

// ---------- passwords & sessions ----------
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function sha(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 14 * 24 * 3600 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, expires) VALUES (?, ?)').run(sha(token), expires);
  return { token, expires };
}
function checkSession(token) {
  if (!token) return false;
  const r = db.prepare('SELECT expires FROM sessions WHERE token_hash = ?').get(sha(token));
  return !!r && r.expires > Date.now();
}
function destroySession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }

module.exports = {
  db, ROOT, DATA_DIR, AUDIO_DIR, JOBS_DIR, STAGE_DIR,
  getSetting, setSetting, getApiKey, saveApiKey, removeApiKey,
  hashPassword, createSession, checkSession, destroySession, crypto,
};
