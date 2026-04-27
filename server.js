'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const MAX_CLIP_DURATION = 300; // seconds
const VERSION = '2026-04-27-ytdlp-post-cookies';

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Write YouTube cookies to a temp file if the YOUTUBE_COOKIES or
 * YOUTUBE_COOKIES_B64 environment variable is set, and return the file path.
 * Returns null when no cookie data is configured.
 *
 * @returns {string|null}
 */
function writeCookieFile() {
  const raw = process.env.YOUTUBE_COOKIES || '';
  const b64 = process.env.YOUTUBE_COOKIES_B64 || '';
  const content = raw || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
  if (!content) return null;

  const cookiePath = path.join(os.tmpdir(), 'yt-cookies.txt');
  fs.writeFileSync(cookiePath, content, { mode: 0o600 });
  return cookiePath;
}

/**
 * Run yt-dlp to resolve the best video (and audio) URL(s) for a given source.
 * Accepts either a full URL (Kick, Twitch, YouTube, etc.) or a bare YouTube
 * video ID.  When yt-dlp selects a format with separate video and audio streams
 * it prints two URLs — one per line.  We return both so the caller can feed
 * them to ffmpeg as separate inputs.
 *
 * @param {string} videoId  - YouTube video ID (legacy)
 * @param {string|null} url - Full source URL (Kick/Twitch/YouTube/…)
 * @returns {Promise<{ videoUrl: string, audioUrl: string|null }>}
 */
function resolveVideoUrl(videoId, url) {
  return new Promise((resolve, reject) => {
    // Prefer an explicit URL; fall back to constructing a YouTube watch URL.
    const sourceUrl = url || `https://www.youtube.com/watch?v=${videoId}`;

    const isYouTube = sourceUrl.includes('youtube.com') || sourceUrl.includes('youtu.be');

    const cookiePath = writeCookieFile();

    const args = [
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc]/best[ext=mp4]/best',
      '--get-url',
    ];

    // Enable the native JS player runtime so yt-dlp can handle YouTube's
    // current player without needing a browser extension.
    if (isYouTube) {
      args.push('--extractor-args', 'youtube:player_client=web,default');
    }

    // Inject cookies when available (helps avoid YouTube 429 rate limits).
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }

    args.push(sourceUrl);

    const ytdlp = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (chunk) => { stdout += chunk; });
    ytdlp.stderr.on('data', (chunk) => { stderr += chunk; });

    ytdlp.on('error', (err) => { reject(err); });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited ${code}: ${stderr.trim()}`));
      }
      // yt-dlp prints one URL per line; two lines means separate video+audio streams.
      const urls = stdout.trim().split('\n').map((u) => u.trim()).filter(Boolean);
      if (urls.length === 0) {
        return reject(new Error('yt-dlp returned empty URL'));
      }
      resolve({
        videoUrl: urls[0],
        audioUrl: urls.length > 1 ? urls[1] : null,
      });
    });
  });
}

/**
 * Sanitise a filename component (strip characters unsafe for Content-Disposition).
 * @param {string} name
 * @returns {string}
 */
function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'clip';
}

// ── request handler ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const base = `http://localhost:${PORT}`;
  let parsed;
  try {
    parsed = new URL(req.url, base);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  // ── GET /healthz ─────────────────────────────────────────────────────────────
  if (parsed.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: VERSION }));
    return;
  }

  // ── GET /clip ─────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/clip') {
    // Token auth (optional but strongly recommended)
    if (WORKER_TOKEN && req.headers['x-worker-token'] !== WORKER_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const videoId  = parsed.searchParams.get('videoId');
    const clipUrl  = parsed.searchParams.get('url');
    const startRaw = parsed.searchParams.get('start');
    const endRaw   = parsed.searchParams.get('end');
    const title    = parsed.searchParams.get('title') || 'clip';

    if (!videoId && !clipUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: videoId or url' }));
      return;
    }
    if (startRaw === null || endRaw === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameters: start, end' }));
      return;
    }

    const start = parseFloat(startRaw);
    const end   = parseFloat(endRaw);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid parameters: start and end must be numbers and end must be greater than start' }));
      return;
    }

    const requested = end - start;
    const duration  = Math.min(requested, MAX_CLIP_DURATION);
    const capped    = duration < requested;

    let videoUrl, audioUrl;
    try {
      ({ videoUrl, audioUrl } = await resolveVideoUrl(videoId, clipUrl));
    } catch (err) {
      console.error('[clip] yt-dlp error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not resolve video URL', detail: err.message }));
      return;
    }

    // Place -ss BEFORE each -i so ffmpeg performs a fast keyframe seek, then
    // re-encode from that point to guarantee a clean start on Safari.
    // When yt-dlp returns separate video and audio streams we feed them as two
    // inputs and use explicit -map flags so ffmpeg encodes both streams.
    const ffmpegArgs = [
      '-ss', String(start),
      '-i', videoUrl,
      // When yt-dlp provides a separate audio stream, add it as a second input
      // and map both tracks explicitly; otherwise ffmpeg auto-selects from the
      // single combined input.
      ...(audioUrl ? ['-ss', String(start), '-i', audioUrl, '-map', '0:v:0', '-map', '1:a:0'] : []),
      '-t', String(duration),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      // fragmented MP4 so the browser can start playing before the file ends
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    const filename = `${safeFilename(title)}.mp4`;
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Clip-Duration': String(duration),
    };
    if (capped) {
      headers['X-Clip-Capped'] = `true; max=${MAX_CLIP_DURATION}s`;
    }
    res.writeHead(200, headers);

    ffmpeg.stdout.pipe(res);

    ffmpeg.on('error', (err) => {
      console.error('[clip] ffmpeg spawn error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ffmpeg unavailable', detail: err.message }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    ffmpeg.stderr.on('data', (chunk) => {
      process.stdout.write(`[ffmpeg] ${chunk}`);
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.error(`[clip] ffmpeg exited with code ${code}`);
      }
      if (!res.writableEnded) res.end();
    });

    // If the client disconnects early, kill ffmpeg to free resources.
    req.once('close', () => { ffmpeg.kill('SIGTERM'); });
    req.once('error', () => { ffmpeg.kill('SIGTERM'); });

    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── server ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`ffmpeg-clip-worker listening on port ${PORT}`);
  if (!WORKER_TOKEN) {
    console.warn('WARNING: WORKER_TOKEN is not set — the /clip endpoint is unprotected!');
  }
});
