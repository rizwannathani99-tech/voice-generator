# VOICE STUDIO

HeyGen Voice Turbo voice-over studio: Text to Speech, Voice Library (~2,600 voices), Voice Design, Voice Cloning, history and usage.

## Run
Double-click `start.bat` (or `npm start`) and open http://localhost:3000.
First visit: create your admin login. Your HeyGen key is imported automatically from `key.env.txt`
(verified first, stored encrypted in `data/`). You can also paste a key in **API Settings**.

Requires Node.js 22.5+ and ffmpeg on PATH (the app refuses to start without ffmpeg).

## Notes
- Pace: HeyGen has no pace control, so a pitch-preserving ffmpeg `atempo` is applied once to the final merged file. Default Natural 0.90x.
- Long scripts: split at sentence boundaries (<=4,500 chars), one HeyGen call per chunk, merged with ffmpeg.
- Human delivery: Emotion intensity (HeyGen `expressiveness_boost`, instant voices) and Studio polish (loudness levelling).
- Everything lives in `data/` (database, audio, encryption key). Back it up to keep history.
- Do not share `key.env.txt` or `data/secret.key`.
