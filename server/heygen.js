'use strict';
const BASE = 'https://api.heygen.com';

class HeyGenError extends Error {
  constructor(message, status) { super(message); this.status = status; this.heygen = true; }
}
class NotConnectedError extends Error {
  constructor() { super('API not connected — add your HeyGen API key in API Settings'); this.status = 400; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describe(status, body, text) {
  let msg = '';
  if (body && body.error) msg = body.error.message || body.error.code || '';
  else if (body && (body.message || body.detail)) msg = body.message || body.detail;
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  if (!msg) msg = (text || '').slice(0, 300) || 'Unknown error';
  return `HeyGen error [HTTP ${status}]: ${msg}`;
}

// Low level request. Retries ONCE on HTTP 429 after a short wait; `notes` receives a user-facing notice.
async function request(key, method, pathAndQuery, body, notes) {
  if (!key) throw new NotConnectedError();
  const doFetch = async () => {
    let res;
    try {
      res = await fetch(BASE + pathAndQuery, {
        method,
        headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      throw new HeyGenError(`Could not reach HeyGen (${e.cause?.code || e.name}): check your internet connection`, 0);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { res, json, text };
  };
  let r = await doFetch();
  if (r.res.status === 429) {
    const wait = Math.min(Number(r.res.headers.get('retry-after')) || 4, 15);
    if (notes) notes.push(`HeyGen is rate-limiting (HTTP 429) — waited ${wait}s and retried once.`);
    await sleep(wait * 1000);
    r = await doFetch();
  }
  if (!r.res.ok) throw new HeyGenError(describe(r.res.status, r.json, r.text), r.res.status);
  return r.json;
}

// Lightweight key verification. Falls back to a one-voice list for restricted keys.
async function verifyKey(key) {
  try {
    const j = await request(key, 'GET', '/v3/users/me');
    return { via: 'users/me', user: j && j.data ? { username: j.data.username, plan: j.data.subscription?.plan || j.data.billing_type || null } : null };
  } catch (e) {
    if (e.status === 401) throw e;
    if (e.status === 403 || e.status === 404) {
      await request(key, 'GET', '/v3/models/audio/voices?type=public&limit=1');
      return { via: 'voices (limit 1)', user: null };
    }
    throw e;
  }
}

// Fetch every page of a voice list, following has_more / next_token (sent back as `token`).
async function listAllVoices(key, type, onPage) {
  const all = [];
  let token = null;
  let pages = 0;
  do {
    const q = `/v3/models/audio/voices?type=${type}&limit=100` + (token ? `&token=${encodeURIComponent(token)}` : '');
    const j = await request(key, 'GET', q);
    const rows = (j && j.data) || [];
    all.push(...rows);
    pages++;
    if (onPage) onPage(all.length, pages);
    token = j && j.has_more && j.next_token ? j.next_token : null;
    if (pages > 200) break; // safety valve
  } while (token);
  return all;
}

async function getVoice(key, id) {
  const j = await request(key, 'GET', `/v3/models/audio/voices/${encodeURIComponent(id)}`);
  return j.data;
}

async function createInstantVoice(key, { name, language, base64, mediaType }) {
  const body = { mode: 'instant', name, audio: [{ type: 'base64', media_type: mediaType, data: base64 }] };
  if (language) body.language = language; // only when the owner explicitly provided one
  const j = await request(key, 'POST', '/v3/models/audio/voices', body);
  return j.data.voice_id;
}

async function createDesignedVoice(key, { name, language, description }) {
  const j = await request(key, 'POST', '/v3/models/audio/voices', { mode: 'design', name, language, description });
  return j.data.voice_id;
}

// TTS: only model, voice_id, text, language (+ documented expressiveness_boost when changed from default).
async function tts(key, { model, voiceId, text, language, expressiveness }, notes) {
  const body = { model, voice_id: voiceId, text };
  if (language) body.language = language;
  const useBoost = typeof expressiveness === 'number' && expressiveness < 0.999;
  if (useBoost) body.expressiveness_boost = expressiveness;
  let j;
  try {
    j = await request(key, 'POST', '/v3/models/audio/tts', body, notes);
  } catch (e) {
    if (useBoost && e.status === 400) {
      // This voice/model does not accept the emotion-intensity control — retry plain, and say so.
      delete body.expressiveness_boost;
      if (notes) notes.push('This voice does not support the emotion-intensity control, so it was generated without it.');
      j = await request(key, 'POST', '/v3/models/audio/tts', body, notes);
    } else throw e;
  }
  const url = j && j.data && j.data.audio_url;
  if (!url) throw new HeyGenError('HeyGen error [HTTP 200]: response contained no audio_url', 200);
  return { url, duration: j.data.duration };
}

async function download(url) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(90000) }); }
  catch (e) { throw new HeyGenError(`Could not download the generated audio (${e.cause?.code || e.name})`, 0); }
  if (!res.ok) throw new HeyGenError(`HeyGen error [HTTP ${res.status}]: could not download the generated audio file`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { HeyGenError, NotConnectedError, verifyKey, listAllVoices, getVoice, createInstantVoice, createDesignedVoice, tts, download, request };
