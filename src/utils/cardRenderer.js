// 共用 render 介面：所有需要 satori + resvg 的卡片都呼叫 renderCard，
// 內部把工作丟到 worker thread 處理，主執行緒不會被 CPU 阻塞。
//
// 也提供共用的 fetchAvatarDataUri（含短 timeout + LRU cache），
// 避免各 generator 各自實作、各自吃 8 秒 timeout。

const path = require("path");
const { Worker } = require("worker_threads");
const axios = require("axios");

const LruCache = require("./lruCache");

// ─── render worker（常駐 + lazy） ────────────────────────────────────────
let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, "cardRenderWorker.js"));
  worker.on("message", (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.buf);
    } else {
      const err = new Error(msg.error || "card render worker error");
      if (msg.stack) err.stack = msg.stack;
      entry.reject(err);
    }
  });
  worker.on("error", (err) => {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
    worker = null;
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      const err = new Error(`card render worker exited with code ${code}`);
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    }
    worker = null;
  });
  return worker;
}

function renderCard({ markup, width, height }) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, payload: { markup, width, height } });
  });
}

// ─── avatar 抓取 + cache ────────────────────────────────────────────────
// 縮短 timeout（原本各檔案 5~8s，避免單一玩家的慢 CDN 拖垮其他互動），
// 並做 in-memory cache：同一 URL 短時間內不再抓。
const AVATAR_CACHE = new LruCache(512);
const AVATAR_TTL_MS = 10 * 60 * 1000; // 10 分鐘
const AVATAR_TIMEOUT_MS = 3000;

function detectImageMime(buffer, contentType) {
  if (buffer && buffer.length >= 4) {
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("image/png")) return "image/png";
    if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return "image/jpeg";
    if (ct.includes("image/webp")) return "image/webp";
  }
  return null;
}

async function fetchAvatarDataUri(url) {
  if (!url) return null;
  const now = Date.now();
  const cached = AVATAR_CACHE.get(url);
  if (cached && now - cached.at < AVATAR_TTL_MS) return cached.uri;

  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: AVATAR_TIMEOUT_MS,
    });
    const buffer = Buffer.from(res.data);
    const mime = detectImageMime(buffer, res.headers?.["content-type"]);
    if (!mime) return null;
    const uri = `data:${mime};base64,${buffer.toString("base64")}`;
    AVATAR_CACHE.set(url, { uri, at: now });
    return uri;
  } catch (_) {
    return null;
  }
}

module.exports = {
  renderCard,
  fetchAvatarDataUri,
};
