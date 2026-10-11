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
const IN = process.env.INPUT_DIR || path.join(path.dirname(OUT), "in");
const EXPORT_YOUTUBE =
  process.env.EXPORT_YOUTUBE_DIR || path.join(path.dirname(OUT), "exports", "youtube");
const STUDIO_YOUTUBE =
  process.env.STUDIO_EXPORT_YOUTUBE_DIR ||
  "/workspace/titans-scout/studio-media/exports/youtube";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(IN, { recursive: true });
fs.mkdirSync(EXPORT_YOUTUBE, { recursive: true });

const ALLOWED_TARGET_DURATIONS = new Set([15, 60]);
const ALLOWED_EXPORT_PRESETS = new Set(["youtube"]);

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

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(-800) || `ffmpeg exit ${code}`));
    });
  });
}

function probeDurationSec(inputPath) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("PROBE_FAILED");
  const d = Number.parseFloat(String(r.stdout || "").trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("PROBE_INVALID_DURATION");
  return d;
}

function parseTargetDurationSec(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !ALLOWED_TARGET_DURATIONS.has(n)) {
    const err = new Error("TARGET_DURATION_INVALID");
    err.statusCode = 400;
    err.detail = "targetDurationSec must be 15 or 60";
    throw err;
  }
  return n;
}

function parseExportPreset(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (!ALLOWED_EXPORT_PRESETS.has(s)) {
    const err = new Error("EXPORT_PRESET_INVALID");
    err.statusCode = 400;
    err.detail = 'exportPreset must be "youtube" (or omit)';
    throw err;
  }
  return s;
}

/** Encode tail: default user-media vs YouTube package (H.264 High + AAC + faststart). */
function encodeTail({ exportPreset, outputPath }) {
  if (exportPreset === "youtube") {
    return [
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-metadata",
      "comment=moonshadow-renderer-youtube-export",
      outputPath,
    ];
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-metadata",
    "comment=moonshadow-renderer-user-media",
    outputPath,
  ];
}

