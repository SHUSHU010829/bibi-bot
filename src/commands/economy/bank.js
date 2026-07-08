require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, bank } = require("../../config");
const creditService = require("../../features/bank/creditService");
const goldService = require("../../features/bank/goldService");
const savingsService = require("../../features/bank/savingsService");
const loanService = require("../../features/bank/loanService");
const depositService = require("../../features/bank/depositService");
const { errorContainer, fmt } = require("../../features/bank/bankView");
const { ctxOf, renderTab, payload } = require("../../features/bank/bankHandlers");

function goldTermChoices() {
  return (bank?.gold?.term?.terms || []).map((t) => ({
    name: `${t.days} 天（到期 +${(t.rate * 100).toFixed(1)}%）`,
    value: t.days,
  }));
}

const DEPOSIT_TERMS = depositService.termChoices();
const GOLD_TERMS = goldTermChoices();

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("銀行")
    .setDescription("逼逼銀行：信用分、定存、活存、黃金存摺、貸款一站搞定 🏦")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("總覽").setDescription("錢包、信用分、定存、活存、黃金、貸款一次看"))
    .addSubcommand((s) => s.setName("信用").setDescription("查看信用評等與各項銀行權益"))
    .addSubcommandGroup((g) =>
      g
        .setName("定存")
        .setDescription("定期存款")
        .addSubcommand((s) =>
          s
            .setName("開戶")
            .setDescription("開一筆新的定期存款")
            .addIntegerOption((o) => o.setName("金額").setDescription("存款金額").setRequired(true).setMinValue(1))
            .addIntegerOption((o) =>
              o
                .setName("天數")
                .setDescription("存款期間")
                .setRequired(true)
                .addChoices(...(DEPOSIT_TERMS.length ? DEPOSIT_TERMS : [{ name: "7 天", value: 7 }])),
            ),
        )
        .addSubcommand((s) => s.setName("查詢").setDescription("查詢你所有定期存款"))
        .addSubcommand((s) =>
          s
            .setName("提款")
            .setDescription("領回定存（未到期扣違約金）")
            .addStringOption((o) => o.setName("存單").setDescription("存單 ID").setRequired(true)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("活存")
        .setDescription("活期存款")
        .addSubcommand((s) =>
          s
            .setName("存入")
            .setDescription("把錢包金幣存進活期")
            .addIntegerOption((o) => o.setName("金額").setDescription("存入金額").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("提領")
            .setDescription("從活期領回錢包")
            .addIntegerOption((o) => o.setName("金額").setDescription("提領金額").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) => s.setName("查詢").setDescription("查看活期餘額與利率")),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("黃金")
        .setDescription("黃金存摺（純金）")
        .addSubcommand((s) => s.setName("查詢").setDescription("金價、金庫與黃金定存"))
        .addSubcommand((s) =>
          s
            .setName("買進")
            .setDescription("用金幣買純金")
            .addIntegerOption((o) => o.setName("克數").setDescription("買進克數").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("賣出")
            .setDescription("把純金賣回銀行")
            .addIntegerOption((o) => o.setName("克數").setDescription("賣出克數").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("精煉")
            .setDescription("用黃金礦＋煤炭精煉成純金")
            .addIntegerOption((o) => o.setName("克數").setDescription("精煉出的純金克數").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("定存")
            .setDescription("把純金鎖倉到期領更多")
            .addIntegerOption((o) => o.setName("克數").setDescription("鎖倉克數").setRequired(true).setMinValue(1))
            .addIntegerOption((o) =>
              o
                .setName("天數")
                .setDescription("鎖倉期間")
                .setRequired(true)
                .addChoices(...(GOLD_TERMS.length ? GOLD_TERMS : [{ name: "7 天", value: 7 }])),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("提領")
            .setDescription("領回黃金定存")
            .addStringOption((o) => o.setName("存單").setDescription("黃金存單 ID").setRequired(true)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("貸款")
        .setDescription("向銀行借款")
        .addSubcommand((s) =>
          s
            .setName("借款")
            .setDescription("申請一筆貸款")
            .addIntegerOption((o) => o.setName("金額").setDescription("借款金額").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("還款")
            .setDescription("償還貸款（不填金額則全額還清）")
            .addIntegerOption((o) => o.setName("金額").setDescription("償還金額").setRequired(false).setMinValue(1)),
        )
        .addSubcommand((s) => s.setName("查詢").setDescription("查看你的貸款")),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) return interaction.editReply("🔧 金幣系統尚未啟動！");
      if (!client.userCoinsCollection) return interaction.editReply("🔧 銀行系統尚未啟動，請聯絡舒舒！");

      const ctx = ctxOf(interaction);
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      const showTab = (tab, note) =>
        renderTab(client, ctx, tab, note ? `✅ ${note}` : undefined).then((c) =>
          interaction.editReply(payload(c)),
        );
      const err = (opts) =>
        interaction.editReply({
          components: [errorContainer(opts)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });

      // ── 檢視類 ────────────────────────────────────────────────────────────
      if (!group && sub === "總覽") return showTab("overview");
      if (!group && sub === "信用") return showTab("credit");
      if (group === "定存" && sub === "查詢") return showTab("deposit");
      if (group === "活存" && sub === "查詢") return showTab("savings");
      if (group === "黃金" && sub === "查詢") return showTab("gold");
      if (group === "貸款" && sub === "查詢") return showTab("loan");

      // ── 定期存款 ──────────────────────────────────────────────────────────
      if (group === "定存") {
        if (!coinSystem?.deposit?.enabled) return err({ title: "🔧 定存尚未開放" });
        if (sub === "開戶") {
          const res = await depositService.open(client, {
            ...ctx,
            amount: interaction.options.getInteger("金額"),
            days: interaction.options.getInteger("天數"),
          });
          if (!res.ok) {
            if (res.reason === "range")
              return err({ title: "❌ 存款金額超出範圍", detail: `單筆需在 **${fmt(res.min)}** ~ **${fmt(res.max)}** 之間。` });
            if (res.reason === "term") return err({ title: "❌ 無此存款期間" });
            if (res.reason === "slots")
              return err({ title: "📈 定存已達上限", detail: `同時最多 **${res.maxActive}** 筆，目前已有 ${res.activeCount} 筆。`, hint: "提升信用分可加開更多定存" });
            if (res.reason === "balance")
              return err({ title: "💰 餘額不足", detail: `錢包只有 **${fmt(res.balance)}**。` });
            return err({ title: "🔧 開戶失敗，請稍後再試" });
          }
          const u = Math.floor(new Date(res.maturesAt).getTime() / 1000);
          return showTab(
            "deposit",
            `定存開立 \`${res.depositId}\`：本金 ${fmt(res.amount)}・${res.days} 天・到期領 **${fmt(res.amount + res.interest)}**（<t:${u}:R>）`,
          );
        }
        if (sub === "提款") {
          const res = await depositService.claim(client, { ...ctx, depositId: interaction.options.getString("存單").trim() });
          if (!res.ok) {
            if (res.reason === "notfound") return err({ title: "❌ 找不到此存單" });
            if (res.reason === "claimed") return err({ title: "❌ 此存單已領過或已關閉" });
            return err({ title: "🔧 提款失敗，請稍後再試" });
          }
          return showTab(
            "deposit",
            res.matured
              ? `已領回 \`${res.depositId}\`：本金 ${fmt(res.principal)} + 利息 ${fmt(res.interest)} = **${fmt(res.payout)}**`
              : `提早領回 \`${res.depositId}\`：扣違約金 ${fmt(res.penaltyAmount)}，實領 **${fmt(res.payout)}**`,
          );
        }
      }

      // ── 活期存款 ──────────────────────────────────────────────────────────
      if (group === "活存") {
        if (!bank?.savings?.enabled) return err({ title: "🔧 活期存款尚未開放" });
        if (sub === "存入") {
          const amount = interaction.options.getInteger("金額");
          const res = await savingsService.deposit(client, { ...ctx, amount });
          if (!res.ok) {
            if (res.reason === "min") return err({ title: "❌ 金額太小", detail: `活期單筆最少 **${fmt(res.minOp)}**。` });
            if (res.reason === "cap") return err({ title: "❌ 超過活期上限", detail: `上限 **${fmt(res.maxBalance)}**，目前 ${fmt(res.curBalance)}。` });
            if (res.reason === "wallet") return err({ title: "💰 餘額不足", detail: `錢包只有 **${fmt(res.wallet)}**。` });
            return err({ title: "🔧 存入失敗，請稍後再試" });
          }
          return showTab("savings", `已存入活期 **${fmt(res.amount)}**，活期餘額 ${fmt(res.balance)}`);
        }
        if (sub === "提領") {
          const amount = interaction.options.getInteger("金額");
          const res = await savingsService.withdraw(client, { ...ctx, amount });
          if (!res.ok) {
            if (res.reason === "balance") return err({ title: "❌ 活期餘額不足", detail: `活期只有 **${fmt(res.balance)}**。` });
            return err({ title: "🔧 提領失敗，請稍後再試" });
          }
          return showTab("savings", `已從活期領回 **${fmt(res.amount)}**，活期餘額 ${fmt(res.balance)}`);
        }
      }

      // ── 黃金存摺 ──────────────────────────────────────────────────────────
      if (group === "黃金") {
        if (!bank?.gold?.enabled) return err({ title: "🔧 黃金存摺尚未開放" });
        const uLabel = bank.gold.unitLabel || "克";
        if (sub === "買進") {
          const units = interaction.options.getInteger("克數");
          const res = await goldService.buy(client, { ...ctx, units });
          if (!res.ok) {
            if (res.reason === "range") return err({ title: "❌ 買進數量超出範圍", detail: `需在 **${fmt(res.min)}** ~ **${fmt(res.max)}** ${uLabel} 之間。` });
            if (res.reason === "balance") return err({ title: "💰 餘額不足", detail: `需要 **${fmt(res.cost)}**（買進價 ${fmt(res.prices.buy)}/${uLabel}），錢包只有 ${fmt(res.balance)}。` });
            return err({ title: "🔧 買進失敗，請稍後再試" });
          }
          return showTab("gold", `買進 **${fmt(res.units)}** ${uLabel}（共 ${fmt(res.cost)} 幣），金庫 ${fmt(res.holding)} ${uLabel}`);
        }
        if (sub === "賣出") {
          const units = interaction.options.getInteger("克數");
          const res = await goldService.sell(client, { ...ctx, units });
          if (!res.ok) {
            if (res.reason === "holding") return err({ title: "❌ 金庫黃金不足", detail: `你只有 **${fmt(res.holding)}** ${uLabel}。`, hint: "可用 /銀行 黃金 買進 或 精煉 累積" });
            if (res.reason === "min") return err({ title: "❌ 賣出數量太少", detail: `單次至少 **${fmt(res.min)}** ${uLabel}。` });
            return err({ title: "🔧 賣出失敗，請稍後再試" });
          }
          return showTab("gold", `賣出 **${fmt(res.units)}** ${uLabel}（+${fmt(res.gain)} 幣），金庫剩 ${fmt(res.holding)} ${uLabel}`);
        }
        if (sub === "精煉") {
          const units = interaction.options.getInteger("克數");
          const res = await goldService.refine(client, { ...ctx, units });
          if (!res.ok) {
            if (res.reason === "ore") return err({ title: "❌ 黃金礦不足", detail: `精煉 ${fmt(units)} ${uLabel} 需 **${fmt(res.needOre)}** 黃金礦，你只有 ${fmt(res.haveOre)}。`, hint: "去 /挖礦 挖黃金" });
            if (res.reason === "coal") return err({ title: "❌ 煤炭不足", detail: `精煉 ${fmt(units)} ${uLabel} 需 **${fmt(res.needCoal)}** 煤炭（燃料），你只有 ${fmt(res.haveCoal)}。`, hint: "去 /挖礦 挖煤炭" });
            if (res.reason === "max") return err({ title: "❌ 單次精煉過多", detail: `單次最多 **${fmt(res.maxBatch)}** ${uLabel}。` });
            return err({ title: "🔧 精煉失敗，請稍後再試" });
          }
          const coal = res.needCoal > 0 ? `＋${fmt(res.needCoal)} 煤炭` : "";
          return showTab("gold", `精煉：${fmt(res.needOre)} 黃金礦${coal} → +**${fmt(res.units)}** ${uLabel}，金庫 ${fmt(res.holding)} ${uLabel}`);
        }
        if (sub === "定存") {
          const units = interaction.options.getInteger("克數");
          const days = interaction.options.getInteger("天數");
          const res = await goldService.openTerm(client, { ...ctx, units, days });
          if (!res.ok) {
            if (res.reason === "min") return err({ title: "❌ 鎖倉數量太少", detail: `最少 **${fmt(res.minUnits)}** ${uLabel}。` });
            if (res.reason === "term") return err({ title: "❌ 無此定存期間" });
            if (res.reason === "slots") return err({ title: "📈 黃金定存已滿", detail: `最多 **${res.maxActive}** 筆，已有 ${res.active} 筆。` });
            if (res.reason === "holding") return err({ title: "❌ 金庫黃金不足", detail: `金庫只有 **${fmt(res.holding)}** ${uLabel}。` });
            return err({ title: "🔧 黃金定存失敗，請稍後再試" });
          }
          const u = Math.floor(new Date(res.maturesAt).getTime() / 1000);
          return showTab("gold", `黃金定存 \`${res.depositId}\`：${fmt(res.units)}${uLabel}・${res.days} 天・到期 **${fmt(res.units + res.interestUnits)}**${uLabel}（<t:${u}:R>）`);
        }
        if (sub === "提領") {
          const res = await goldService.claimTerm(client, { ...ctx, depositId: interaction.options.getString("存單").trim() });
          if (!res.ok) {
            if (res.reason === "notfound") return err({ title: "❌ 找不到此黃金存單" });
            if (res.reason === "claimed") return err({ title: "❌ 此存單已領過" });
            return err({ title: "🔧 提領失敗，請稍後再試" });
          }
          return showTab(
            "gold",
            res.matured
              ? `黃金定存到期：本金 ${fmt(res.units)} + 利息 ${fmt(res.interestUnits)} = **${fmt(res.payoutUnits)}** ${uLabel}`
              : `提早領回：扣違約金 ${fmt(res.penaltyUnits)} ${uLabel}，實領 **${fmt(res.payoutUnits)}** ${uLabel}`,
          );
        }
      }

      // ── 貸款 ──────────────────────────────────────────────────────────────
      if (group === "貸款") {
        if (!bank?.loan?.enabled) return err({ title: "🔧 貸款功能尚未開放" });
        if (sub === "借款") {
          const amount = interaction.options.getInteger("金額");
          const res = await loanService.take(client, { ...ctx, amount });
          if (!res.ok) {
            if (res.reason === "min") return err({ title: "❌ 借款金額太小", detail: `貸款最少 **${fmt(res.minAmount)}**。` });
            if (res.reason === "tier") {
              const nxt = res.next ? `\n下一級 ${res.next.emoji} ${res.next.name}（信用分 ${res.next.min}）起可貸款` : "";
              return err({ title: "🔒 尚未開放貸款", detail: `你目前 **${res.tier.emoji} ${res.tier.name}** 還沒有貸款額度。${nxt}`, hint: "完成轉帳、定存到期可累積信用分" });
            }
            if (res.reason === "cap") return err({ title: "❌ 超過信用額度", detail: `額度上限 **${fmt(res.loanCap)}**（${res.tier.emoji} ${res.tier.name}）。`, hint: "提升信用分可提高額度" });
            if (res.reason === "default_block") return err({ title: "🔴 你有違約貸款未清償", detail: "請先還清違約貸款才能再借。" });
            if (res.reason === "active") return err({ title: "❌ 已有貸款在身", detail: `同時最多 **${res.maxActive}** 筆，你已有 ${res.active} 筆。` });
            return err({ title: "🔧 借款失敗，請稍後再試" });
          }
          const u = Math.floor(new Date(res.dueAt).getTime() / 1000);
          return showTab("loan", `貸款核准 \`${res.loanId}\`：撥款 **${fmt(res.amount)}**（已入錢包），到期需還 **${fmt(res.dueAmount)}**（<t:${u}:R>）`);
        }
        if (sub === "還款") {
          const amount = interaction.options.getInteger("金額");
          const res = await loanService.repay(client, { ...ctx, amount });
          if (!res.ok) {
            if (res.reason === "notfound") return err({ title: "📭 沒有需要償還的貸款" });
            if (res.reason === "wallet") return err({ title: "💰 餘額不足", detail: `需要 **${fmt(res.outstanding)}**（可部分還款），錢包只有 ${fmt(res.wallet)}。`, hint: "可指定金額部分還款" });
            return err({ title: "🔧 還款失敗，請稍後再試" });
          }
          return showTab(
            "loan",
            res.cleared
              ? `貸款 \`${res.loan.loanId}\` 已全部還清！還款 ${fmt(res.pay)} 📈`
              : `已還款 **${fmt(res.pay)}**，尚欠 **${fmt(res.remaining)}**`,
          );
        }
      }

      return interaction.editReply("🔧 未知的銀行指令。");
    } catch (error) {
      console.log(`[ERROR] /銀行:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 銀行指令執行失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
