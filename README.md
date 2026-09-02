# moonshadow-renderer

FFmpeg worker for Moonshadow Path.

Contract expected by `studio-behind-the-cast/vercel-path/lib/renderer.ts`:

- `GET /health` → `{ connected, backend, message }`
- `POST /renders` → `{ rendered, externalRenderId, outputUri, mimeType }`
- Header `Authorization: Bearer $RENDERER_WORKER_TOKEN` when token is set

This is a real encoder, not an adapter. It does not publish to YouTube.

## Local

```bash
export RENDERER_WORKER_TOKEN=dev-token
export PUBLIC_BASE_URL=http://localhost:8787
node server.mjs
```

Needs `ffmpeg` on PATH.

## Fly (after Josh account exists)

```bash
fly launch --no-deploy --name moonshadow-renderer --region iad
fly secrets set RENDERER_WORKER_TOKEN=... PUBLIC_BASE_URL=https://moonshadow-renderer.fly.dev
fly deploy
```

Then set on Vercel Path:

- `RENDERER_WORKER_URL=https://moonshadow-renderer.fly.dev`
- `RENDERER_WORKER_TOKEN=` same value

Do not commit secrets.
