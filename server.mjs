import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RENDERER_WORKER_TOKEN || "";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://moonshadow-renderer.fly.dev").replace(/\/+$/, "");
const preferredOut = process.env.OUTPUT_DIR || path.join(__dirname, "data", "out");
function pickOutDir() {
  try {
    fs.mkdirSync(preferredOut, { recursive: true });
    fs.accessSync(preferredOut, fs.constants.W_OK);
    return preferredOut;
  } catch {
    const fallback = path.join(__dirname, "data", "out");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
const OUT = pickOutDir();

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
  return json(res, 401, { connected: false, rendered: false, code: "UNAUTHORIZED", message: "unauthorized" });
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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(-1200) || `${cmd} exit ${code}`));
    });
  });
}

function probeDuration(file) {
  const r = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ], { encoding: "utf8" });
  const n = Number.parseFloat(String(r.stdout || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function probeStreams(file) {
  const r = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    file,
  ], { encoding: "utf8" });
  const kinds = String(r.stdout || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return {
    hasVideo: kinds.includes("video"),
    hasAudio: kinds.includes("audio"),
  };
}

async function fetchFile(uri, dest) {
  if (!/^https?:\/\//i.test(uri)) {
    const err = new Error("MEDIA_FETCH_FAIL");
    err.code = "MEDIA_FETCH_FAIL";
    throw err;
  }
  const res = await fetch(uri, { redirect: "follow" });
  if (!res.ok) {
    const err = new Error(`fetch ${res.status}`);
    err.code = "MEDIA_FETCH_FAIL";
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function parseTimeline(body) {
  const scenesIn = Array.isArray(body.scenes) ? body.scenes : [];
  if (!scenesIn.length) {
    const err = new Error("scenes required");
    err.code = "SCHEMA_INVALID";
    throw err;
  }
  const scenes = [];
  for (const s of scenesIn) {
    const imageUri = String(s.imageUri || s.uri || "").trim();
    const durationSec = Number(s.durationSec ?? s.duration);
    if (!imageUri || !Number.isFinite(durationSec) || durationSec <= 0) {
      const err = new Error("each scene needs imageUri and durationSec > 0");
      err.code = "SCHEMA_INVALID";
      throw err;
    }
    scenes.push({ imageUri, durationSec });
  }
  const audioUri = String(body.audioUri || body.narrationUri || "").trim();
  if (!audioUri) {
    const err = new Error("audioUri required");
    err.code = "SCHEMA_INVALID";
    throw err;
  }
  const requested = scenes.reduce((a, s) => a + s.durationSec, 0);
  return { scenes, audioUri, requested };
}

async function renderTimeline({ scenes, audioUri, requested, outputPath }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "msr-"));
  try {
    const parts = [];
    for (let i = 0; i < scenes.length; i++) {
      const img = path.join(work, `img-${i}${path.extname(new URL(scenes[i].imageUri).pathname) || ".png"}`);
      await fetchFile(scenes[i].imageUri, img);
      const clip = path.join(work, `clip-${i}.mp4`);
      await run("ffmpeg", [
        "-y",
        "-loop", "1",
        "-i", img,
        "-t", String(scenes[i].durationSec),
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-an",
        clip,
      ]);
      parts.push(clip);
    }
    const list = path.join(work, "list.txt");
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const silent = path.join(work, "silent.mp4");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
    const audio = path.join(work, "voice");
    await fetchFile(audioUri, audio);
    await run("ffmpeg", [
      "-y",
      "-i", silent,
      "-i", audio,
      "-filter_complex", `[1:a]apad=pad_dur=${requested}[a]`,
      "-map", "0:v",
      "-map", "[a]",
      "-t", String(requested),
      "-c:v", "copy",
      "-c:a", "aac",
      "-ac", "2",
      "-ar", "44100",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if ((url.pathname === "/" || url.pathname === "/health") && req.method === "GET") {
    const ok = ffmpegOk();
    return json(res, ok ? 200 : 503, {
      connected: ok,
      backend: "ffmpeg-worker",
      tokenConfigured: Boolean(TOKEN),
      outputDir: OUT,
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
    if (!TOKEN) return json(res, 503, { rendered: false, code: "AUTH_NOT_CONFIGURED", message: "AUTH_NOT_CONFIGURED" });
    if (!checkAuth(req)) return unauthorized(res);
    if (!ffmpegOk()) return json(res, 503, { rendered: false, code: "FFMPEG_MISSING", message: "FFmpeg missing" });
    try {
      const body = await readBody(req);
      const projectAssetId = String(body.projectAssetId || "").trim();
      const outputName = String(body.outputName || "").trim();
      if (!projectAssetId) return json(res, 400, { rendered: false, code: "SCHEMA_INVALID", message: "PROJECT_ASSET_ID_REQUIRED" });
      if (!outputName) return json(res, 400, { rendered: false, code: "SCHEMA_INVALID", message: "OUTPUT_NAME_REQUIRED" });
      const timeline = parseTimeline(body);
      const id = `rnd_${crypto.randomUUID()}`;
      const filename = `${id}.mp4`;
      const outputPath = path.join(OUT, filename);
      await renderTimeline({ ...timeline, outputPath });
      const inspected = probeDuration(outputPath);
      const streams = probeStreams(outputPath);
      if (!fs.existsSync(outputPath)) {
        return json(res, 500, { rendered: false, code: "ENCODE_FAIL", message: "no output file" });
      }
      return json(res, 200, {
        rendered: true,
        externalRenderId: id,
        outputUri: `${PUBLIC_BASE}/out/${filename}`,
        mimeType: "video/mp4",
        requestedDurationSec: timeline.requested,
        inspectedDurationSec: inspected,
        hasVideo: streams.hasVideo,
        hasAudio: streams.hasAudio,
        outputDir: OUT,
      });
    } catch (err) {
      const code = err.code || (String(err.message || "").includes("ffmpeg") ? "ENCODE_FAIL" : "ENCODE_FAIL");
      const httpCode = code === "SCHEMA_INVALID" ? 400 : code === "MEDIA_FETCH_FAIL" ? 422 : 500;
      return json(res, httpCode, { rendered: false, code, message: String(err.message || err) });
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`moonshadow-renderer on :${PORT} ffmpeg=${ffmpegOk()} public=${PUBLIC_BASE} token=${TOKEN ? "set" : "missing"} out=${OUT}`);
});
