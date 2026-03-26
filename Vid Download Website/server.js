const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");
const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_VIDEO_UPLOAD = 500 * 1024 * 1024; // 500 MB

const progressMap = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function normalizeUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      reject(new Error("Missing multipart boundary"));
      return;
    }

    const boundary = boundaryMatch[1];
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const parts = {};
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      let start = 0;

      while (true) {
        const partStart = buffer.indexOf(boundaryBuffer, start);
        if (partStart === -1) break;

        const nextBoundary = buffer.indexOf(boundaryBuffer, partStart + boundaryBuffer.length);
        if (nextBoundary === -1) break;

        const partData = buffer.slice(partStart + boundaryBuffer.length, nextBoundary);
        const headerEnd = partData.indexOf("\r\n\r\n");
        if (headerEnd === -1) { start = nextBoundary; continue; }

        const headerStr = partData.slice(0, headerEnd).toString();
        const body = partData.slice(headerEnd + 4);
        // Remove trailing \r\n
        const cleanBody = body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a
          ? body.slice(0, body.length - 2)
          : body;

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);

        if (nameMatch) {
          if (filenameMatch) {
            parts[nameMatch[1]] = { filename: filenameMatch[1], data: cleanBody };
          } else {
            parts[nameMatch[1]] = cleanBody.toString();
          }
        }

        start = nextBoundary;
      }

      resolve(parts);
    });
  });
}

// YouTube requires cookies to avoid "Sign in to confirm you're not a bot" errors.
// Place a cookies.txt file (Netscape format) in the project root.
// Export it from Chrome using "Get cookies.txt LOCALLY" extension on youtube.com
const COOKIES_FILE = path.join(__dirname, "cookies.txt");

function getCookieArgs() {
  if (fs.existsSync(COOKIES_FILE)) {
    return ["--cookies", COOKIES_FILE];
  }
  return [];
}

// Log cookie status on startup
if (fs.existsSync(COOKIES_FILE)) {
  console.log("✅ cookies.txt found — YouTube authentication enabled");
} else {
  console.log("⚠️  No cookies.txt found — YouTube may block some requests");
  console.log("   Export cookies from Chrome: install 'Get cookies.txt LOCALLY' extension");
  console.log("   Go to youtube.com → click extension → Export → save as cookies.txt here");
}

function runYtDlp(args, onProgress) {
  return new Promise((resolve, reject) => {
    const defaultArgs = ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : [];
    const cookieArgs = getCookieArgs();
    const pythonCmd = os.platform() === 'win32' ? 'python' : 'python3';
    const child = spawn(pythonCmd, ["-m", "yt_dlp", ...defaultArgs, ...cookieArgs, ...args], {
      cwd: __dirname,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;

      if (onProgress) {
        const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (match) {
          onProgress(parseFloat(match[1]));
        } else if (text.includes("Merging formats")) {
          onProgress("merging");
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || "yt-dlp command failed"));
    });
  });
}

function extractResolutionOptions(info) {
  const heights = new Map();

  for (const format of info.formats || []) {
    if (!format.height) continue;

    const hasAudio = format.acodec && format.acodec !== 'none';
    const hasVideo = format.vcodec && format.vcodec !== 'none';
    if (!hasVideo) continue; // skip audio-only streams

    const isMerged = hasAudio && hasVideo;
    const isDirectPlayable = ['mp4', 'webm'].includes(format.ext) &&
      (format.protocol || '').startsWith('http');

    const existing = heights.get(format.height);

    // Priority: merged+direct > merged > video-only direct > video-only
    const score = (isMerged ? 2 : 0) + (isDirectPlayable ? 1 : 0);
    const existingScore = existing
      ? (existing.isMerged ? 2 : 0) + (existing.isDirectPlayable ? 1 : 0)
      : -1;

    if (score > existingScore) {
      heights.set(format.height, {
        value: String(format.height),
        label: `${format.height}p`,
        directUrl: isDirectPlayable ? format.url : null,
        isMerged,
        isDirectPlayable,
        filesize: format.filesize || format.filesize_approx || null
      });
    }
  }

  const sorted = [...heights.values()].sort((a, b) => Number(a.value) - Number(b.value));
  return sorted;
}

function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim();
}

// ─── Handlers ───

async function handleMetadata(req, res) {
  const body = await parseBody(req);
  const targetUrl = normalizeUrl(body.url);

  if (!targetUrl) {
    sendJson(res, 400, { error: "Please provide a valid video URL." });
    return;
  }

  // Let yt-dlp use its default client selection — it returns all quality tiers
  // (144p through 4K) with video-only + audio streams that get merged via FFmpeg
  const { stdout } = await runYtDlp([
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    targetUrl
  ]);

  const info = JSON.parse(stdout);
  const resolutions = extractResolutionOptions(info);

  sendJson(res, 200, {
    title: info.title,
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    webpageUrl: info.webpage_url || targetUrl,
    uploader: info.uploader || info.channel || null,
    resolutions
  });
}

