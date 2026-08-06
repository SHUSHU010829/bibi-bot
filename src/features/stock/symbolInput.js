// 玩家常常把 autocomplete 顯示的整行字串貼回欄位（「UPPI 統嘩超商」「UPPI 統嘩超商｜持有 100 股」），
// 或乾脆只打中文名。Discord 送出的就是那串原文，直接拿去比對 symbol 必然查無此股。
// 這裡把各種貼法還原成純代號，讓「複製貼上」跟「從下拉選單點選」有一樣的結果。

const NOISE_RE = /[`*「」『』【】()[\]<>]/g;
const SEP_RE = /[|｡・,、/\\]/g;
const STATUS_TAGS = ["已下市", "下市整理中", "⚠️", "持有", "融券", "股"];

function cleanupInput(raw) {
  let text = String(raw ?? "")
    .normalize("NFKC")
    .replace(NOISE_RE, " ")
    .replace(SEP_RE, " ");
  for (const tag of STATUS_TAGS) text = text.split(tag).join(" ");
  return text.replace(/\s+/g, " ").trim();
}

function scoreStock(stock, input) {
  const upper = input.toUpperCase();
  const symbol = (stock.symbol || "").toUpperCase();
  const name = stock.name || "";
  if (!symbol) return 0;

  if (upper === symbol) return 100;
  if (input === name) return 95;

  const tokens = upper.split(" ");
  if (tokens.includes(symbol)) return 90;
  if (name && input.split(" ").includes(name)) return 85;

  if (name && upper.includes(name.toUpperCase())) return 70;
  if (upper.includes(symbol)) return 60;

  if (input.length >= 2 && symbol.startsWith(upper)) return 40;
  if (name && input.length >= 2 && name.startsWith(input)) return 35;
  return 0;
}

function listedBrief(stocks) {
  return stocks.filter((s) => s.enabled !== false).map((s) => ({ symbol: s.symbol, name: s.name }));
}

// 回傳 { ok: true, symbol, name, stock } 或
// { ok: false, reason: "empty" | "not_found" | "ambiguous", input, candidates, listed }
async function resolveSymbol(client, guildId, raw) {
  const input = cleanupInput(raw);
  const stocks = client.stockMarketCollection
    ? await client.stockMarketCollection.find({ guildId }).sort({ symbol: 1 }).toArray()
    : [];
  if (!input) {
    return { ok: false, reason: "empty", input: "", candidates: [], listed: listedBrief(stocks) };
  }

  const scored = stocks
    .map((stock) => ({ stock, score: scoreStock(stock, input) }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) {
    return { ok: false, reason: "not_found", input, candidates: [], listed: listedBrief(stocks) };
  }

  const topScore = Math.max(...scored.map((x) => x.score));
  let best = scored.filter((x) => x.score === topScore).map((x) => x.stock);
  if (best.length > 1) {
    // 同分時以現役股票優先（舊股下市後常有名稱相近的新股）
    const live = best.filter((s) => s.enabled !== false);
    if (live.length === 1) best = live;
    else {
      return {
        ok: false,
        reason: "ambiguous",
        input,
        candidates: (live.length > 1 ? live : best).map((s) => ({ symbol: s.symbol, name: s.name })),
        listed: listedBrief(stocks),
      };
    }
  }

  return { ok: true, symbol: best[0].symbol, name: best[0].name, stock: best[0] };
}

module.exports = { resolveSymbol, cleanupInput };
