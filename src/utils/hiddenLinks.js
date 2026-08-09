// ============================================================
// 隱藏連結遮蔽
// 使用者用 <網址>、||防雷||、程式碼區塊把連結藏起來時，就是不想要預覽，
// 機器人不該再把它撈出來貼一次。
// 作法：把這些區段換成等長空白，後續的連結比對自然跳過，index 也不會位移。
// ============================================================

const HIDDEN_PATTERNS = [
  /```[\s\S]*?```/g, // 程式碼區塊
  /``[^`]*?``/g, // 雙反引號行內程式碼
  /`[^`\n]*?`/g, // 行內程式碼
  /\|\|[\s\S]*?\|\|/g, // 防雷
  /<[^<>\s]+>/g, // <網址>：Discord 原生的「不要預覽」寫法
];

function maskHiddenSegments(content) {
  if (!content) return "";

  let masked = content;
  for (const pattern of HIDDEN_PATTERNS) {
    masked = masked.replace(pattern, (segment) =>
      segment.replace(/[^\n]/g, " "),
    );
  }
  return masked;
}

module.exports = { maskHiddenSegments };
