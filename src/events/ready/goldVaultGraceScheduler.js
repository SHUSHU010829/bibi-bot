require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { registerCron } = require("../../utils/cronRegistry");
const { bank } = require("../../config");
const goldService = require("../../features/bank/goldService");
const vaultGraceService = require("../../features/bank/vaultGraceService");

// 金庫容量上限的寬限期執行：每天掃一次超出上限的金庫，
// 第一次發 DM 通知並開始倒數，期限內每天提醒，期限到把賣得掉的超額克數強制折現。

const U = () => bank?.gold?.unitLabel || "克";

function fmt(n) {
  return Math.round(n || 0).toLocaleString();
}

function unix(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function usageLine(status) {
  const lock = status.locked > 0 ? `（庫存 ${fmt(status.units)}＋定存鎖倉 ${fmt(status.locked)}）` : "";
  return (
    `・金庫上限　**${fmt(status.capacity)}** ${U()}\n` +
    `・目前存量　**${fmt(status.used)}** ${U()}${lock}\n` +
    `・超出　**${fmt(status.overUnits)}** ${U()}`
  );
}

function noticeContainer(status, deadline, sellPrice) {
  const estimate = status.overSellable * sellPrice;
  const c = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⚠️ 黃金金庫超出新容量上限\n` +
          `銀行的黃金金庫開始有**容量上限**了（容量隨信用評等擴充），你目前的存量超出上限。\n` +
          `-# 舊有的純金不會被沒收，給你 **${vaultGraceService.graceDays()} 天**自行處理。`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(usageLine(status)))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**處理期限　<t:${unix(deadline)}:F>（<t:${unix(deadline)}:R>）**\n` +
          `期限內你可以：\n` +
          `・用 \`/銀行\` → 🪙 黃金存摺 **賣出**超出的部分\n` +
          `・**提升信用評等**擴充金庫容量（信用 S 最高 1,000 ${U()}）\n\n` +
          `期限到仍超出的話，超出的 **${fmt(status.overSellable)}** ${U()}會按當日賣出價**自動折現進錢包**（以目前賣出價 ${fmt(sellPrice)}/${U()} 估約 **+${fmt(estimate)}** 幣）。`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 金庫不是免稅保險庫：放不進金庫的財富會留在錢包，計入每週累進財富稅。定存鎖倉的克數一樣佔容量，鎖在定存的超額部分會在到期領回時自動折現。",
      ),
    );
  return c;
}

function remindContainer(status, deadline, sellPrice) {
  return new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⏳ 黃金金庫仍然超出上限\n處理期限 **<t:${unix(deadline)}:R>**（<t:${unix(deadline)}:F>）到期。`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(usageLine(status)))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `到期後超出的 **${fmt(status.overSellable)}** ${U()}會按當日賣出價自動折現進錢包（目前賣出價 ${fmt(sellPrice)}/${U()}）。\n` +
          `-# 用 \`/銀行\` → 🪙 黃金存摺 自己賣出，或提升信用評等擴充容量。`,
      ),
    );
}

function settledContainer(res) {
  const c = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💸 金庫超額部分已折現\n處理期限已到，超出容量的純金已按當日賣出價折現進你的錢包。`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `・折現　**${fmt(res.units)}** ${U()}（賣出價 ${fmt(res.prices.sell)}/${U()}）\n` +
          `・入帳　**+${fmt(res.gain)}** 幣\n` +
          `・金庫剩餘　**${fmt(res.holding)}** ${U()}／上限 ${fmt(res.status.capacity)} ${U()}`,
      ),
    );

  if (res.lockedOver > 0) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⏳ 另有 **${fmt(res.lockedOver)}** ${U()}鎖在黃金定存裡無法現在處理，會在定存到期領回時自動折現。`,
      ),
    );
  }

  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 這筆入帳在 `/我的金流紀錄` 顯示為「🪙 金庫滿溢折現」。留在錢包的逼幣會計入每週累進財富稅，想少繳就把它花掉或轉出去。",
    ),
  );
  return c;
}

async function dm(client, userId, container) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  return user
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .then(() => true)
    .catch(() => false);
}

async function sweepOnce(client) {
  if (!bank?.gold?.enabled) return;
  const prices = await goldService.getPrices();
  const dmEnabled = vaultGraceService.graceCfg().dmEnabled !== false;
  const tally = { notice: 0, remind: 0, liquidated: 0, failed: 0, dmFailed: 0 };

  await vaultGraceService.sweep(client, async (res) => {
    tally[res.action] = (tally[res.action] || 0) + 1;
    let container = null;
    if (res.action === "notice") container = noticeContainer(res.status, res.deadline, prices.sell);
    else if (res.action === "remind") container = remindContainer(res.status, res.deadline, prices.sell);
    else if (res.action === "liquidated") container = settledContainer(res);
    if (!container || !dmEnabled) return;
    const sent = await dm(client, res.entry.userId, container);
    if (!sent) tally.dmFailed += 1;
  });

  console.log(
    `[GOLD-CAP] 寬限期掃描完成：通知 ${tally.notice}、提醒 ${tally.remind}、折現 ${tally.liquidated}、失敗 ${tally.failed}（DM 失敗 ${tally.dmFailed}）`
      .cyan,
  );
}

module.exports = async (client) => {
  if (!bank?.gold?.enabled) return;
  const g = vaultGraceService.graceCfg();
  if (g.enabled === false) {
    console.log(`[GOLD-CAP] 金庫寬限期未啟用，跳過排程`.gray);
    return;
  }

  registerCron(client, {
    name: "gold.vaultGrace",
    label: "黃金金庫超額寬限期通知 / 折現",
    schedule: g.cronSchedule || "0 5 * * *",
    timezone: g.timezone || "Asia/Taipei",
    runner: () => sweepOnce(client),
  });

  // 啟動後補跑一次：上線當天就把通知發出去、開始倒數，不必等到隔天。
  setTimeout(() => {
    sweepOnce(client).catch((e) => console.log(`[GOLD-CAP] 啟動補跑失敗：${e.message}`.red));
  }, g.startupDelayMs ?? 60000);
};
