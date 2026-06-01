// 共用 render worker：所有 satori + resvg 卡片都跑在這支 worker 裡，
// 避免在主執行緒做大量 CPU 工作（會阻塞 Discord interaction 處理）。
//
// 訊息格式：{ id, payload: { markup, width, height } }
// 回覆格式：{ id, ok: true, buf } 或 { id, ok: false, error, stack }
//
// 字體一次載入全集（TC Black/Medium、JP Black/Medium、SpaceMono 400/700），
// 所有卡片都共用同一份 fontsCache，省記憶體也省 IO。
const { parentPort } = require("worker_threads");
const fs = require("fs/promises");
const path = require("path");
const satori = require("satori").default || require("satori");
const { html } = require("satori-html");
const { Resvg } = require("@resvg/resvg-js");
const { loadAdditionalAsset } = require("./satoriEmoji");

const FONT_DIR = path.join(__dirname, "../../fonts");
let fontsCache = null;

async function loadFonts() {
  if (fontsCache) return fontsCache;
  const [tcBlack, tcMedium, jpBlack, jpMedium, mono] = await Promise.all([
    fs.readFile(path.join(FONT_DIR, "NotoSansTC-Black.woff")),
    fs.readFile(path.join(FONT_DIR, "NotoSansTC-Medium.woff")),
    fs.readFile(path.join(FONT_DIR, "NotoSansJP-Black.otf")),
    fs.readFile(path.join(FONT_DIR, "NotoSansJP-Medium.otf")),
    fs.readFile(path.join(FONT_DIR, "SpaceMono-Regular.woff")),
  ]);
  fontsCache = [
    { name: "SpaceMono", data: mono, weight: 400, style: "normal" },
    { name: "SpaceMono", data: mono, weight: 700, style: "normal" },
    { name: "NotoSansTC", data: tcMedium, weight: 500, style: "normal" },
    { name: "NotoSansTC", data: tcBlack, weight: 900, style: "normal" },
    { name: "NotoSansJP", data: jpMedium, weight: 500, style: "normal" },
    { name: "NotoSansJP", data: jpBlack, weight: 900, style: "normal" },
  ];
  return fontsCache;
}

async function renderOne({ markup, width, height }) {
  const fonts = await loadFonts();
  const element = html(markup);
  const svg = await satori(element, {
    width,
    height,
    fonts,
    loadAdditionalAsset,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  });
  // renderAsync 可讓 worker 內 IO 不獨佔執行緒；對主執行緒沒差，
  // 但對 worker 自己跑多個 task 時較友善。
  const rendered = typeof resvg.renderAsync === "function"
    ? await resvg.renderAsync()
    : resvg.render();
  return Buffer.from(rendered.asPng());
}

parentPort.on("message", async (msg) => {
  const { id, payload } = msg;
  try {
    const buf = await renderOne(payload);
    parentPort.postMessage({ id, ok: true, buf });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: e?.message || String(e),
      stack: e?.stack,
    });
  }
});
