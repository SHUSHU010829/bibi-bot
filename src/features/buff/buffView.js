require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const buffResolver = require("./buffResolver");
const { getActiveFoodBuffs } = require("../fishing/cookService");
const foodBag = require("../fishing/foodBag");
const { getOrCreate: getMiningProfile } = require("../mining/miningProfile");
const {
  resolveStamina,
  staminaMax,
  staminaBonus,
  staminaGuildBonus,
  getMemberClub,
} = require("../mining/dungeonService");
const { fishing, dungeon } = require("../../config");

function pct(mult) {
  return `${Math.round((mult - 1) * 100)}%`;
}

async function buildStatusView(client, { userId, guildId, member, displayName }) {
  const [s, roleGroups] = await Promise.all([
    buffResolver.summary(client, userId, guildId, member),
    buffResolver.roleBuffSummary(client, userId, guildId, member).catch(() => []),
  ]);

  const cdMin = s.miningCdMs ? Math.round((s.miningCdMs / 60000) * 10) / 10 : null;

  const miningProfileForStamina = await getMiningProfile(client, userId, guildId).catch(() => null);
  const club = await getMemberClub(client, userId, guildId).catch(() => null);
  const sMax = staminaMax(member, club);
  const sBonus = staminaBonus(member);
  const sGuild = staminaGuildBonus(club);
  const sBase = sMax - sBonus - sGuild;
  const st = resolveStamina(miningProfileForStamina || {}, sMax);
  const bonusParts = [];
  if (sBonus > 0) bonusParts.push(`Twitch +${sBonus}`);
  if (sGuild > 0) bonusParts.push(`公會 +${sGuild}`);
  const bonusTag = bonusParts.length ? `（${sBase} + ${bonusParts.join(" + ")}）` : "";
  const staminaLines = [`**🔋 體力**：${st.stamina}/${sMax}${bonusTag}`];
  if (st.nextRegenAt) {
    const regenMs = dungeon?.staminaRegenMs ?? 3600000;
    const fullAt = st.updatedAt + (sMax - st.stamina) * regenMs;
    staminaLines.push(
      `-# 下一點 <t:${Math.floor(st.nextRegenAt / 1000)}:R>・回滿 <t:${Math.floor(fullAt / 1000)}:R>`,
    );
  } else {
    staminaLines.push("-# 體力已滿，隨時可進地下城");
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x1abc9c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ✨ ${displayName} 的狀態總覽`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(staminaLines.join("\n")));

  const overviewLines = [
    `**⚔️ 攻擊力**：${s.atk}`,
    `**🍀 挖礦幸運**：+${Math.round(s.luckBonus * 100)}%`,
    `**⛏️ 挖礦數量**：+${s.qtyBonus}`,
  ];
  if (cdMin != null) overviewLines.push(`**⏱️ 挖礦冷卻**：${cdMin} 分鐘`);
  if (s.farmYieldBonus > 0)
    overviewLines.push(`**🌾 農場收成**：+${Math.round(s.farmYieldBonus * 100)}%`);
  overviewLines.push(`**📈 經驗加成**：${s.xpBoost > 1 ? `+${pct(s.xpBoost)}` : "無"}`);

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 📊 加成總覽（已套用所有來源）\n${overviewLines.join("\n")}`,
      ),
    );

  const incomeLines = [];
  if (s.income.twitch?.multiplier > 1) {
    incomeLines.push(`• ${s.income.twitch.name || "Twitch 訂閱"}：×${s.income.twitch.multiplier}`);
  }
  if (s.income.serverBoost?.multiplier > 1) {
    incomeLines.push(
      `• ${s.income.serverBoost.name || "伺服器加成"}：×${s.income.serverBoost.multiplier}`,
    );
  }
  if (s.income.coinBoost > 1) {
    incomeLines.push(`• 商店金幣 buff：×${s.income.coinBoost}`);
  }
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🪙 金幣加成來源\n${
          incomeLines.length ? incomeLines.join("\n") : "-# 目前沒有金幣加成"
        }\n-# 多重來源會相乘，最終實際倍率以發放時為準`,
      ),
    );

  if (roleGroups.length > 0) {
    const roleText = roleGroups
      .map((g) => `${g.header}\n${g.lines.map((l) => `　${l}`).join("\n")}`)
      .join("\n");
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🎖️ 身分組來源\n${roleText}\n-# 失去身分組即失效`,
        ),
      );
  }

  if (s.events && s.events.length > 0) {
    const eventLines = s.events.map((e) => {
      const bits = [];
      if (e.luck > 0) bits.push(`幸運 +${Math.round(e.luck * 100)}%`);
      if (e.qty > 0) bits.push(`數量 +${e.qty}`);
      return `• ${e.name}${bits.length ? `：${bits.join(" ・ ")}` : ""}`;
    });
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### 🎉 限時活動\n${eventLines.join("\n")}`),
      );
  }

  if (s.guildClub) {
    const lines = [];
    if (s.guildClub.miningQtyBonus > 0) lines.push(`• ⛏️ 挖礦數量 +${s.guildClub.miningQtyBonus}`);
    if (s.guildClub.miningLuckBonus > 0)
      lines.push(`• 🍀 挖礦幸運 +${Math.round(s.guildClub.miningLuckBonus * 100)}%`);
    if (s.guildClub.workIncomeBonus > 0)
      lines.push(`• 💼 打工收入 +${Math.round(s.guildClub.workIncomeBonus * 100)}%`);
    if (s.guildClub.dungeonStaminaMax > 0)
      lines.push(`• 🔋 地下城體力上限 +${s.guildClub.dungeonStaminaMax}`);
    if (s.guildClub.bossAtkBonus > 0)
      lines.push(`• 🐉 BOSS 戰攻擊力 +${Math.round(s.guildClub.bossAtkBonus * 100)}%`);
    if (s.guildClub.bossAttackLimitBonus > 0)
      lines.push(`• ⚔️ BOSS 戰每場攻擊次數 +${s.guildClub.bossAttackLimitBonus}`);
    if (lines.length === 0) lines.push(`-# 公會升到 Lv.2 起逐步解鎖共享 buff`);
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🏰 公會「${s.guildClub.name}」(Lv.${s.guildClub.level})\n${lines.join("\n")}`,
        ),
      );
  }

  try {
    if (miningProfileForStamina) {
      const foodBuffs = getActiveFoodBuffs(miningProfileForStamina);
      if (foodBuffs.length > 0) {
        const recipes = fishing?.recipes || {};
        const foodLines = foodBuffs.map((b) => {
          const recipe =
            (b.recipeId && recipes[b.recipeId]) ||
            Object.values(recipes).find(
              (r) => r.buff?.type === b.type || r.coalBuff?.type === b.type,
            );
          const name = recipe?.name || b.type;
          const emoji = recipe?.emoji || "🍽️";
          let desc = "";
          if (b.type === "work_income") desc = `打工收入 +${Math.round(b.value * 100)}%`;
          else if (b.type === "dungeon_atk") desc = `地下城 ATK +${b.value}`;
          else if (b.type === "mine_luck") desc = `挖礦幸運 +${Math.round(b.value * 100)}%`;
          else if (b.type === "all_boost") desc = `全屬性 +${Math.round(b.value * 100)}%`;
          else if (b.type === "fish_fortune")
            desc = `釣魚成功率 +${Math.round(b.value * 100)}% ・ 稀有度提升`;
          else if (b.type === "farm_yield") desc = `農場收成 +${Math.round(b.value * 100)}%`;
          else desc = `${b.type}`;
          let expire = "";
          if (b.uses_left !== null && b.uses_left !== undefined) {
            expire = `（剩餘 ${b.uses_left} 次）`;
          } else if (b.expires_at) {
            expire = `（<t:${Math.floor(b.expires_at / 1000)}:R>）`;
          }
          return `• ${emoji} **${name}**：${desc}${expire}`;
        });
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `### 🍽️ 食物 Buff（生效中）\n${foodLines.join("\n")}`,
            ),
          );
      }
    }
  } catch { /* noop */ }

  try {
    if (miningProfileForStamina) {
      const stockpile = foodBag.listFresh(miningProfileForStamina);
      if (stockpile.length > 0) {
        const avgFresh = stockpile.reduce((acc, it) => acc + it.freshness, 0) / stockpile.length;
        const minFresh = Math.min(...stockpile.map((it) => it.freshness));
        const urgent = stockpile.filter((it) => it.freshness < 0.2).length;
        const lines = [
          `**🥡 食物倉庫**：${stockpile.length} 份（平均新鮮度 ${Math.round(avgFresh * 100)}%）`,
        ];
        if (urgent > 0) {
          lines.push(
            `-# 🔴 有 ${urgent} 份快壞了（最低 ${Math.round(minFresh * 100)}%），記得快點吃`,
          );
        } else {
          lines.push(`-# 點下方「魚袋」按鈕查看與食用`);
        }
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
      }
    }
  } catch { /* noop */ }

  // 撈網 / 高級陷阱 buff 剩餘次數（消耗品庫存與碎片數放在 /背包，避免重複）
  if (miningProfileForStamina) {
    const netUses = miningProfileForStamina.fishing_net_uses || 0;
    const trapUses = miningProfileForStamina.advanced_trap_uses || 0;
    if (netUses > 0 || trapUses > 0) {
      const lines = [];
      if (netUses > 0) lines.push(`🕸️ **撈網生效中**：剩 **${netUses}** 次（+10% 釣魚成功率）`);
      if (trapUses > 0) lines.push(`🪤 **高級陷阱保護中**：剩 **${trapUses}** 次（自動抵擋農場 raid）`);
      lines.push("-# 道具庫存、碎片數量請看 `/背包`");
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
    }
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 加成來源：鎬子 / 幸運藥水 / Twitch 訂閱 / 伺服器加成 / 抖內 / 商店 buff / 限時活動 / 食物 / 公會",
      ),
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

module.exports = { buildStatusView };
