import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { URL } from 'url';
import { deflateRawSync, crc32 } from 'zlib';

const PORT = process.env.PORT || 3000;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const MAX_CLIP_DURATION = 300; // seconds
const VERSION = '2026-04-27-kick-session-token';

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Run a command and collect its stdout + stderr, resolving with both strings
 * regardless of exit code.  Rejects only on spawn errors (e.g. binary not found).
 *
 * @param {string}   cmd   - Executable name or path
 * @param {string[]} args  - Argument list
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function parseCommandOutput(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

/**
 * Query yt-dlp for all available impersonate targets and return them as an
 * array of lowercase strings (e.g. ['chrome-120', 'chrome-121', 'safari-17']).
 * Returns an empty array if the flag is unsupported or yt-dlp is unavailable.
 *
 * @returns {Promise<string[]>}
 */
async function availableImpersonateTargets() {
  try {
    const { stdout, code } = await parseCommandOutput('yt-dlp', ['--list-impersonate-targets']);
    if (code !== 0) return [];
    // Each line looks like:  "chrome-120   Chrome 120   ..."
    // We grab the first whitespace-delimited token on each non-header line.
    return stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0].toLowerCase())
      .filter((t) => t && t !== 'target' && !t.startsWith('-'));
  } catch {
    return [];
  }
}

/**
 * Given a list of impersonate targets, return the highest-versioned Chrome
 * target (e.g. 'chrome-121' beats 'chrome-120'), or null if none exist.
 *
 * @param {string[]} targets
 * @returns {string|null}
 */
function bestChromeImpersonateTarget(targets) {
  const chromeTargets = targets.filter((t) => /^chrome(-\d+)?$/.test(t));
  if (chromeTargets.length === 0) return null;
  // Sort by version number descending; bare 'chrome' sorts as version 0.
  chromeTargets.sort((a, b) => {
    const verA = parseInt(a.split('-')[1] || '0', 10);
    const verB = parseInt(b.split('-')[1] || '0', 10);
    return verB - verA;
  });
  return chromeTargets[0];
}

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
 * Write Kick cookies to a temp file if the KICK_COOKIES or
 * KICK_COOKIES_B64 environment variable is set, and return the file path.
 * Returns null when no cookie data is configured.
 *
 * @returns {string|null}
 */
function writeKickCookieFile() {
  const raw = process.env.KICK_COOKIES || '';
  const b64 = process.env.KICK_COOKIES_B64 || '';
  const content = raw || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
  if (!content) return null;

  const cookiePath = path.join(os.tmpdir(), 'kick-cookies.txt');
  fs.writeFileSync(cookiePath, content, { mode: 0o600 });
  return cookiePath;
}

/**
 * Write a minimal Netscape cookie file containing just the Kick session_token
 * when the KICK_SESSION_TOKEN environment variable is set.  yt-dlp's Kick
 * extractor reads this cookie to build the required "Authorization: Bearer
 * <token>" header for its metadata API calls (without it Kick returns HTTP 403).
 * Returns the file path on success, or null when the variable is not set.
 *
 * @returns {string|null}
 */
function writeKickSessionTokenCookieFile() {
  const token = process.env.KICK_SESSION_TOKEN || '';
  if (!token) return null;

  // Netscape cookie format: domain, include-subdomains, path, secure, expiry, name, value
  const content = [
    '# Netscape HTTP Cookie File',
    `kick.com\tFALSE\t/\tTRUE\t0\tsession_token\t${token}`,
  ].join('\n') + '\n';

  const cookiePath = path.join(os.tmpdir(), 'kick-session-cookies.txt');
  fs.writeFileSync(cookiePath, content, { mode: 0o600 });
  return cookiePath;
}

// ── startup: detect available impersonate targets ──────────────────────────────
// Populated once at startup; used by resolveVideoUrl and /healthz.
// Default to 'chrome' so Kick requests are impersonated even if the startup
// detection hasn't completed yet or the yt-dlp version predates
// --list-impersonate-targets.  curl_cffi is installed in the Dockerfile so
// the generic 'chrome' target is always available.
let chromeImpersonateTargets = [];
let kickImpersonateTarget = 'chrome';