async function handleDownload(req, res) {
  const body = await parseBody(req);
  const targetUrl = normalizeUrl(body.url);
  const resolution = /^\d{3,4}$/.test(String(body.resolution || "")) ? String(body.resolution) : "720";
  const downloadId = body.downloadId || "unknown";

  if (!targetUrl) {
    sendJson(res, 400, { error: "Please provide a valid video URL." });
    return;
  }

  await ensureDir(DOWNLOAD_DIR);
  progressMap.set(downloadId, { percent: 0, status: 'starting' });

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const template = path.join(DOWNLOAD_DIR, `${requestId}-%(title).120B.%(ext)s`);
  // Prefer best video up to chosen resolution merged with best audio
  // Falls back through progressively simpler formats so it always works
  const format = [
    `bestvideo[ext=mp4][height<=${resolution}]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${resolution}]+bestaudio`,
    `bestvideo[height<=${resolution}]`,
    `best[height<=${resolution}]`,
    `best`
  ].join('/');

  try {
    await runYtDlp([
      "--no-playlist",
      "--no-warnings",
      "--restrict-filenames",
      "--newline",
      "--concurrent-fragments",
      "20",
      "-f", format,
      "--merge-output-format", "mp4",
      "-o", template,
      targetUrl
    ], (progress) => {
      if (typeof progress === 'number') {
        progressMap.set(downloadId, { percent: progress, status: 'downloading' });
      } else if (progress === 'merging') {
        progressMap.set(downloadId, { percent: 100, status: 'merging' });
      }
    });
  } catch (error) {
    progressMap.set(downloadId, { percent: 0, status: 'error' });
    throw error;
  }

  progressMap.set(downloadId, { percent: 100, status: 'completed' });

  const downloaded = (await fsp.readdir(DOWNLOAD_DIR))
    .filter((name) => name.startsWith(`${requestId}-`))
    .map((name) => path.join(DOWNLOAD_DIR, name));

  if (downloaded.length === 0) {
    throw new Error("Download completed but file was not found.");
  }

  const filePath = downloaded[0];
  const stat = await fsp.stat(filePath);
  const originalName = path.basename(filePath).replace(`${requestId}-`, "");
  const downloadName = safeFilename(originalName || `video-${resolution}p.mp4`);

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Cache-Control": "no-store"
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  const cleanup = async () => {
    try { await fsp.unlink(filePath); } catch { }
  };

  stream.on("close", cleanup);
  stream.on("error", cleanup);
  res.on("close", cleanup);
}

async function handleDownloadAudio(req, res) {
  const body = await parseBody(req);
  const targetUrl = normalizeUrl(body.url);
  const downloadId = body.downloadId || "unknown";

  if (!targetUrl) {
    sendJson(res, 400, { error: "Please provide a valid video URL." });
    return;
  }

  await ensureDir(DOWNLOAD_DIR);
  progressMap.set(downloadId, { percent: 0, status: 'starting' });

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const template = path.join(DOWNLOAD_DIR, `${requestId}-%(title).120B.%(ext)s`);

  try {
    await runYtDlp([
      "--no-playlist",
      "--no-warnings",
      "--restrict-filenames",
      "--newline",
      "--concurrent-fragments",
      "20",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "-o", template,
      targetUrl
    ], (progress) => {
      if (typeof progress === 'number') {
        progressMap.set(downloadId, { percent: progress, status: 'downloading' });
      }
    });
  } catch (error) {
    progressMap.set(downloadId, { percent: 0, status: 'error' });
    throw error;
  }

  progressMap.set(downloadId, { percent: 100, status: 'completed' });

  const downloaded = (await fsp.readdir(DOWNLOAD_DIR))
    .filter((name) => name.startsWith(`${requestId}-`))
    .map((name) => path.join(DOWNLOAD_DIR, name));

  if (downloaded.length === 0) {
    throw new Error("Audio extraction completed but file was not found.");
  }

  const filePath = downloaded[0];
  const stat = await fsp.stat(filePath);
  const originalName = path.basename(filePath).replace(`${requestId}-`, "");
  const downloadName = safeFilename(originalName || "audio.mp3");

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Cache-Control": "no-store"
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  const cleanup = async () => {
    try { await fsp.unlink(filePath); } catch { }
  };

  stream.on("close", cleanup);
  stream.on("error", cleanup);
  res.on("close", cleanup);
}

