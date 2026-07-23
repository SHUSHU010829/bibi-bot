require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const buffResolver = require("./buffResolver");
const { getActiveFoodBuffs, describeFoodBuff } = require("../fishing/cookService");
const foodBag = require("../fishing/foodBag");
const { getOrCreate: getMiningProfile } = require("../mining/miningProfile");
const {
  resolveStamina,
  staminaMax,
  staminaBonus,
  staminaGuildBonus,
  getMemberClub,
} = require("../mining/dungeonService");
const { dungeon, theft } = require("../../config");
const swordBreakService = require("../dungeon/swordBreakService");
const theftProfile = require("../theft/theftProfile");
const theftService = require("../theft/theftService");
const { SECTIONS, buildSectionRow } = require("../playerStatus/statusNav");

function pct(mult) {
  return `${Math.round((mult - 1) * 100)}%`;
}

function addBlock(container, content) {
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

// 📊 總覽：體力 + 已套用的關鍵加成數字（玩家最常看的「我現在到底有多少」）
async function renderOverview(container, client, { userId, guildId, member }) {
  const [s, miningProfileForStamina, club] = await Promise.all([
    buffResolver.summary(client, userId, guildId, member),
    getMiningProfile(client, userId, guildId).catch(() => null),
    getMemberClub(client, userId, guildId).catch(() => null),
  ]);

  const cdMin = s.miningCdMs ? Math.round((s.miningCdMs / 60000) * 10) / 10 : null;
  const fishCdMin = s.fishingCdMs ? Math.round((s.fishingCdMs / 60000) * 10) / 10 : null;

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
  addBlock(container, staminaLines.join("\n"));

  const overviewLines = [
    `**⚔️ 攻擊力**：${s.atk}`,
    `**🍀 挖礦幸運**：+${Math.round(s.luckBonus * 100)}%`,
    `**⛏️ 挖礦數量**：+${s.qtyBonus}`,
  ];
  if (cdMin != null) overviewLines.push(`**⏱️ 挖礦冷卻**：${cdMin} 分鐘`);
  if (fishCdMin != null) overviewLines.push(`**🎣 釣魚冷卻**：${fishCdMin} 分鐘`);
  const passExpiresAt = miningProfileForStamina?.batch_pass_expires_at || 0;
  if (passExpiresAt > Date.now()) {
    overviewLines.push(
      `**🎟️ 連續通行證**：生效中（<t:${Math.floor(passExpiresAt / 1000)}:R> 到期）`,
    );
  }
  if (s.farmYieldBonus > 0)
    overviewLines.push(`**🌾 農場收成**：+${Math.round(s.farmYieldBonus * 100)}%`);
  overviewLines.push(`**📈 經驗加成**：${s.xpBoost > 1 ? `+${pct(s.xpBoost)}` : "無"}`);

  addBlock(
    container,
    `### 📊 加成總覽（已套用所有來源）\n${overviewLines.join("\n")}`,
  );
  addBlock(container, "-# 想知道這些數字從哪來？用上方選單切到「🔗 加成來源」");
}

// 🔗 加成來源：金幣 / 身分組 / 公會 / 活動 / 世界事件（持續型來源）
async function renderSources(container, client, { userId, guildId, member }) {
  const [s, roleGroups] = await Promise.all([
    buffResolver.summary(client, userId, guildId, member),
    buffResolver.roleBuffSummary(client, userId, guildId, member).catch(() => []),
  ]);

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
  addBlock(
    container,
    `### 🪙 金幣加成來源\n${
      incomeLines.length ? incomeLines.join("\n") : "-# 目前沒有金幣加成"
    }\n-# 多重來源會相乘，最終實際倍率以發放時為準`,
  );

  if (roleGroups.length > 0) {
    const roleText = roleGroups
      .map((g) => `${g.header}\n${g.lines.map((l) => `　${l}`).join("\n")}`)
      .join("\n");
    addBlock(container, `### 🎖️ 身分組來源\n${roleText}\n-# 失去身分組即失效`);
  }

  if (s.events && s.events.length > 0) {
    const eventLines = s.events.map((e) => {
      const bits = [];
      if (e.luck > 0) bits.push(`幸運 +${Math.round(e.luck * 100)}%`);
      if (e.qty > 0) bits.push(`數量 +${e.qty}`);
      return `• ${e.name}${bits.length ? `：${bits.join(" ・ ")}` : ""}`;
    });
    addBlock(container, `### 🎉 限時活動\n${eventLines.join("\n")}`);
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
      lines.push(`• 🐉 世界王攻擊力 +${Math.round(s.guildClub.bossAtkBonus * 100)}%`);
    if (s.guildClub.bossAttackLimitBonus > 0)
      lines.push(`• ⚔️ 世界王每場攻擊次數 +${s.guildClub.bossAttackLimitBonus}`);
    // 公會建築（礦坑 / 訓練場 / 倉庫擴建）buff
    if (s.guildClub.miningCooldownPct > 0)
      lines.push(`• ⏱️ 挖礦冷卻 -${s.guildClub.miningCooldownPct}%（礦坑）`);
    if (s.guildClub.fishingCooldownPct > 0)
      lines.push(`• 🎣 釣魚冷卻 -${s.guildClub.fishingCooldownPct}%（漁港）`);
    if (s.guildClub.dungeonDamagePct > 0)
      lines.push(`• ⚔️ 地下城傷害 +${s.guildClub.dungeonDamagePct}%（訓練場）`);
    if (s.guildClub.critRatePct > 0)
      lines.push(`• 💥 暴擊率 +${s.guildClub.critRatePct}%（訓練場）`);
    if (s.guildClub.bossDamagePct > 0)
      lines.push(`• 🐲 世界王傷害 +${s.guildClub.bossDamagePct}%（訓練場）`);
    if (s.guildClub.warehouseCapacityBonus > 0)
      lines.push(`• 📦 公會倉庫容量 +${s.guildClub.warehouseCapacityBonus}（倉庫擴建）`);
    // 公會建築（農膳坊）buff
    if (s.guildClub.farmGrowthReductionPct > 0)
      lines.push(`• 🌱 作物成熟 -${s.guildClub.farmGrowthReductionPct}%（農膳坊）`);
    if (s.guildClub.harvestCoinPct > 0)
      lines.push(`• 💰 收成金幣 +${s.guildClub.harvestCoinPct}%（農膳坊）`);
    if (s.guildClub.cookingCritPct > 0)
      lines.push(`• ✨ 烹飪美味暴擊 +${s.guildClub.cookingCritPct}%（農膳坊）`);
    if (s.guildClub.farmLowTierExtraCount > 0)
      lines.push(
        `• 🥕 紅蘿蔔/玉米收成 +${s.guildClub.farmLowTierExtraCount} 個（農膳坊）`
      );
    // 公會建築（鐵匠鋪）buff
    if (s.guildClub.weaponMaxDurabilityPct > 0)
      lines.push(`• 🗡️ 武器耐久上限 +${s.guildClub.weaponMaxDurabilityPct}%（鐵匠鋪）`);
    if (s.guildClub.equipmentRepairDiscountPct > 0)
      lines.push(
        `• 🔧 裝備修復材料 -${s.guildClub.equipmentRepairDiscountPct}%（鐵匠鋪，武器/鎬/釣竿）`
      );
    if (s.guildClub.combatDurabilitySavePct > 0)
      lines.push(
        `• 🛡️ 戰鬥耐久節省 ${s.guildClub.combatDurabilitySavePct}%（鐵匠鋪，武器/盾）`
      );
    if (lines.length === 0) lines.push(`-# 公會升到 Lv.2 起逐步解鎖共享 buff`);

    // 公會宴會（時效）
    const banquet = s.guildClub.activeBanquet;
    if (banquet && banquet.expires_at > Date.now()) {
      const { guildBanquet } = require("../../config");
      const menu = guildBanquet?.menus?.[banquet.menu_id];
      const { formatBuff } = require("./buffLabels");
      const buffStr = (banquet.buffs || [])
        .map((b) => formatBuff(b.type, b.value))
        .join("・");
      lines.push(
        `• 🍽️ 公會宴會「${menu?.emoji || ""}${menu?.name || banquet.menu_id}」：${buffStr}（<t:${Math.floor(banquet.expires_at / 1000)}:R>）`
      );
    }

    addBlock(
      container,
      `### 🏰 公會「${s.guildClub.name}」(Lv.${s.guildClub.level})\n${lines.join("\n")}`,
    );
  }

  if (s.worldEvents && s.worldEvents.length > 0) {
    const lines = s.worldEvents.map((e) => {
      const left = e.ends_at ? `<t:${Math.floor(new Date(e.ends_at).getTime() / 1000)}:R>` : "";
      const buffLines = Object.entries(e.buffs || {}).map(([k, v]) => {
        const { formatBuff } = require("./buffLabels");
        return formatBuff(k, v);
      }).join("・");
      return `• ${e.label || e.event_id} 結束 ${left}\n  -# ${buffLines}`;
    });
    addBlock(container, `### 🌍 世界事件（全服）\n${lines.join("\n")}`);
  }

  addBlock(
    container,
    "-# 加成來源：鎬子 / 幸運藥水 / Twitch 訂閱 / 伺服器加成 / 抖內 / 商店 buff / 限時活動 / 食物 / 公會",
  );
}

// ⏳ 時效狀態：食物 buff / 食物倉庫 / 消耗型道具 / 防身盜賊（會到期或會用完的東西）
async function renderTimed(container, client, { userId, guildId }) {
  const miningProfileForStamina = await getMiningProfile(client, userId, guildId).catch(() => null);
  let shown = false;

  try {
    if (miningProfileForStamina) {
      const foodBuffs = getActiveFoodBuffs(miningProfileForStamina);
      if (foodBuffs.length > 0) {
        const foodLines = foodBuffs.map((b) => {
          const { emoji, name, desc, expire } = describeFoodBuff(b);
          return `• ${emoji} **${name}**：${desc}${expire}`;
        });
        addBlock(container, `### 🍽️ 食物 Buff（生效中）\n${foodLines.join("\n")}`);
        shown = true;
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
        addBlock(container, lines.join("\n"));
        shown = true;
      }
    }
  } catch { /* noop */ }

  // 亡靈制（斷劍王加成）：生效中才顯示，效期一過自動失效（compute-on-read）
  if (miningProfileForStamina && swordBreakService.isUndeadActive(miningProfileForStamina)) {
    const u = dungeon?.undead || {};
    const exp = miningProfileForStamina.active_undead_buff?.expires_at;
    const lines = [
      `☠️ **亡靈制（斷劍王）生效中**${exp ? `：<t:${Math.floor(exp / 1000)}:R> 到期` : ""}`,
      `• ⚔️ 地下城傷害 +${u.atkPct || 0}%`,
      `• 🛡️ 武器耐久節省 +${u.durabilitySavePct || 0}%`,
      `• 👻 亡靈軍團事件（地下城勝利時有機率額外掉傳說碎片）`,
      "-# 把 🔥 傳說之劍 砍斷最多次即可在雙週結算奪下亡靈王座",
    ];
    addBlock(container, lines.join("\n"));
    shown = true;
  }

  // 撈網 / 高級陷阱 buff 剩餘次數（消耗品庫存與碎片數放在 /背包，避免重複）
  if (miningProfileForStamina) {
    const netUses = miningProfileForStamina.fishing_net_uses || 0;
    const trapUses = miningProfileForStamina.advanced_trap_uses || 0;
    if (netUses > 0 || trapUses > 0) {
      const lines = [];
      if (netUses > 0) lines.push(`🕸️ **撈網生效中**：剩 **${netUses}** 次（+10% 釣魚成功率）`);
      if (trapUses > 0) lines.push(`🪤 **高級陷阱保護中**：剩 **${trapUses}** 次（自動抵擋農場 raid）`);
      lines.push("-# 道具庫存、碎片數量請看 `/背包`");
      addBlock(container, lines.join("\n"));
      shown = true;
    }
  }

  // 盜賊 / 防身狀態（惡名、通緝、防身道具）：有任一相關狀態才顯示
  if (theft?.enabled && client.theftProfilesCollection) {
    const [tp, wanted] = await Promise.all([
      theftProfile.getOrCreate(client, userId, guildId).catch(() => null),
      theftService.activeWanted(client, userId, guildId).catch(() => null),
    ]);
    if (tp) {
      const lines = [];
      const noto = tp.notoriety_effective || 0;
      const watchdog = tp.watchdog_count || 0;
      const cloak = tp.night_cloak_count || 0;
      const safeboxActive = theftProfile.safeboxActive(tp);

      if (wanted) {
        const e = Math.floor(new Date(wanted.expires_at).getTime() / 1000);
        lines.push(`🚨 **通緝中**：賞金 **${wanted.bounty.toLocaleString()}** 🪙，<t:${e}:R> 到期`);
      }
      if (noto > 0) lines.push(`🥷 **惡名**：${noto}`);
      if (safeboxActive) {
        const e = Math.floor((tp.safebox_expires_at || 0) / 1000);
        lines.push(`🔒 **保險箱生效中**：被偷成功率 −20%，<t:${e}:R> 到期`);
      }
      if (watchdog > 0) lines.push(`🐕 **看門狗**：${watchdog} 隻（各擋一次偷竊）`);
      if (cloak > 0) lines.push(`🕶️ **夜行衣**：${cloak} 件（各 +15% 偷竊成功率）`);

      if (lines.length) {
        lines.push("-# 防身道具在 `/商店 → 防身道具` 購買");
        addBlock(container, lines.join("\n"));
        shown = true;
      }
    }
  }

  if (!shown) {
    addBlock(
      container,
      "### ⏳ 時效狀態\n-# 目前沒有生效中的食物 buff、消耗道具或防身狀態\n-# 煮魚 → 食物 buff；`/商店` 可買撈網、陷阱、防身道具",
    );
  }
}

async function buildStatusView(client, { userId, guildId, member, displayName, section }) {
  const sec = SECTIONS.some((x) => x.id === section) ? section : "overview";

  const container = new ContainerBuilder()
    .setAccentColor(0x1abc9c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ✨ ${displayName} 的狀態總覽`),
    );
  container.addActionRowComponents(buildSectionRow(userId, sec));

  if (sec === "overview") {
    await renderOverview(container, client, { userId, guildId, member });
  } else if (sec === "sources") {
    await renderSources(container, client, { userId, guildId, member });
  } else {
    await renderTimed(container, client, { userId, guildId });
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

module.exports = { buildStatusView };
