import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RENDERER_WORKER_TOKEN || "";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://moonshadow-renderer.fly.dev").replace(/\/+$/, "");
const OUT = process.env.OUTPUT_DIR || path.join(__dirname, "data", "out");
fs.mkdirSync(OUT, { recursive: true });

function ffmpegOk() {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function unauthorized(res) {
  return json(res, 401, { connected: false, rendered: false, message: "unauthorized" });
}

function checkAuth(req) {
  if (!TOKEN) return false;
  const header = req.headers.authorization || "";
  return header === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function renderStillCard({ title, outputPath }) {
  const safe = String(title || "Moonshadow Short").replace(/[:\\]/g, " ").slice(0, 80);
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x070b14:s=1080x1920:d=8",
    "-vf",
    `drawtext=text='${safe}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) resolve();
      else reject(new Error(err.slice(-800) || `ffmpeg exit ${code}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
    const ok = ffmpegOk();
    return json(res, ok ? 200 : 503, {
      connected: ok,
      backend: "ffmpeg-worker",
      tokenConfigured: Boolean(TOKEN),
      message: ok ? "FFmpeg present" : "FFmpeg missing",
    });
  }

  if (url.pathname.startsWith("/out/") && req.method === "GET") {
    const file = path.join(OUT, path.basename(url.pathname));
    if (!file.startsWith(OUT) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": "video/mp4" });
    return fs.createReadStream(file).pipe(res);
  }

  if (url.pathname === "/renders" && req.method === "POST") {
    if (!TOKEN) return json(res, 503, { rendered: false, message: "AUTH_NOT_CONFIGURED" });
    if (!checkAuth(req)) return unauthorized(res);
    if (!ffmpegOk()) return json(res, 503, { rendered: false, message: "FFmpeg missing" });
    try {
      const body = await readBody(req);
      const projectAssetId = String(body.projectAssetId || "").trim();
      const outputName = String(body.outputName || "").trim();
      if (!projectAssetId) return json(res, 400, { rendered: false, message: "PROJECT_ASSET_ID_REQUIRED" });
      if (!outputName) return json(res, 400, { rendered: false, message: "OUTPUT_NAME_REQUIRED" });

      const id = `rnd_${crypto.randomUUID()}`;
      const filename = `${id}.mp4`;
      const outputPath = path.join(OUT, filename);
      await renderStillCard({ title: body.projectName || outputName, outputPath });
      return json(res, 200, {
        rendered: true,
        externalRenderId: id,
        outputUri: `${PUBLIC_BASE}/out/${filename}`,
        mimeType: "video/mp4",
      });
    } catch (err) {
      return json(res, 500, { rendered: false, message: String(err.message || err) });
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`moonshadow-renderer on :${PORT} ffmpeg=${ffmpegOk()} public=${PUBLIC_BASE} token=${TOKEN ? "set" : "missing"}`);
});
