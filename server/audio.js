'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

function checkFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      throw new Error(`${bin} is not installed or not on PATH. Install ffmpeg (e.g. "winget install Gyan.FFmpeg") and restart the studio.`);
    }
  }
  const v = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  return v;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`${bin} could not be started: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Audio processing (${bin}) failed: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

async function duration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out);
  if (!isFinite(d)) throw new Error('Could not read the duration of the audio file');
  return d;
}

function paceLabel(p) {
  const v = Math.round(p * 100) / 100;
  if (v === 0.9) return 'Natural';
  if (v === 0.85) return 'Calm';
  if (v === 1) return 'Original';
  return 'Custom';
}

function clampPace(p) {
  p = Number(p);
  if (!isFinite(p)) return 0.9;
  return Math.min(1.05, Math.max(0.8, Math.round(p * 100) / 100));
}

// Merge chunk files (concat), then apply pace ONCE (atempo, pitch preserving) + optional polish. Output: mp3.
async function mergeAndProcess(chunkFiles, listFile, outFile, { pace, polish }) {
  fs.writeFileSync(listFile, chunkFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const filters = [];
  if (polish) filters.push('highpass=f=70');
  if (Math.abs(pace - 1) > 0.0001) filters.push(`atempo=${pace.toFixed(2)}`);
  if (polish) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k', outFile);
  await run('ffmpeg', args);
  return duration(outFile);
}

// A silent WAV in the same format as a reference chunk (used as the pause between narrators).
async function makeSilence(refFile, outFile, seconds) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', refFile]);
  const [rate, ch] = out.trim().split(',').map(Number);
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${rate || 44100}:cl=${ch === 2 ? 'stereo' : 'mono'}`, '-t', String(seconds), '-c:a', 'pcm_s16le', outFile]);
}

// Speech-quality sample for cloning: mono, 32 kbps MP3 (a ~1.6 MB sample becomes ~0.4 MB).
async function transcodeSample(inFile, outFile) {
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inFile, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '32k', outFile]);
}

async function toWav(mp3, wav) {
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp3, wav]);
}

// Split at sentence boundaries into chunks <= max chars. The wording is never altered:
// chunk texts are exact, contiguous slices of the script (only edge whitespace is trimmed).
function splitText(text, max = 4500) {
  text = text.replace(/\r\n/g, '\n').trim();
  if (text.length <= max) return [text];
  // sentence tokens: keep terminators and trailing whitespace attached
  const sentences = text.match(/[^.!?…۔؟।\n]+(?:[.!?…۔؟।]+["'”’)\]]*|\n+|$)\s*/g) || [text];
  const pieces = [];
  for (const s of sentences) {
    if (s.length <= max) { pieces.push(s); continue; }
    // very long sentence: split at commas / spaces
    let rest = s;
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max), rest.lastIndexOf('، ', max));
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut < 1) cut = max;
      pieces.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) pieces.push(rest);
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if ((cur + p).length > max && cur) { chunks.push(cur); cur = p; } else cur += p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

module.exports = { checkFfmpeg, run, duration, paceLabel, clampPace, makeSilence, mergeAndProcess, transcodeSample, toWav, splitText };
