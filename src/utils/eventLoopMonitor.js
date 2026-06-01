// 量測主執行緒 event loop delay：用 perf_hooks.monitorEventLoopDelay
// 取得直方圖，每次取樣後 reset，可以看到最近一段時間內主執行緒被阻塞多嚴重。
//
// 用途：暴露在 /diagnostics，異常飆高（例如 max > 1000ms）通常代表有同步 CPU
// 工作在主執行緒（生圖、JSON 大解析、巨大 array 操作）阻塞 gateway。

const { monitorEventLoopDelay } = require("perf_hooks");

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

// 回傳直方圖快照（單位：毫秒），並 reset 視窗，
// 讓下一次取樣只看「上次取樣到現在」這段。
function snapshot() {
  const data = {
    min: nsToMs(histogram.min),
    max: nsToMs(histogram.max),
    mean: nsToMs(histogram.mean),
    stddev: nsToMs(histogram.stddev),
    p50: nsToMs(histogram.percentile(50)),
    p95: nsToMs(histogram.percentile(95)),
    p99: nsToMs(histogram.percentile(99)),
  };
  histogram.reset();
  return data;
}

module.exports = { snapshot };
