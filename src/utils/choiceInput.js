// Discord autocomplete 的 name（顯示）與 value（送出）不同時，玩家一定會複製顯示文字貼回欄位，
// 而 Discord 會把那整串原文原封不動送出。指令層若直接把 getString() 當 id 用就必然查無此項。
//
// 這裡提供三件事，讓「選單清單」與「輸入解析」共用同一份選項來源（見 CLAUDE.md UX 檢查 #10）：
//   buildChoices  → 產生 {name, value}[]（截到 Discord 上限）
//   filterChoices → autocomplete 用的雙向比對（貼整行時選單不會變空的）
//   resolveChoice → 把玩家送出的原文還原成 value

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu;
const NOISE_RE = /[`*「」『』【】()[\]<>]/g;
const SEP_RE = /[|｜・,、/\\]/g;

const MAX_OPTIONS = 25;
const MAX_LEN = 100;

function cleanupChoiceInput(raw, strip = []) {
  let text = String(raw ?? "").normalize("NFKC").replace(EMOJI_RE, " ");
  for (const re of strip) text = text.replace(re, " ");
  return text.replace(NOISE_RE, " ").replace(SEP_RE, " ").replace(/\s+/g, " ").trim();
}

function normalized(option, strip) {
  return {
    value: cleanupChoiceInput(option.value, strip).toLowerCase(),
    name: cleanupChoiceInput(option.name, strip).toLowerCase(),
    search: cleanupChoiceInput(option.search || "", strip).toLowerCase(),
  };
}

function scoreChoice(option, input, strip) {
  const o = normalized(option, strip);
  const q = input.toLowerCase();
  if (!o.value) return 0;

  if (q === o.value) return 100;
  if (q === o.name) return 95;
  if (q.split(" ").includes(o.value)) return 90;
  if (o.search && q === o.search) return 88;
  if (o.name && q.includes(o.name)) return 75;
  if (o.name && q.length >= 2 && o.name.includes(q)) return 70;
  if (o.value.length >= 2 && q.includes(o.value)) return 60;
  if (o.search && q.length >= 2 && o.search.includes(q)) return 50;
  if (q.length >= 2 && o.value.startsWith(q)) return 40;
  if (o.name && q.length >= 2 && o.name.startsWith(q)) return 35;
  return 0;
}

function buildChoices(items, toChoice) {
  return items.map((item) => {
    const c = toChoice(item);
    return { ...c, name: String(c.name).slice(0, MAX_LEN), value: String(c.value).slice(0, MAX_LEN) };
  });
}

// autocomplete 比對：除了「選項含輸入」，也要「輸入含選項」——玩家貼整行時才不會 0 筆
function filterChoices(options, query, { strip = [] } = {}) {
  const q = cleanupChoiceInput(query, strip).toLowerCase();
  if (!q) return options;
  return options.filter((option) => {
    const o = normalized(option, strip);
    if (o.name.includes(q) || o.value.includes(q) || o.search.includes(q)) return true;
    return q.includes(o.name) || (o.value.length >= 2 && q.includes(o.value));
  });
}

async function respondChoices(interaction, options, query, opts = {}) {
  const list = filterChoices(options, query, opts)
    .slice(0, MAX_OPTIONS)
    .map(({ name, value }) => ({ name, value }));
  await interaction.respond(list).catch(() => {});
}

// 回傳 { ok: true, value, option } 或
// { ok: false, reason: "empty" | "not_found" | "ambiguous", input, candidates, options }
function resolveChoice(raw, options, { strip = [], preferred } = {}) {
  const input = cleanupChoiceInput(raw, strip);
  if (!input) return { ok: false, reason: "empty", input: "", candidates: [], options };

  const scored = options
    .map((option) => ({ option, score: scoreChoice(option, input, strip) }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) {
    return { ok: false, reason: "not_found", input, candidates: [], options };
  }

  const topScore = Math.max(...scored.map((x) => x.score));
  let best = scored.filter((x) => x.score === topScore).map((x) => x.option);
  if (best.length > 1 && preferred) {
    const picked = best.filter(preferred);
    if (picked.length === 1) best = picked;
  }
  if (best.length > 1) {
    return { ok: false, reason: "ambiguous", input, candidates: best, options };
  }
  return { ok: true, value: best[0].value, option: best[0] };
}

module.exports = {
  buildChoices,
  filterChoices,
  respondChoices,
  resolveChoice,
  cleanupChoiceInput,
  MAX_OPTIONS,
};