availableImpersonateTargets().then((targets) => {
  chromeImpersonateTargets = targets.filter((t) => /^chrome(-\d+)?$/.test(t));
  // Use the highest-versioned Chrome target detected; fall back to the generic
  // 'chrome' target which curl_cffi always provides when installed.
  kickImpersonateTarget = bestChromeImpersonateTarget(targets) || 'chrome';
  console.log(`[startup] Kick impersonate target: ${kickImpersonateTarget} (detected Chrome targets: ${chromeImpersonateTargets.join(', ') || 'none — using generic chrome'})`);
});

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
async function resolveVideoUrl(videoId, url) {
  // Prefer an explicit URL; fall back to constructing a YouTube watch URL.
  const sourceUrl = url || `https://www.youtube.com/watch?v=${videoId}`;

  const isYouTube = sourceUrl.includes('youtube.com') || sourceUrl.includes('youtu.be');
  const isKick    = sourceUrl.includes('kick.com');
  const isTwitch  = sourceUrl.includes('twitch.tv');

  const cookiePath = writeCookieFile();

  const args = [
    '--no-playlist',
    '-f', 'bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc]/best[ext=mp4]/best',
    '--get-url',
  ];

  // YouTube: use the web JS player + all cookie-free client fallbacks, and
  // impersonate Chrome to pass Google's TLS fingerprint checks — no cookies
  // needed for public videos.
  if (isYouTube) {
    args.push('--extractor-args', 'youtube:player_client=web,mweb,tv_embedded,default');
    args.push('--impersonate', kickImpersonateTarget);
  }

  // Impersonate Chrome to bypass Cloudflare TLS fingerprinting on Kick.
  // curl_cffi (installed via yt-dlp[default,curl-cffi]) provides the TLS
  // impersonation support.  kickImpersonateTarget is always set to at least
  // 'chrome' (the generic target) so this branch always fires for Kick.
  if (isKick) {
    console.log(`[yt-dlp] Kick URL detected — using --impersonate ${kickImpersonateTarget}`);
    args.push('--impersonate', kickImpersonateTarget);
    // Pass Referer and Origin so Kick's API/CDN does not block the metadata
    // request due to missing browser navigation context headers.
    args.push('--add-headers', 'Referer:https://kick.com');
    args.push('--add-headers', 'Origin:https://kick.com');
    // Kick's metadata API now requires an "Authorization: Bearer <session_token>"
    // header (HTTP 403 without it).  yt-dlp's Kick extractor builds this header
    // automatically from the "session_token" cookie.  We support two ways to
    // provide that cookie:
    //   1. KICK_SESSION_TOKEN — just the raw token value (simplest to configure)
    //   2. KICK_COOKIES / KICK_COOKIES_B64 — a full Netscape cookie file
    // The session-token cookie file takes priority; if only the full cookie file
    // is provided it is used as-is (it may already include session_token).
    const kickSessionCookiePath = writeKickSessionTokenCookieFile();
    const kickCookiePath        = kickSessionCookiePath ? null : writeKickCookieFile();
    const activeCookiePath      = kickSessionCookiePath || kickCookiePath;
    if (activeCookiePath) {
      console.log(`[yt-dlp] Kick cookies configured — injecting cookie file (${kickSessionCookiePath ? 'session token' : 'full cookie file'})`);
      args.push('--cookies', activeCookiePath);
    } else {
      console.log('[yt-dlp] No Kick session token configured — set KICK_SESSION_TOKEN for Kick VOD access');
    }
  }

  // Inject cookies when available (helps avoid YouTube 429 rate limits).
  if (!isKick && cookiePath) {
    args.push('--cookies', cookiePath);
  }

  args.push(sourceUrl);

  console.log(`[yt-dlp] resolving URL: ${sourceUrl}`);
  if (isTwitch) console.log('[yt-dlp] Twitch URL detected');

  return new Promise((resolve, reject) => {
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

/**
 * Encode a clip from separate video/audio URLs into a specific aspect ratio.
 *
 * The source video is scaled so its longest dimension fits the target box, then
 * padded with black bars on the remaining sides.  This preserves all content
 * without cropping.
 *
 * Supported aspectRatio values: '16:9' | '9:16' | '1:1'
 *
 * @param {string}      videoUrl   - Direct URL to the video stream
 * @param {string|null} audioUrl   - Direct URL to the audio stream (or null)
 * @param {number}      start      - Start offset in seconds
 * @param {number}      duration   - Clip length in seconds
 * @param {'16:9'|'9:16'|'1:1'} aspectRatio
 * @param {string}      title      - Used only for logging
 * @returns {Promise<Buffer>}      - Encoded MP4 bytes
 */
function encodeClipWithAspectRatio(videoUrl, audioUrl, start, duration, aspectRatio, title) {
  // Target canvas dimensions (width x height).
  // We use 1280×720 / 720×1280 / 720×720 as the baseline to keep file sizes
  // reasonable; the scale filter will never upscale beyond the source.
  const DIMENSIONS = {
    '16:9': { w: 1280, h: 720  },
    '9:16': { w: 720,  h: 1280 },
    '1:1':  { w: 720,  h: 720  },
  };

  const dim = DIMENSIONS[aspectRatio];
  if (!dim) {
    return Promise.reject(new Error(`Unknown aspect ratio: ${aspectRatio}`));
  }

  const { w, h } = dim;

  // Scale the video to fit inside the target box (never upscale), then pad to
  // exactly w×h with black.  force_original_aspect_ratio=decrease ensures the
  // scaled video is always ≤ w and ≤ h before padding.
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    // Ensure width and height are divisible by 2 (libx264 requirement).
    `format=yuv420p`,
  ].join(',');

  const ffmpegArgs = [
    '-ss', String(start),
    '-i', videoUrl,
    ...(audioUrl ? ['-ss', String(start), '-i', audioUrl, '-map', '0:v:0', '-map', '1:a:0'] : []),
    '-t', String(duration),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    const chunks = [];

    ffmpeg.stdout.on('data', (chunk) => { chunks.push(chunk); });
    ffmpeg.stderr.on('data', (chunk) => {
      process.stdout.write(`[ffmpeg:${aspectRatio}:${title}] ${chunk}`);
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code} for aspect ratio ${aspectRatio}`));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

// ── ZIP builder (no external deps) ────────────────────────────────────────────
//
// Builds a valid ZIP archive in memory from an array of { name, data } entries.
// Uses DEFLATE compression via Node's built-in zlib.deflateRawSync.
//
// Reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

/**
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes    = Buffer.from(name, 'utf8');
    const compressed   = deflateRawSync(data, { level: 6 });
    const crc          = crc32(data);
    const dosDate      = dosDateTime(new Date());

    // Local file header (signature 0x04034b50)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20,          4);  // version needed
    local.writeUInt16LE(0x0800,      6);  // flags: UTF-8 name
    local.writeUInt16LE(8,           8);  // compression: DEFLATE
    local.writeUInt16LE(dosDate.time, 10);
    local.writeUInt16LE(dosDate.date, 12);
    local.writeUInt32LE(crc >>> 0,   14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length,       22);
    local.writeUInt16LE(nameBytes.length,  26);
    local.writeUInt16LE(0,                 28); // extra field length
    nameBytes.copy(local, 30);

    localHeaders.push(local);
    localHeaders.push(compressed);

    // Central directory header (signature 0x02014b50)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20,          4);  // version made by
    central.writeUInt16LE(20,          6);  // version needed
    central.writeUInt16LE(0x0800,      8);  // flags: UTF-8 name
    central.writeUInt16LE(8,           10); // compression: DEFLATE
    central.writeUInt16LE(dosDate.time, 12);
    central.writeUInt16LE(dosDate.date, 14);
    central.writeUInt32LE(crc >>> 0,   16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length,       24);
    central.writeUInt16LE(nameBytes.length,  28);
    central.writeUInt16LE(0,                 30); // extra field length
    central.writeUInt16LE(0,                 32); // file comment length
    central.writeUInt16LE(0,                 34); // disk number start
    central.writeUInt16LE(0,                 36); // internal attributes
    central.writeUInt32LE(0,                 38); // external attributes
    central.writeUInt32LE(offset,            42); // relative offset of local header
    nameBytes.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralDir   = Buffer.concat(centralHeaders);
  const eocd         = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,          0);  // end-of-central-directory signature
  eocd.writeUInt16LE(0,                   4);  // disk number
  eocd.writeUInt16LE(0,                   6);  // disk with central dir
  eocd.writeUInt16LE(entries.length,      8);  // entries on this disk
  eocd.writeUInt16LE(entries.length,      10); // total entries
  eocd.writeUInt32LE(centralDir.length,   12); // central dir size
  eocd.writeUInt32LE(offset,              16); // central dir offset
  eocd.writeUInt16LE(0,                   20); // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

/**
 * Convert a JS Date to the DOS date/time format used in ZIP headers.
 * @param {Date} d
 * @returns {{ date: number, time: number }}
 */
function dosDateTime(d) {
  const time =
    ((d.getHours()   & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5)  |
    ((d.getSeconds() >> 1)   & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1)       & 0x0f) << 5) |
    ((d.getDate()              & 0x1f));
  return { time, date };
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
    const ytdlpVersionResult = await parseCommandOutput('yt-dlp', ['--version']);
    const youtubeCookiesConfigured = !!(
      process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES_B64
    );
    const kickCookiesConfigured = !!(
      process.env.KICK_COOKIES || process.env.KICK_COOKIES_B64
    );
    const kickSessionTokenConfigured = !!process.env.KICK_SESSION_TOKEN;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      ytDlpVersion: ytdlpVersionResult.stdout.trim(),
      youtubeCookiesConfigured,
      kickCookiesConfigured,
      kickSessionTokenConfigured,
      kickImpersonateTarget,
      chromeImpersonateTargets,
      multiFormatSupport: true,
      supportedAspectRatios: ['16:9', '9:16', '1:1'],
    }));
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
    const format   = parsed.searchParams.get('format'); // horizontal | vertical | square

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

    // Map friendly format names to aspect ratios used by encodeClipWithAspectRatio.
    const FORMAT_TO_RATIO = { horizontal: '16:9', vertical: '9:16', square: '1:1' };
    if (format && !FORMAT_TO_RATIO[format]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid format: "${format}". Supported values: horizontal, vertical, square` }));
      return;
    }
    const aspectRatio = format ? FORMAT_TO_RATIO[format] : null;

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

    // When a format/aspect-ratio is requested, use the reframing encoder which
    // scales + pads the video to the target canvas.  The result is buffered in
    // memory before being sent so we can set Content-Length.
    if (aspectRatio) {
      let clipBuffer;
      try {
        clipBuffer = await encodeClipWithAspectRatio(videoUrl, audioUrl, start, duration, aspectRatio, title);
      } catch (err) {
        console.error('[clip] ffmpeg error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ffmpeg encoding failed', detail: err.message }));
        return;
      }

      const filename = `${safeFilename(title)}_${format}.mp4`;
      const headers = {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(clipBuffer.length),
        'Cache-Control': 'no-store',
        'X-Clip-Duration': String(duration),
        'X-Clip-Format': format,
      };
      if (capped) headers['X-Clip-Capped'] = `true; max=${MAX_CLIP_DURATION}s`;
      res.writeHead(200, headers);
      res.end(clipBuffer);
      return;
    }

    // No format requested — stream the clip directly from ffmpeg (original behaviour).
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

  // Same params as /clip but generates all three aspect ratios in parallel and
  // returns a ZIP archive containing clip_16x9.mp4, clip_9x16.mp4, clip_1x1.mp4.
  if (parsed.pathname === '/clips') {
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

    // Resolve the source URL once — all three encodes share the same CDN URLs.
    let videoUrl, audioUrl;
    try {
      ({ videoUrl, audioUrl } = await resolveVideoUrl(videoId, clipUrl));
    } catch (err) {
      console.error('[clips] yt-dlp error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not resolve video URL', detail: err.message }));
      return;
    }

    // Encode all three formats in parallel.
    const FORMATS = [
      { ratio: '16:9', filename: 'clip_16x9.mp4' },
      { ratio: '9:16', filename: 'clip_9x16.mp4' },
      { ratio: '1:1',  filename: 'clip_1x1.mp4'  },
    ];

    console.log(`[clips] encoding ${FORMATS.length} formats in parallel for "${title}" (${duration}s)`);

    let results;
    try {
      results = await Promise.all(
        FORMATS.map(({ ratio, filename }) =>
          encodeClipWithAspectRatio(videoUrl, audioUrl, start, duration, ratio, title)
            .then((data) => ({ filename, data }))
        )
      );
    } catch (err) {
      console.error('[clips] ffmpeg error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ffmpeg encoding failed', detail: err.message }));
      return;
    }

    // Pack all three MP4s into a single ZIP archive.
    const zipBuffer = buildZip(results);
    const zipFilename = `${safeFilename(title)}_clips.zip`;

    const headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFilename}"`,
      'Content-Length': String(zipBuffer.length),
      'Cache-Control': 'no-store',
      'X-Clip-Duration': String(duration),
      'X-Clip-Formats': FORMATS.map((f) => f.ratio).join(','),
    };
    if (capped) {
      headers['X-Clip-Capped'] = `true; max=${MAX_CLIP_DURATION}s`;
    }

    res.writeHead(200, headers);
    res.end(zipBuffer);
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