async function handleConvert(req, res) {
  const parts = await parseMultipart(req);

  if (!parts.audio || !parts.audio.data) {
    sendJson(res, 400, { error: "No audio file uploaded." });
    return;
  }

  const bitrate = ["128", "192", "256", "320"].includes(parts.bitrate) ? parts.bitrate : "320";

  await ensureDir(UPLOAD_DIR);
  await ensureDir(DOWNLOAD_DIR);

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(UPLOAD_DIR, `${requestId}-input.wav`);
  const outputPath = path.join(DOWNLOAD_DIR, `${requestId}-output.mp3`);

  await fsp.writeFile(inputPath, parts.audio.data);

  const ffmpeg = ffmpegPath || "ffmpeg";
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-i", inputPath,
      "-vn",
      "-ab", `${bitrate}k`,
      "-ar", "44100",
      "-y",
      outputPath
    ], { windowsHide: true });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg conversion failed."));
    });
  });

  // Cleanup input
  try { await fsp.unlink(inputPath); } catch { }

  const stat = await fsp.stat(outputPath);
  const outputName = (parts.audio.filename || "audio.wav").replace(/\.wav$/i, ".mp3");

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${safeFilename(outputName)}"`,
    "Cache-Control": "no-store"
  });

  const stream = fs.createReadStream(outputPath);
  stream.pipe(res);

  const cleanup = async () => {
    try { await fsp.unlink(outputPath); } catch { }
  };

  stream.on("close", cleanup);
  stream.on("error", cleanup);
  res.on("close", cleanup);
}

// ─── Video Compressor Helpers ───

function getVideoDuration(filePath) {
  // Use ffmpeg -i (not ffprobe) since ffmpeg-static doesn't include ffprobe
  const ffmpeg = ffmpegPath || 'ffmpeg';
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-i', filePath], { windowsHide: true });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', () => {
      // Parse "Duration: HH:MM:SS.ms" from ffmpeg's stderr
      const match = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) {
        const dur = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
        console.log(`[vc] Duration detected: ${dur.toFixed(2)}s for ${path.basename(filePath)}`);
        resolve(dur);
      } else {
        console.log(`[vc] Could not detect duration for ${path.basename(filePath)}`);
        resolve(0);
      }
    });
    child.on('error', () => resolve(0));
  });
}

function runFfmpeg(args) {
  const ffmpeg = ffmpegPath || 'ffmpeg';
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.trim() || 'FFmpeg failed'));
    });
  });
}

function runFfmpegWithProgress(args, durationSec, compId) {
  const ffmpeg = ffmpegPath || 'ffmpeg';
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (durationSec > 0 && compId) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const sec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
          const pct = Math.min(99, Math.round((sec / durationSec) * 100));
          progressMap.set(compId, { percent: pct, status: 'compressing' });
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr.slice(-500).trim() || 'FFmpeg failed'));
    });
  });
}

