# ffmpeg Clip Worker (Railway)

Tiny HTTP service that takes `{source, videoId/clipSlug/url, start, end}` and streams back a trimmed MP4 of that exact segment. Used by the Lovable Cloud download-clip edge function so iPhone Safari + desktop both get a real file download without any client-side ffmpeg.

## Deploy to Railway

1. Push the contents of this folder to a new GitHub repo (or use Railway's "Deploy from GitHub").
2. In Railway → **New Project** → **Deploy from Repo** → select the repo.
3. Railway auto-detects the `Dockerfile`. No build command needed.
4. Set environment variables:
   - `WORKER_TOKEN` — any random string (e.g. `openssl rand -hex 32`). Required.
   - `PORT` — Railway sets this automatically.
5. Once deployed, copy the public URL (e.g. `https://your-app.up.railway.app`).
6. In Lovable, set these secrets when prompted:
   - `RAILWAY_FFMPEG_URL` = the public URL above
   - `RAILWAY_FFMPEG_TOKEN` = the same `WORKER_TOKEN`

## Endpoints

- `GET /healthz` → `{"ok": true}`
- `GET /clip` — trim a clip and stream it back as `video/mp4`.
  - Header: `x-worker-token: <WORKER_TOKEN>` (if set)
  - Returns: `video/mp4` stream as an attachment.
- `GET /clips` — same parameters as `/clip`; returns a ZIP containing `clip_16x9.mp4`, `clip_9x16.mp4`, and `clip_1x1.mp4`.

### `/clip` parameter combinations

| source | required params | optional params |
|--------|----------------|-----------------|
| `youtube` | `videoId`, `start`, `end` | `title`, `format` |
| `twitch` (VOD) | `videoId`, `start`, `end` | `title`, `format` |
| `twitch` (clip) | `clipSlug` | `start`, `end`, `title`, `format` |
| `kick` | `url`, `start`, `end` | `title`, `format` |
| *(legacy)* | `videoId` or `url`, `start`, `end` | `title`, `format` |

**Examples:**
```
# YouTube
GET /clip?source=youtube&videoId=dQw4w9WgXcQ&start=12.5&end=37&title=my_clip

# Twitch VOD
GET /clip?source=twitch&videoId=123456789&start=60&end=120

# Twitch clip (no start/end needed — the clip is already trimmed)
GET /clip?source=twitch&clipSlug=AwesomeClipSlug

# Kick
GET /clip?source=kick&url=https://kick.com/channel/clip/abc123&start=0&end=30
```

The optional `format` parameter controls aspect-ratio reframing:
- `format=horizontal` → 16:9 (1280×720)
- `format=vertical` → 9:16 (720×1280)
- `format=square` → 1:1 (720×720)

## Local development

```bash
# Build
docker build -t ffmpeg-clip-worker .

# Run (set your own token)
docker run -p 3000:3000 -e WORKER_TOKEN=mysecret ffmpeg-clip-worker

# Health check
curl http://localhost:3000/healthz

# Clip from YouTube
curl -H "x-worker-token: mysecret" \
  "http://localhost:3000/clip?source=youtube&videoId=dQw4w9WgXcQ&start=10&end=40&title=test" \
  -o test.mp4

# Twitch clip (no start/end required)
curl -H "x-worker-token: mysecret" \
  "http://localhost:3000/clip?source=twitch&clipSlug=AwesomeClipSlug" \
  -o twitch_clip.mp4
```

## Notes

- Clip length is capped at **300 s** to keep memory/CPU low.
- Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to resolve a direct progressive MP4 URL, then `ffmpeg` seeks with `-ss` *before* `-i` for fast trimming. Re-encodes with `libx264 veryfast` so the start is keyframe-clean on Safari.
- Output is streamed as a fragmented MP4 (`frag_keyframe+empty_moov`) so clients begin receiving data immediately.
- A Railway **Hobby** instance handles short clips comfortably. Scale up only if you expect concurrent jobs.
