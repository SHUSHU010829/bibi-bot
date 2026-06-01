const getFortuneTheme = require("./getFortuneTheme");
const { renderCard } = require("./cardRenderer");

const FORTUNE_LABELS_EN = {
  大吉: "GREAT FORTUNE",
  中吉: "GOOD FORTUNE",
  小吉: "SMALL FORTUNE",
  沒想法: "NO COMMENT",
  凶: "MISFORTUNE",
  大凶: "GREAT MISFORTUNE",
};

const FORTUNE_BLESSINGS = {
  大吉: "鴻運當頭　諸事皆宜",
  中吉: "穩步前行　好事將至",
  小吉: "細水長流　日漸轉好",
  沒想法: "順其自然　莫強求之",
  凶: "謹言慎行　以靜制動",
  大凶: "韜光養晦　退一步寬",
};

// Noto Sans TC woff 子集字體缺部分全形標點，做安全替換
const PUNCT_MAP = {
  "，": "、",
  "！": "。",
  "？": "?",
  "；": "、",
  "・": "·",
};

function sanitize(text) {
  if (!text) return text;
  return String(text).replace(/[，！？；・]/g, (c) => PUNCT_MAP[c] || c);
}

function splitPoem(content) {
  if (!content) return [];
  const parts = content.split(/(?<=[，。！？；])/);
  return parts
    .map((s) => sanitize(s.trim()))
    .filter(Boolean)
    .slice(0, 4);
}

// 拆出句尾標點，配合左側同寬的透明幽靈標點，做到本文視覺置中
function parsePoemLine(line) {
  const m = line.match(/^(.+?)([、。?·]+)$/);
  if (!m) return { body: line, punct: "" };
  return { body: m[1], punct: m[2] };
}