async function compressVideoFile(inputPath, outputPath, options, compId) {
  const { targetMb, crf: userCrf } = options;
  const duration = await getVideoDuration(inputPath);

  console.log(`[vc] compressVideoFile (H.265/HEVC): targetMb=${targetMb}, crf=${userCrf}, duration=${duration}s`);

  if (userCrf) {
    // Direct CRF mode — H.265
    console.log(`[vc] Using H.265 CRF mode: ${userCrf} (fast preset)`);
    progressMap.set(compId, { percent: 5, status: 'compressing' });
    await runFfmpegWithProgress([
      '-i', inputPath,
      '-c:v', 'libx265',
      '-crf', String(userCrf),
      '-preset', 'fast',
      '-tag:v', 'hvc1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ], duration, compId);
    return;
  }

  if (targetMb && duration > 0) {
    // Single-pass bitrate targeting (much faster than two-pass, ~90% as accurate)
    const targetBytes = targetMb * 1024 * 1024;
    const targetBitsTotal = targetBytes * 8;
    const audioBitrate = 128000; // 128kbps audio
    const videoBitrate = Math.max(50000, Math.floor((targetBitsTotal / duration) - audioBitrate));
    const maxRate = Math.floor(videoBitrate * 1.5);
    const bufSize = Math.floor(videoBitrate * 2);

    console.log(`[vc] Using H.265 single-pass: targetMb=${targetMb}, videoBitrate=${videoBitrate}bps (fast preset)`);
    progressMap.set(compId, { percent: 5, status: 'compressing' });

    await runFfmpegWithProgress([
      '-i', inputPath,
      '-c:v', 'libx265',
      '-b:v', String(videoBitrate),
      '-maxrate', String(maxRate),
      '-bufsize', String(bufSize),
      '-preset', 'fast',
      '-tag:v', 'hvc1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ], duration, compId);
    return;
  }

  // Fallback: CRF 28 (good default for x265)
  console.log(`[vc] FALLBACK: using H.265 CRF 28 (fast preset)`);
  progressMap.set(compId, { percent: 5, status: 'compressing' });
  await runFfmpegWithProgress([
    '-i', inputPath,
    '-c:v', 'libx265',
    '-crf', '28',
    '-preset', 'fast',
    '-tag:v', 'hvc1',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath
  ], duration, compId);
}

// ─── Video Compressor Handlers ───

async function handleCompressVideo(req, res) {
  const parts = await parseMultipart(req);

  if (!parts.video || !parts.video.data) {
    sendJson(res, 400, { error: "No video file uploaded." });
    return;
  }

  if (parts.video.data.length > MAX_VIDEO_UPLOAD) {
    sendJson(res, 400, { error: "File too large. Maximum 500 MB." });
    return;
  }

  const compId = parts.compressionId || `comp-${Date.now()}`;
  const targetMb = parts.targetMb ? parseFloat(parts.targetMb) : null;
  const crf = parts.crf ? parseInt(parts.crf) : null;

  await ensureDir(UPLOAD_DIR);
  await ensureDir(DOWNLOAD_DIR);

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = path.extname(parts.video.filename || '.mp4').toLowerCase() || '.mp4';
  const inputPath = path.join(UPLOAD_DIR, `${requestId}-input${ext}`);
  const outputPath = path.join(DOWNLOAD_DIR, `${requestId}-compressed.mp4`);

  await fsp.writeFile(inputPath, parts.video.data);
  const originalSize = parts.video.data.length;

  progressMap.set(compId, { percent: 0, status: 'compressing' });

  // Guard: if target MB is >= original size, cap it to avoid making file bigger
  const originalMb = originalSize / 1048576;
  let effectiveTargetMb = targetMb;
  if (targetMb && targetMb >= originalMb) {
    console.log(`[vc] Target ${targetMb}MB >= original ${originalMb.toFixed(2)}MB — capping to ${(originalMb * 0.7).toFixed(2)}MB`);
    effectiveTargetMb = Math.max(1, originalMb * 0.7); // Auto-reduce to 70% of original
  }

  try {
    await compressVideoFile(inputPath, outputPath, { targetMb: effectiveTargetMb, crf }, compId);
  } catch (error) {
    progressMap.set(compId, { percent: 0, status: 'error' });
    try { await fsp.unlink(inputPath); } catch {}
    throw error;
  }

  progressMap.set(compId, { percent: 100, status: 'completed' });

  // Cleanup input
  try { await fsp.unlink(inputPath); } catch {}

  const stat = await fsp.stat(outputPath);
  const baseName = (parts.video.filename || 'video.mp4').replace(/\.[^.]+$/, '');
  const downloadName = safeFilename(`${baseName}-compressed.mp4`);

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "X-Original-Size": String(originalSize),
    "Access-Control-Expose-Headers": "X-Original-Size, Content-Disposition",
    "Cache-Control": "no-store"
  });

  const stream = fs.createReadStream(outputPath);
  stream.pipe(res);
  const cleanup = async () => { try { await fsp.unlink(outputPath); } catch {} };
  stream.on("close", cleanup);
  stream.on("error", cleanup);
  res.on("close", cleanup);
}

async function handleCompressVideoUrl(req, res) {
  const body = await parseBody(req);
  const targetUrl = normalizeUrl(body.url);
  const compId = body.compressionId || `comp-${Date.now()}`;
  const targetMb = body.targetMb ? parseFloat(body.targetMb) : null;
  const crf = body.crf ? parseInt(body.crf) : null;

  if (!targetUrl) {
    sendJson(res, 400, { error: "Please provide a valid video URL." });
    return;
  }

  await ensureDir(DOWNLOAD_DIR);

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dlTemplate = path.join(DOWNLOAD_DIR, `${requestId}-source.%(ext)s`);

  progressMap.set(compId, { percent: 0, status: 'downloading' });

  // Download the video first
  try {
    await runYtDlp([
      "--no-playlist",
      "--no-warnings",
      "--restrict-filenames",
      "--newline",
      "--concurrent-fragments", "20",
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", dlTemplate,
      targetUrl
    ], (progress) => {
      if (typeof progress === 'number') {
        progressMap.set(compId, { percent: Math.round(progress * 0.4), status: 'downloading' });
      }
    });
  } catch (error) {
    progressMap.set(compId, { percent: 0, status: 'error' });
    throw error;
  }

  // Find downloaded file
  const downloaded = (await fsp.readdir(DOWNLOAD_DIR))
    .filter((name) => name.startsWith(`${requestId}-source`))
    .map((name) => path.join(DOWNLOAD_DIR, name));

  if (downloaded.length === 0) {
    throw new Error("Download completed but file was not found.");
  }

  const inputPath = downloaded[0];
  const originalStat = await fsp.stat(inputPath);
  const originalSize = originalStat.size;
  const outputPath = path.join(DOWNLOAD_DIR, `${requestId}-compressed.mp4`);

  // If percent mode was used from URL (no file size known), recalculate target
  let effectiveTargetMb = targetMb;
  if (!effectiveTargetMb && !crf) {
    effectiveTargetMb = Math.max(1, originalSize / 1048576 * 0.5); // default 50% reduction
  }

  progressMap.set(compId, { percent: 40, status: 'compressing' });

  try {
    await compressVideoFile(inputPath, outputPath, {
      targetMb: effectiveTargetMb,
      crf: crf
    }, compId);
  } catch (error) {
    progressMap.set(compId, { percent: 0, status: 'error' });
    try { await fsp.unlink(inputPath); } catch {}
    throw error;
  }

  progressMap.set(compId, { percent: 100, status: 'completed' });

  // Cleanup source
  try { await fsp.unlink(inputPath); } catch {}

  const stat = await fsp.stat(outputPath);
  const downloadName = safeFilename(`compressed-video-${requestId}.mp4`);

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "X-Original-Size": String(originalSize),
    "Access-Control-Expose-Headers": "X-Original-Size, Content-Disposition",
    "Cache-Control": "no-store"
  });

  const stream = fs.createReadStream(outputPath);
  stream.pipe(res);
  const cleanup = async () => { try { await fsp.unlink(outputPath); } catch {} };
  stream.on("close", cleanup);
  stream.on("error", cleanup);
  res.on("close", cleanup);
}