function renderStillCard({ title, outputPath }) {
  const safe = String(title || "Moonshadow Short").replace(/[:'\\]/g, " ").slice(0, 80);
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x070b14:s=1080x1920:d=8",
    "-vf",
    `drawtext=text='${safe}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  return runFfmpeg(args);
}

function normalizeInputUri(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("https://") || s.startsWith("http://")) return s;
  if (s.startsWith("file://")) {
    const p = fileURLToPath(s);
    if (!fs.existsSync(p)) throw new Error("INPUT_URI_FILE_MISSING");
    return p;
  }
  if (path.isAbsolute(s) && fs.existsSync(s)) return s;
  if (s.startsWith("ingest/")) {
    const p = path.join(IN, path.basename(s.slice("ingest/".length)));
    if (!fs.existsSync(p)) throw new Error("INPUT_URI_INGEST_MISSING");
    return p;
  }
  throw new Error("INPUT_URI_UNSUPPORTED");
}

function renderUserMedia({ inputUri, outputPath, targetDurationSec, exportPreset }) {
  const input = normalizeInputUri(inputUri);
  const scaleVf = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const baseOut = encodeTail({ exportPreset, outputPath });

  // Default: same-length re-encode (Money GO contract).
  if (targetDurationSec == null) {
    return runFfmpeg(["-y", "-i", input, "-vf", scaleVf, ...baseOut]);
  }

  const srcDur = probeDurationSec(input);
  const target = targetDurationSec;

  if (srcDur >= target) {
    return runFfmpeg(["-y", "-i", input, "-t", String(target), "-vf", scaleVf, ...baseOut]);
  }

  // Shorter → freeze last frame + pad audio to target (duration-modes contract).
  const pad = Math.max(0, target - srcDur);
  const vf = `${scaleVf},tpad=stop_mode=clone:stop_duration=${pad}`;
  return runFfmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    vf,
    "-af",
    `apad=whole_dur=${target}`,
    "-t",
    String(target),
    ...baseOut,
  ]);
}

function copyYoutubeExport(outputPath, id) {
  const filename = `${id}__youtube.mp4`;
  const primary = path.join(EXPORT_YOUTUBE, filename);
  fs.copyFileSync(outputPath, primary);
  let studioPath = null;
  try {
    fs.mkdirSync(STUDIO_YOUTUBE, { recursive: true });
    studioPath = path.join(STUDIO_YOUTUBE, filename);
    fs.copyFileSync(outputPath, studioPath);
  } catch {
    studioPath = null;
  }
  return { filename, primary, studioPath };
}

function safeName(name) {
  return String(name || "upload.mp4")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
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
      userMediaInput: true,
      ingest: true,
      targetDurationModes: [15, 60],
      exportPresets: ["youtube"],
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

  if (url.pathname === "/ingest" && req.method === "POST") {
    if (!TOKEN) return json(res, 503, { ok: false, message: "AUTH_NOT_CONFIGURED" });
    if (!checkAuth(req)) return unauthorized(res);
    try {
      const buf = await readRaw(req);
      if (!buf.length) return json(res, 400, { ok: false, message: "EMPTY_BODY" });
      const filename = safeName(url.searchParams.get("filename") || "upload.mp4");
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const id = `in_${sha.slice(0, 12)}`;
      const destName = `${id}__${filename}`;
      const destAbs = path.join(IN, destName);
      if (!fs.existsSync(destAbs)) fs.writeFileSync(destAbs, buf);
      return json(res, 200, {
        ok: true,
        ingestId: id,
        filename: destName,
        bytes: buf.length,
        sha256: sha,
        inputUri: `ingest/${destName}`,
        note: "Pass inputUri to POST /renders for user-media -i",
      });
    } catch (err) {
      return json(res, 500, { ok: false, message: String(err.message || err) });
    }
  }

  if (url.pathname === "/renders" && req.method === "POST") {
    if (!TOKEN) return json(res, 503, { rendered: false, message: "AUTH_NOT_CONFIGURED" });
    if (!checkAuth(req)) return unauthorized(res);
    if (!ffmpegOk()) return json(res, 503, { rendered: false, message: "FFmpeg missing" });
    try {
      const body = await readJson(req);
      const projectAssetId = String(body.projectAssetId || "").trim();
      const outputName = String(body.outputName || "").trim();
      if (!projectAssetId) {
        return json(res, 400, { rendered: false, message: "PROJECT_ASSET_ID_REQUIRED" });
      }
      if (!outputName) {
        return json(res, 400, { rendered: false, message: "OUTPUT_NAME_REQUIRED" });
      }

      let targetDurationSec = null;
      try {
        targetDurationSec = parseTargetDurationSec(body.targetDurationSec);
      } catch (parseErr) {
        if (parseErr.statusCode === 400) {
          return json(res, 400, {
            rendered: false,
            message: parseErr.message,
            detail: parseErr.detail,
            targetDurationSec: body.targetDurationSec ?? null,
          });
        }
        throw parseErr;
      }

      let exportPreset = null;
      try {
        exportPreset = parseExportPreset(body.exportPreset);
      } catch (parseErr) {
        if (parseErr.statusCode === 400) {
          return json(res, 400, {
            rendered: false,
            message: parseErr.message,
            detail: parseErr.detail,
            exportPreset: body.exportPreset ?? null,
          });
        }
        throw parseErr;
      }

      const inputUri = String(body.inputUri || body.input_uri || "").trim() || null;
      const id = `rnd_${crypto.randomUUID()}`;
      const filename = `${id}.mp4`;
      const outputPath = path.join(OUT, filename);

      let lavfi = true;
      if (inputUri) {
        await renderUserMedia({ inputUri, outputPath, targetDurationSec, exportPreset });
        lavfi = false;
      } else {
        await renderStillCard({ title: body.projectName || outputName, outputPath });
      }

      if (!fs.existsSync(outputPath)) {
        return json(res, 500, { rendered: false, message: "OUTPUT_MISSING" });
      }

      let exportCopy = null;
      if (exportPreset === "youtube" && !lavfi) {
        exportCopy = copyYoutubeExport(outputPath, id);
      }

      return json(res, 200, {
        rendered: true,
        externalRenderId: id,
        outputUri: `${PUBLIC_BASE}/out/${filename}`,
        mimeType: "video/mp4",
        lavfi,
        inputUriUsed: Boolean(inputUri),
        targetDurationSec: inputUri ? targetDurationSec : null,
        exportPreset: inputUri ? exportPreset : null,
        exportPath: exportCopy ? exportCopy.primary : null,
        exportStudioPath: exportCopy ? exportCopy.studioPath : null,
        exportFilename: exportCopy ? exportCopy.filename : null,
        note: exportPreset === "youtube" ? "YouTube package only — no auto-post" : undefined,
      });
    } catch (err) {
      return json(res, 500, { rendered: false, message: String(err.message || err) });
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `moonshadow-renderer on :${PORT} ffmpeg=${ffmpegOk()} public=${PUBLIC_BASE} token=${TOKEN ? "set" : "missing"} userMediaInput=true ingest=true targetDurationModes=15,60 exportPresets=youtube`,
  );
});