function buildMarkup(data) {
  const {
    theme,
    fortuneText,
    fortuneLabel,
    blessing,
    question,
    poemLines,
    poemOrigin,
    poemAuthor,
    dateStr,
    serialNo,
  } = data;

  const hasPoem = poemLines.length > 0;

  return `
    <div style="display:flex;width:1080px;height:1350px;background:${theme.bg};padding:30px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${theme.card};padding:50px 60px;box-sizing:border-box;">

        <!-- A. Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:54px;height:54px;border-radius:9999px;background:${theme.accent};justify-content:center;align-items:center;color:${theme.card};font-family:'NotoSansTC';font-weight:900;font-size:26px;">籤</div>
            <div style="display:flex;flex-direction:column;margin-left:18px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:26px;letter-spacing:8px;color:${theme.ink};line-height:1;">逼逼籤詩</div>
              <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${theme.muted};">FORTUNE TELLING</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:3px;color:${theme.muted};">SERIAL</div>
            <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:22px;letter-spacing:2px;color:${theme.ink};">No.${serialNo}</div>
          </div>
        </div>

        <!-- B. Fortune Badge -->
        <div style="display:flex;flex-direction:column;width:100%;margin-top:30px;padding:46px 0;background:${theme.ink};color:${theme.card};align-items:center;justify-content:center;position:relative;">
          <div style="display:flex;font-family:'SpaceMono';font-size:16px;letter-spacing:10px;color:${theme.muted};">— TODAY'S DRAW —</div>
          <div style="display:flex;margin-top:14px;font-family:'NotoSansTC';font-weight:900;font-size:180px;line-height:1;letter-spacing:32px;padding-left:32px;color:${theme.card};">${fortuneText}</div>
          <div style="display:flex;margin-top:18px;font-family:'SpaceMono';font-size:22px;letter-spacing:8px;color:${theme.accent};">${fortuneLabel}</div>
          <div style="display:flex;margin-top:18px;padding:8px 22px;background:${theme.accent};color:${theme.card};font-family:'NotoSansTC';font-weight:500;font-size:20px;letter-spacing:6px;">${blessing}</div>
        </div>

        <!-- C. Question -->
        <div style="display:flex;width:100%;margin-top:24px;padding:18px 22px;border:2px solid ${theme.ink};box-sizing:border-box;align-items:center;">
          <div style="display:flex;width:46px;height:46px;background:${theme.accent};color:${theme.card};font-family:'NotoSansTC';font-weight:900;font-size:24px;justify-content:center;align-items:center;">問</div>
          <div style="display:flex;flex:1;margin-left:20px;font-family:'NotoSansTC';font-weight:500;font-size:24px;letter-spacing:3px;color:${theme.ink};">${question}</div>
        </div>

        <!-- D. Poem Card -->
        <div style="display:flex;flex:1;flex-direction:column;width:100%;margin-top:22px;padding:36px 40px;background:${theme.card};border:3px dashed ${theme.muted};box-sizing:border-box;align-items:center;justify-content:center;overflow:hidden;">
          ${
            hasPoem
              ? `
                <div style="display:flex;align-items:center;margin-bottom:24px;">
                  <div style="display:flex;width:60px;height:1px;background:${theme.muted};"></div>
                  <div style="display:flex;margin:0 16px;font-family:'NotoSansTC';font-weight:900;font-size:18px;letter-spacing:8px;color:${theme.muted};">籤詩</div>
                  <div style="display:flex;width:60px;height:1px;background:${theme.muted};"></div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:center;width:100%;">
                  ${poemLines
                    .map((line) => {
                      const { body, punct } = parsePoemLine(line);
                      return `
                    <div style="display:flex;justify-content:center;align-items:center;width:100%;font-family:'NotoSansTC';font-weight:500;font-size:38px;line-height:1.7;letter-spacing:6px;">
                      <div style="display:flex;color:transparent;">${punct}</div>
                      <div style="display:flex;color:${theme.ink};">${body}</div>
                      <div style="display:flex;color:${theme.ink};">${punct}</div>
                    </div>
                  `;
                    })
                    .join("")}
                </div>
                <div style="display:flex;width:120px;height:1px;margin-top:30px;background:${theme.muted};"></div>
                <div style="display:flex;margin-top:18px;font-family:'NotoSansTC';font-weight:500;font-size:22px;letter-spacing:4px;color:${theme.muted};">${poemAuthor || "佚名"}　《${poemOrigin || "無題"}》</div>
              `
              : `
                <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:46px;letter-spacing:12px;color:${theme.muted};">籤詩雲遊去了</div>
                <div style="display:flex;margin-top:20px;font-family:'NotoSansTC';font-weight:500;font-size:22px;letter-spacing:6px;color:${theme.muted};">緣分到了再相見</div>
              `
          }
        </div>

        <!-- E. Footer -->
        <div style="display:flex;flex-direction:column;width:100%;margin-top:22px;">
          <div style="display:flex;width:100%;height:1px;border-top:1px dashed ${theme.muted};"></div>
          <div style="display:flex;width:100%;margin-top:14px;align-items:center;">
            <div style="display:flex;flex:1;justify-content:flex-start;font-family:'SpaceMono';font-size:16px;letter-spacing:3px;color:${theme.muted};">${dateStr}</div>
            <div style="display:flex;flex:1;justify-content:center;font-family:'NotoSansTC';font-weight:500;font-size:14px;letter-spacing:4px;color:${theme.muted};">娛樂為主·心誠則靈</div>
            <div style="display:flex;flex:1;justify-content:flex-end;font-family:'SpaceMono';font-size:16px;letter-spacing:8px;color:${theme.muted};">@SHUSHU</div>
          </div>
        </div>

      </div>
    </div>
  `;
}

async function generateFortuneCard(data) {
  const theme = getFortuneTheme(data.fortuneText);
  const fortuneLabel = FORTUNE_LABELS_EN[data.fortuneText] || "FORTUNE";
  const blessing = FORTUNE_BLESSINGS[data.fortuneText] || "今日宜佛系";
  const poemLines = splitPoem(data.poemContent);

  const markup = buildMarkup({
    ...data,
    question: sanitize(data.question),
    poemOrigin: sanitize(data.poemOrigin),
    poemAuthor: sanitize(data.poemAuthor),
    theme,
    fortuneLabel,
    blessing,
    poemLines,
  });
  return renderCard({ markup, width: 1080, height: 1350 });
}

module.exports = generateFortuneCard;