async function serveStatic(req, res) {
  let reqPath = req.url.split("?")[0]; // strip query params

  // Route clean URLs to their HTML pages
  if (reqPath === "/") reqPath = "/index.html";
  else if (reqPath === "/downloader") reqPath = "/downloader.html";
  else if (reqPath === "/convert") reqPath = "/convert.html";
  else if (reqPath === "/about") reqPath = "/about.html";
  else if (reqPath === "/mp3") reqPath = "/mp3.html";
  else if (reqPath === "/compressor") reqPath = "/compressor.html";
  else if (reqPath === "/compressor/video") reqPath = "/video-compressor.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

// ─── Server ───

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/metadata") {
      await handleMetadata(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/download") {
      await handleDownload(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/download-audio") {
      await handleDownloadAudio(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/convert") {
      await handleConvert(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/compress-video") {
      await handleCompressVideo(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/compress-video-url") {
      await handleCompressVideoUrl(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/status") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/progress")) {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const id = urlObj.searchParams.get("id");
      if (id && progressMap.has(id)) {
        sendJson(res, 200, progressMap.get(id));
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message || "Something went wrong."
    });
  }
});

ensureDir(DOWNLOAD_DIR)
  .then(() => ensureDir(UPLOAD_DIR))
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Temp download dir: ${DOWNLOAD_DIR}`);
      console.log(`System temp dir: ${os.tmpdir()}`);

      // ─── Uptime Self-Ping Bot ───
      // Render free tier sleeps after 15 min of inactivity.
      // This pings /api/status every 13 minutes to keep it alive.
      const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME;
      if (RENDER_URL || process.env.RENDER) {
        const pingUrl = RENDER_URL
          ? `${RENDER_URL.startsWith('http') ? RENDER_URL : 'https://' + RENDER_URL}/api/status`
          : `http://localhost:${PORT}/api/status`;

        const PING_INTERVAL = 13 * 60 * 1000; // 13 minutes

        setInterval(() => {
          const mod = pingUrl.startsWith('https') ? require('https') : require('http');
          mod.get(pingUrl, (res) => {
            console.log(`[uptime] Ping OK — ${new Date().toLocaleTimeString()}`);
            res.resume(); // drain response
          }).on('error', (err) => {
            console.log(`[uptime] Ping failed: ${err.message}`);
          });
        }, PING_INTERVAL);

        console.log(`✅ Uptime bot active — pinging ${pingUrl} every 13 min`);
      } else {
        console.log(`ℹ️  Uptime bot disabled (not on Render)`);
      }
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
