# moonshadow-renderer

FFmpeg worker for Moonshadow Path.

Contract expected by `studio-behind-the-cast/vercel-path/lib/renderer.ts`:

- `GET /health` → `{ connected, backend, message }`
- `POST /renders` → `{ rendered, externalRenderId, outputUri, mimeType, lavfi, inputUriUsed, targetDurationSec }`
- Header `Authorization: Bearer $RENDERER_WORKER_TOKEN` when token is set

**Body (Path today):** `{ projectAssetId, outputName, projectName?, mimeType? }`  
→ lavfi title-card encode (legacy).

**Body (user-media):** same required keys **plus optional**  
`inputUri` / `input_uri` (http(s), local path / `file://`, or `ingest/…` after POST /ingest)  
→ real ffmpeg `-i` (not lavfi). Default: output length ≈ input length.

**Optional duration modes (2026-09-23):** `targetDurationSec` must be `15` or `60` (other values → 400).  
With user-media: longer source → trim; shorter → freeze last frame + audio pad so output ≈ target.  
Response includes `lavfi`, `inputUriUsed`, `targetDurationSec` (null when unused).

This is a real encoder, not an adapter. It does not publish to YouTube.

## Local

```bash
export RENDERER_WORKER_TOKEN=dev-token
export PUBLIC_BASE_URL=http://localhost:8787
node server.mjs
```

Needs `ffmpeg` / `ffprobe` on PATH.

## Fly

```bash
export PATH="$HOME/.fly/bin:$PATH"
fly deploy --ha=false
```

Do not rotate `RENDERER_WORKER_TOKEN`. Do not change fly.toml VM size.
