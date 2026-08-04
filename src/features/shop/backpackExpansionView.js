const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const backpackExpansion = require("./backpackExpansion");

// 擴充被擋下的兩種情形（撞硬上限 / 門檻未達成）一律用 Container 呈現：
// 標題說明問題 → 具體差距 → 解決方向。
// ephemeral=false 給「已 deferReply 之後 editReply」的路徑用（旗標在 defer 時就決定了）。
function buildBlockedView(result, { ephemeral = true } = {}) {
  const flags = ephemeral
    ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    : MessageFlags.IsComponentsV2;
  const container = new ContainerBuilder().setAccentColor(0xe74c3c);

  if (result.errorKind === "backpack_cap") {
    const { capacity, max } = result.detail || {};
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## 🎒 背包已達容量上限"),
    );
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `目前容量：**${(capacity || 0).toLocaleString()}** 格\n` +
          `系統上限：**${(max || 0).toLocaleString()}** 格`,
      ),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 已經到頂了，沒有更大的背包可以買。\n"
          + "-# 目前袋子裡超過上限的東西**不會被沒收**，只是暫時放不進新的；用 `/賣出` 換金幣降到上限以下就會恢復正常，也可以寄放到公會倉庫（`/公會` → 倉庫）。",
      ),
    );
    return { components: [container], flags };
  }

  const { capacityBefore, capacityAfter, missing = [] } = result.detail || {};
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("## 🔒 背包擴充條件未達成"),
  );
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `目前容量：**${(capacityBefore || 0).toLocaleString()}** 格\n` +
        `想擴充到：**${(capacityAfter || 0).toLocaleString()}** 格`,
    ),
  );
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**還差這些條件：**\n${missing
        .map((m) => `・${m.label}：需要 ${m.need}（目前 ${m.have}）`)
        .join("\n")}`,
    ),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 超過 5,000 格之後每 500 格會多一道門檻，光有錢買不動——先去 `/挖礦`、`/地下城` 把進度推上去。",
    ),
  );
  return { components: [container], flags };
}

// 商店清單上「背包擴充」那一列要補的個人化資訊：目前容量與下一筆實價。
function shopLine(profile, item) {
  const q = backpackExpansion.quote(profile, 1, item);
  const max = backpackExpansion.maxSlots();
  if (q.atCap) {
    return `-# 🎒 目前 ${q.capacityBefore.toLocaleString()} / ${max.toLocaleString()} 格 — 已達上限`;
  }
  const priceNote =
    q.nextPrice !== item.price
      ? `下一筆 **${q.nextPrice.toLocaleString()}** ${MONEY_EMOJI}（超過 5,000 格後每 500 格漲價）`
      : `下一筆 **${q.nextPrice.toLocaleString()}** ${MONEY_EMOJI}`;
  return `-# 🎒 目前 ${q.capacityBefore.toLocaleString()} / ${max.toLocaleString()} 格・${priceNote}`;
}

module.exports = { buildBlockedView, shopLine };
