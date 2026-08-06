const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

// autocomplete 欄位解析失敗的統一錯誤訊息（CLAUDE.md UX 檢查 #2 / #10）：
// 一定要寫出玩家「實際輸入了什麼」+ 有哪些可選項目，只回「找不到 XXX」等於沒講。
const LIST_LIMIT = 10;

function optionLines(options) {
  return options.slice(0, LIST_LIMIT).map((o) => `・${o.name}`);
}

function buildChoiceErrorContainer(result, { what, hint }) {
  const container = new ContainerBuilder().setAccentColor(0xe74c3c);

  if (result.reason === "ambiguous") {
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ❌ ${what}不明確：${result.input}`)
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          ["符合的有好幾個，請指定其中一個：", ...optionLines(result.candidates)].join("\n")
        )
      );
  } else {
    const list = result.options || [];
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ❌ 找不到這個${what}${result.input ? `：${result.input}` : ""}`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          list.length > 0
            ? [
                `目前可選的${what}：`,
                ...optionLines(list),
                ...(list.length > LIST_LIMIT ? [`-# …等共 ${list.length} 個`] : []),
              ].join("\n")
            : `目前沒有可選的${what}。`
        )
      );
  }

  return container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      hint || "-# 輸入時等下拉選單跳出來再點選最保險；直接貼上選單那一行也可以。"
    )
  );
}

module.exports = { buildChoiceErrorContainer };
