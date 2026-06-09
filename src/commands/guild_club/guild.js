require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { guildClub, guildWarehouse } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const guildClubService = require("../../features/guild_club/guildClubService");
const guildClubMembership = require("../../features/guild_club/guildClubMembership");
const guildClubQuest = require("../../features/guild_club/guildClubQuest");
const guildClubView = require("../../features/guild_club/guildClubView");
const guildClubAnnouncer = require("../../features/guild_club/guildClubAnnouncer");
const guildClubDm = require("../../features/guild_club/guildClubDm");
const guildClubContribution = require("../../features/guild_club/guildClubContribution");
const warehouseService = require("../../features/guild_club/warehouse/warehouseService");
const warehouseView = require("../../features/guild_club/warehouse/warehouseView");
const warehouseSettings = require("../../features/guild_club/warehouse/warehouseSettings");
const warehouseEligibility = require("../../features/guild_club/warehouse/warehouseEligibility");
const guildWarehouseListingService = require("../../features/guild_club/warehouse/guildWarehouseListingService");

// 公會指令類別白名單。Thread 走 parent channel 的 parentId（祖父類別）。
// 空 / 未設定 → 不限制。
function isChannelInAllowedCategory(channel) {
  const ids = guildClub?.allowedCategoryIds || [];
  if (ids.length === 0) return true;
  if (!channel) return false;
  const categoryId = channel.isThread?.()
    ? channel.parent?.parentId
    : channel.parentId;
  return !!categoryId && ids.includes(categoryId);
}

const SUB_CREATE = "建立";
const SUB_INFO = "資訊";
const SUB_INVITE = "邀請";
const SUB_APPLY = "申請";
const SUB_LEAVE = "退會";
const SUB_DONATE = "捐款";
const SUB_QUEST = "任務";
const SUB_RANK = "排行";
const SUB_WAREHOUSE = "倉庫";
const SUB_DEPOSIT = "存入";
const SUB_WITHDRAW = "領取";
const SUB_CONSIGN = "寄售";

// 解散 / 踢人 / 轉讓 / 指派副會長 / 撤銷副會長 已合併到 /公會 資訊 的「⚙️ 公會管理」按鈕區。

module.exports = {
  // /公會 自己會檢查 allowedCategoryIds，跳過全域桶分流以免兩層互打。
  skipChannelGuard: true,
  data: new SlashCommandBuilder()
    .setName("公會")
    .setDescription("公會系統 🏰")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName(SUB_CREATE)
        .setDescription(`建立公會（花費 ${guildClub?.createCost || 5000} 幣）`)
        .addStringOption((opt) =>
          opt
            .setName("名稱")
            .setDescription(
              `公會名稱（${guildClub?.name?.minLength || 1}–${guildClub?.name?.maxLength || 12} 字）`
            )
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_INFO)
        .setDescription("查看公會詳情（不填名稱＝查自己的公會）")
        .addStringOption((opt) =>
          opt
            .setName("名稱")
            .setDescription("公會名稱（不填則查你目前所屬的公會）")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_INVITE)
        .setDescription("邀請玩家加入公會（僅會長）")
        .addUserOption((opt) =>
          opt.setName("使用者").setDescription("要邀請的玩家").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_APPLY)
        .setDescription("申請加入指定公會（會長批准後生效）")
        .addStringOption((opt) =>
          opt.setName("名稱").setDescription("公會名稱").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("理由")
            .setDescription(
              `想跟會長說的話（最多 ${guildClub?.application?.messageMaxLength || 100} 字，可省略）`
            )
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_LEAVE).setDescription("退出目前所屬公會")
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_DONATE)
        .setDescription("捐款進公會金庫")
        .addIntegerOption((opt) =>
          opt
            .setName("金額")
            .setDescription("要捐多少幣（正整數）")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_QUEST).setDescription("查看本週公會任務進度（達標後上方有領取按鈕）")
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_RANK).setDescription("查看伺服器公會排行榜")
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_WAREHOUSE).setDescription("查看公會倉庫存貨與今日領取額度")
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_DEPOSIT)
        .setDescription("把背包 / 魚袋的資源捐入公會倉庫（不可收回）")
        .addStringOption((opt) =>
          opt
            .setName("物品")
            .setDescription("要存入的物品")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("數量")
            .setDescription("要存入的數量（正整數）")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_WITHDRAW)
        .setDescription("快捷指令：從公會倉庫領取資源（或直接用 /公會 倉庫 點按鈕）")
        .addStringOption((opt) =>
          opt
            .setName("物品")
            .setDescription("要領取的物品")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("數量")
            .setDescription("要領取的數量（受單次上限限制）")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_CONSIGN)
        .setDescription("會長 / 副會長把倉庫物資上架到市集（成交金額全額進公會金庫）")
        .addStringOption((opt) =>
          opt
            .setName("物品")
            .setDescription("要寄售的物品")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("數量")
            .setDescription("寄售數量（正整數）")
            .setRequired(true)
            .setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("售價")
            .setDescription("總售價（一口價，正整數）")
            .setRequired(true)
            .setMinValue(1)
        )
    ),

  autocomplete: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub !== SUB_DEPOSIT && sub !== SUB_WITHDRAW && sub !== SUB_CONSIGN) return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "物品") return;
    const term = (focused.value || "").toLowerCase();

    // 寄售只顯示目前倉庫有 available_qty 的物品
    let availableMap = null;
    if (sub === SUB_CONSIGN) {
      const membership = await guildClubService
        .getMembership(client, interaction.user.id, interaction.guildId)
        .catch(() => null);
      if (membership) {
        const inv = await warehouseService
          .getInventory(client, membership.guild_club_id)
          .catch(() => []);
        availableMap = {};
        for (const it of inv) availableMap[it.item_id] = it.available_qty || 0;
      }
    }

    const choices = warehouseSettings
      .allItemIds()
      .map((id) => ({ id, def: warehouseSettings.itemDef(id) }))
      .filter(({ id, def }) => {
        if (term && !id.includes(term) && !def.name.toLowerCase().includes(term))
          return false;
        if (availableMap && (availableMap[id] || 0) <= 0) return false;
        return true;
      })
      .slice(0, 25)
      .map(({ id, def }) => {
        const avail = availableMap ? `（可寄售 ${availableMap[id]}）` : "";
        return { name: `${def.name}${avail}`, value: id };
      });
    await interaction.respond(choices).catch(() => {});
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();

    if (!guildClub?.enabled) {
      return interaction.reply({
        components: [
          guildClubView.buildErrorContainer({
            title: "🔧 公會系統未啟用",
            body: "目前無法使用公會功能。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    if (!isChannelInAllowedCategory(interaction.channel)) {
      const ids = guildClub?.allowedCategoryIds || [];
      const links = ids.map((id) => `<#${id}>`).join("、");
      return interaction.reply({
        components: [
          guildClubView.buildErrorContainer({
            title: "🔒 此頻道不能使用公會指令",
            body: `請至 ${links} 類別下的頻道使用 /公會。`,
            hint: "此限制適用於所有 /公會 subcommand。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    try {
      if (sub === SUB_CREATE) return runCreate(client, interaction);
      if (sub === SUB_INFO) return runInfo(client, interaction);
      if (sub === SUB_INVITE) return runInvite(client, interaction);
      if (sub === SUB_APPLY) return runApply(client, interaction);
      if (sub === SUB_LEAVE) return runLeave(client, interaction);
      if (sub === SUB_DONATE) return runDonate(client, interaction);
      if (sub === SUB_QUEST) return runQuest(client, interaction);
      if (sub === SUB_RANK) return runRank(client, interaction);
      if (sub === SUB_WAREHOUSE) return runWarehouse(client, interaction);
      if (sub === SUB_DEPOSIT) return runDeposit(client, interaction);
      if (sub === SUB_WITHDRAW) return runWithdraw(client, interaction);
      if (sub === SUB_CONSIGN) return runConsign(client, interaction);
    } catch (e) {
      console.log(`[GUILD_CLUB] /公會 ${sub} 失敗：${e.stack || e.message}`.red);
      const reply = {
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 操作失敗",
            body: "出了點狀況，請稍後再試。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};

function createErrorView(result) {
  const { reason } = result;
  if (reason === "name_too_short") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱太短",
      body: `公會名稱至少要 ${result.min} 個字。`,
    });
  }
  if (reason === "name_too_long") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱太長",
      body: `公會名稱最多 ${result.max} 個字。`,
    });
  }
  if (reason === "name_forbidden_char") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱含禁字",
      body: `名稱不能包含「${result.char}」。`,
      hint: `禁字清單：${result.all.join("・")}`,
    });
  }
  if (reason === "name_taken") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱已被使用",
      body: "本伺服器已有同名公會，請換一個名字。",
    });
  }
  if (reason === "already_in_club") {
    return guildClubView.buildErrorContainer({
      title: "❌ 你已在公會中",
      body: "每人在同一伺服器只能加入一個公會。",
      hint: "若想另立門戶，先 /公會 退會 或 /公會 解散。",
    });
  }
  if (reason === "insufficient_funds") {
    return guildClubView.buildErrorContainer({
      title: "❌ 餘額不足",
      body: `建立公會需要 ${result.need.toLocaleString()} ${COIN_EMOJI}，你目前有 ${result.have.toLocaleString()} ${COIN_EMOJI}。`,
      hint: "再去打工、挖礦或賣礦累積一下吧。",
    });
  }
  if (reason === "recreate_cooldown") {
    return guildClubView.buildErrorContainer({
      title: "🧊 解散冷卻中，暫不能再建公會",
      body: `你最近才解散過公會，請在 <t:${Math.floor(result.readyAt / 1000)}:R> 後再嘗試。`,
      hint: "此冷卻是為了防止「拉人→解散→分錢」的洗錢循環。",
    });
  }
  return guildClubView.buildErrorContainer({
    title: "❌ 建立失敗",
    body: `原因：${reason}`,
  });
}

async function runCreate(client, interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString("名稱", true);

  const result = await guildClubService.create(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    name,
    member: interaction.member,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [createErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildCreateSuccessContainer({
        userId: interaction.user.id,
        club: result.club,
        cost: result.cost,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runInfo(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const queryName = interaction.options.getString("名稱");

  let club = null;
  if (queryName) {
    club = await guildClubService.getClubByName(
      client,
      interaction.guildId,
      queryName.trim()
    );
    if (!club) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 找不到公會",
            body: `本伺服器沒有名為「${queryName}」的公會。`,
            hint: "可用 /公會 排行 看看有哪些公會。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } else {
    const membership = await guildClubService.getMembership(
      client,
      interaction.user.id,
      interaction.guildId
    );
    if (!membership) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "🏰 你還沒加入公會",
            body: "可以等會長邀請、或用 /公會 申請 [名稱] 主動申請。",
            hint: "想自己當會長？/公會 建立 [名稱]（花費 5,000 幣）",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    club = await guildClubService.getClubById(client, membership.guild_club_id);
    if (!club) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 公會資料異常",
            body: "你所屬的公會已不存在，請聯絡管理員。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }

  const members = await guildClubService.listMembers(client, club.guild_club_id);
  const viewerMembership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  const isMember =
    !!viewerMembership && viewerMembership.guild_club_id === club.guild_club_id;
  const viewerRole = isMember ? viewerMembership.role : null;
  const isLeader = viewerRole === "leader";
  const bossContributions = await guildClubContribution
    .getWeeklyTop(client, club.guild_club_id, 5)
    .catch(() => []);

  let warehouseSummary = null;
  if (isMember && (club.level || 1) >= (guildWarehouse?.unlockLevel || 2)) {
    warehouseSummary = await warehouseService
      .getSummary(client, club.guild_club_id)
      .catch(() => null);
  }

  let pendingApplicationCount = 0;
  if (isLeader || viewerRole === "vice_leader") {
    pendingApplicationCount = await client.guildClubApplicationsCollection
      .countDocuments({ guild_club_id: club.guild_club_id, status: "pending" })
      .catch(() => 0);
  }

  return interaction.editReply({
    components: [
      guildClubView.buildInfoContainer({
        viewerId: interaction.user.id,
        club,
        members,
        isMember,
        isLeader,
        viewerRole,
        bossContributions,
        warehouseSummary,
        pendingApplicationCount,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 邀請 ─────────

async function runInvite(client, interaction) {
  await interaction.deferReply();
  const invitee = interaction.options.getUser("使用者", true);

  if (invitee.bot) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 不能邀請機器人",
          body: "請選擇真人玩家。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const result = await guildClubMembership.invite(client, {
    leaderId: interaction.user.id,
    guildId: interaction.guildId,
    inviteeId: invitee.id,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [inviteErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildInvitationContainer({
        inviterId: interaction.user.id,
        inviteeId: invitee.id,
        club: result.club,
        invitationId: result.invitation_id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [invitee.id] },
  });
}

// ───────── 申請 ─────────

async function runApply(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString("名稱", true);
  const message = interaction.options.getString("理由") || null;

  const result = await guildClubMembership.apply(client, {
    applicantId: interaction.user.id,
    guildId: interaction.guildId,
    clubName: name,
    message,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [applyErrorView(result, name)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [guildClubView.buildApplicationSentContainer({ club: result.club })],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 退會 ─────────

async function runLeave(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await guildClubMembership.leave(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [leaveErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  guildClubDm
    .notifyLeaverCooldown(client, {
      leaverId: interaction.user.id,
      guildId: interaction.guildId,
      clubName: result.club.name,
      rejoinReadyAt: result.rejoinReadyAt,
    })
    .catch(() => {});

  guildClubDm
    .notifyManagersOfLeave(client, {
      managerIds: result.managerIds || [],
      guildId: interaction.guildId,
      leaverId: interaction.user.id,
      clubName: result.club.name,
    })
    .catch(() => {});

  return interaction.editReply({
    components: [
      guildClubView.buildLeaveSuccessContainer({
        club: result.club,
        rejoinReadyAt: result.rejoinReadyAt,
      }),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

// ───────── 捐款 ─────────

async function runDonate(client, interaction) {
  await interaction.deferReply();
  const amount = interaction.options.getInteger("金額", true);

  const result = await guildClubService.donate(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    amount,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [donateErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  if (result.levelUp) {
    guildClubAnnouncer.announceLevelUp(client, result.levelUp).catch(() => {});
  }

  return interaction.editReply({
    components: [
      guildClubView.buildDonateSuccessContainer({
        userId: interaction.user.id,
        club: result.club,
        donated: result.donated,
        totalDonated: result.totalDonated,
        levelUp: result.levelUp,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 任務 ─────────

async function runQuest(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const status = await guildClubQuest.getQuestStatus(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  if (!status.ok) {
    return interaction.editReply({
      components: [questStatusErrorView(status)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildQuestListContainer({
        viewerId: interaction.user.id,
        club: status.club,
        period: status.period,
        items: status.items,
        isLeader: status.isLeader,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 排行 ─────────

async function runRank(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const clubs = await guildClubQuest.getLeaderboard(client, {
    guildId: interaction.guildId,
    limit: 10,
  });

  const myMembership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );

  return interaction.editReply({
    components: [
      guildClubView.buildLeaderboardContainer({
        viewerId: interaction.user.id,
        clubs,
        viewerClubId: myMembership?.guild_club_id || null,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// 編輯簡介 / 領獎 / 申請列表 / 解散 / 踢人 / 轉讓 / 副會長管理 已改為按鈕，集中在 /公會 資訊。

// ───────── 錯誤 view helpers ─────────

function questStatusErrorView(result) {
  if (result.reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "先加入公會才能查任務。",
    });
  if (result.reason === "club_missing")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會資料異常",
      body: "公會已不存在。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 查詢失敗",
    body: `原因：${result.reason}`,
  });
}

function donateErrorView(result) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "請先加入公會才能捐款。",
      hint: "/公會 申請 [名稱] 或等會長邀請。",
    });
  if (reason === "invalid_amount")
    return guildClubView.buildErrorContainer({
      title: "❌ 金額無效",
      body: "請輸入正整數。",
    });
  if (reason === "insufficient_funds")
    return guildClubView.buildErrorContainer({
      title: "❌ 餘額不足",
      body: `需要 ${result.need.toLocaleString()} ${COIN_EMOJI}，你目前有 ${result.have.toLocaleString()} ${COIN_EMOJI}。`,
      hint: "再去打工、挖礦或賣礦累積一下吧。",
    });
  if (reason === "club_missing")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已解散",
      body: "捐款已退回。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 捐款失敗",
    body: `原因：${reason}`,
  });
}

function inviteErrorView(result) {
  const { reason } = result;
  if (reason === "leader_not_in_club" || reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "請先 /公會 建立 一個公會。",
    });
  if (reason === "not_leader")
    return guildClubView.buildErrorContainer({
      title: "🚫 只有會長能邀請",
      body: "請會長使用此指令。",
    });
  if (reason === "cannot_invite_self")
    return guildClubView.buildErrorContainer({
      title: "❌ 不能邀請自己",
      body: "你已經是會長了。",
    });
  if (reason === "invitee_already_in_this_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方已在你的公會",
      body: "不需重複邀請。",
    });
  if (reason === "invitee_in_other_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方已屬其他公會",
      body: "請對方先退會再來。",
    });
  if (reason === "club_full")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已滿員",
      body: `目前 ${result.current}/${result.max}。`,
      hint: "升級公會可擴張人數上限。",
    });
  if (reason === "already_invited")
    return guildClubView.buildErrorContainer({
      title: "❌ 已有 pending 邀請",
      body: "請等對方先回覆上一張邀請。",
    });
  if (reason === "invitee_rejoin_cooldown")
    return guildClubView.buildErrorContainer({
      title: "🧊 對方仍在退會冷卻",
      body: `對方最近才${result.source === "kicked_from_club" ? "被踢出" : "退出"}公會，需等到 <t:${Math.floor(result.readyAt / 1000)}:R> 才能加入新公會。`,
      hint: "此冷卻防止短期換會洗錢。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 邀請失敗",
    body: `原因：${reason}`,
  });
}

function applyErrorView(result, name) {
  const { reason } = result;
  if (reason === "already_in_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 你已在公會中",
      body: "請先 /公會 退會 後再申請其他公會。",
    });
  if (reason === "club_not_found")
    return guildClubView.buildErrorContainer({
      title: "❌ 找不到公會",
      body: `本伺服器沒有「${name}」這個公會。`,
      hint: "可用 /公會 排行 看看有哪些公會。",
    });
  if (reason === "club_full")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已滿員",
      body: `目前 ${result.current}/${result.max}。`,
      hint: "等公會升級擴張人數，或挑別家。",
    });
  if (reason === "already_pending")
    return guildClubView.buildErrorContainer({
      title: "❌ 已有申請待審",
      body: "請等會長處理上一筆申請。",
    });
  if (reason === "rejected_cooldown") {
    const remainMs = Math.max(0, result.readyAt - Date.now());
    const remainMin = Math.ceil(remainMs / 60000);
    const remainHr = Math.floor(remainMin / 60);
    const remainTxt = remainHr >= 1 ? `${remainHr} 小時` : `${remainMin} 分鐘`;
    return guildClubView.buildErrorContainer({
      title: "❌ 冷卻中",
      body: `你最近被「${name}」拒絕過，請再等 ${remainTxt}。`,
    });
  }
  if (reason === "rejoin_cooldown") {
    return guildClubView.buildErrorContainer({
      title: "🧊 退會冷卻中，暫不能申請新公會",
      body: `你最近才${result.source === "kicked_from_club" ? "被踢出" : "退出"}公會，請在 <t:${Math.floor(result.readyAt / 1000)}:R> 後再申請。`,
      hint: "此冷卻防止短期換會洗錢。",
    });
  }
  return guildClubView.buildErrorContainer({
    title: "❌ 申請失敗",
    body: `原因：${reason}`,
  });
}

function leaveErrorView(result) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你不在任何公會",
      body: "沒有公會可退。",
    });
  if (reason === "leader_with_members")
    return guildClubView.buildErrorContainer({
      title: "👑 會長不能直接退會",
      body: `公會還有 ${result.memberCount - 1} 名其他成員。`,
      hint: "請先 /公會 轉讓 給其他成員，或 /公會 解散 公會。",
    });
  if (reason === "leader_must_disband")
    return guildClubView.buildErrorContainer({
      title: "👑 你是唯一的成員",
      body: "請使用 /公會 解散 結束公會。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 退會失敗",
    body: `原因：${reason}`,
  });
}

// ───────── 倉庫 ─────────

async function runWarehouse(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership) {
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🏰 你還沒加入公會",
          body: "倉庫是公會專屬功能。",
          hint: "可使用 /公會 建立 或 /公會 申請。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) {
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "❌ 公會資料異常",
          body: "公會已不存在。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  if ((club.level || 1) < (guildWarehouse?.unlockLevel || 2)) {
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🔒 公會倉庫尚未解鎖",
          body: `倉庫於 Lv.${guildWarehouse?.unlockLevel || 2} 解鎖。\n目前：Lv.${club.level || 1}`,
          hint: "多 /公會 捐款 或做 /公會 任務 升等。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const inventory = await warehouseService.getInventory(client, club.guild_club_id);
  const daily = await warehouseEligibility.getDailyDoc(
    client,
    interaction.user.id,
    interaction.guildId
  );
  const isManagerNow = guildClubService.isManager(membership.role);
  const flow = isManagerNow
    ? await warehouseService.getNetFlow(client, club.guild_club_id, 7)
    : null;

  return interaction.editReply({
    components: [
      warehouseView.buildWarehouseContainer({
        viewerId: interaction.user.id,
        club,
        inventory,
        isManager: isManagerNow,
        todayItemsTaken: daily?.items_taken || [],
        todayTimesUsed: daily?.times_used || 0,
        netFlow7d: flow?.net,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runDeposit(client, interaction) {
  await interaction.deferReply();
  const itemId = interaction.options.getString("物品", true);
  const qty = interaction.options.getInteger("數量", true);

  const result = await warehouseService.deposit(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    itemId,
    qty,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [depositErrorView(result, itemId)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  if (result.large_announce) {
    guildClubAnnouncer
      .announceLargeDeposit(client, {
        userId: interaction.user.id,
        club: result.club,
        itemDefArg: result.item,
        deposited: result.deposited,
        marketValueAmount: result.market_value,
      })
      .catch(() => {});
  }

  return interaction.editReply({
    components: [
      warehouseView.buildDepositSuccessContainer({
        userId: interaction.user.id,
        club: result.club,
        itemDefArg: result.item,
        deposited: result.deposited,
        newTotal: result.new_total,
        capacity: result.capacity,
        availableAt: result.available_at,
        marketValueAmount: result.market_value,
        contributionAdded: result.contribution_added,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runWithdraw(client, interaction) {
  await interaction.deferReply();
  const itemId = interaction.options.getString("物品", true);
  const qty = interaction.options.getInteger("數量", true);

  const result = await warehouseService.withdraw(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    itemId,
    qty,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [withdrawErrorView(result, itemId)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      warehouseView.buildWithdrawSuccessContainer({
        userId: interaction.user.id,
        club: result.club,
        itemDefArg: result.item,
        withdrawn: result.withdrawn,
        fee: result.fee,
        newTotal: result.new_total,
        dailyRemaining: result.daily_remaining,
        dailyMax: result.daily_max,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

function depositErrorView(result, itemId) {
  const name = warehouseSettings.itemDef(itemId)?.name || itemId;
  const { reason } = result;
  if (reason === "not_in_club")
    return warehouseView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "請先加入公會才能存入物資。",
    });
  if (reason === "club_missing")
    return warehouseView.buildErrorContainer({
      title: "❌ 公會資料異常",
      body: "公會已不存在。",
    });
  if (reason === "club_level_locked")
    return warehouseView.buildErrorContainer({
      title: "🔒 公會倉庫尚未解鎖",
      body: `倉庫於 Lv.${result.need} 解鎖。\n目前：Lv.${result.have}`,
      hint: "多 /公會 捐款 或做 /公會 任務 升等。",
    });
  if (reason === "unknown_item")
    return warehouseView.buildErrorContainer({
      title: "❌ 未知物品",
      body: `「${itemId}」不在倉庫支援清單。`,
      hint: "請從 autocomplete 選單挑選。",
    });
  if (reason === "invalid_qty")
    return warehouseView.buildErrorContainer({
      title: "❌ 數量無效",
      body: "請輸入正整數。",
    });
  if (reason === "not_enough_in_pack") {
    const where =
      result.kind === "fish_bag"
        ? "魚袋"
        : result.kind === "veggie_bag"
          ? "菜籃"
          : "背包";
    return warehouseView.buildErrorContainer({
      title: "❌ 庫存不足",
      body: `你的${where}只有 ${result.have} 個 ${name}，要存 ${result.need}。`,
      hint: "去挖礦 / 種田 / 釣魚補貨再來。",
    });
  }
  if (reason === "capacity_exceeded")
    return warehouseView.buildErrorContainer({
      title: "📦 倉庫已滿",
      body: `${name} 目前 ${result.have} / 上限 ${result.cap}，再加 ${result.add} 會爆。`,
      hint: "升級公會可擴張倉庫容量。",
    });
  if (reason === "race_lost_pack")
    return warehouseView.buildErrorContainer({
      title: "❌ 存入失敗",
      body: "剛剛背包/魚袋狀態變動了，請重試。",
    });
  if (reason === "warehouse_write_failed")
    return warehouseView.buildErrorContainer({
      title: "❌ 倉庫寫入失敗",
      body: "已退回背包資源，請稍後再試。",
    });
  return warehouseView.buildErrorContainer({
    title: "❌ 存入失敗",
    body: `原因：${reason}`,
  });
}

function withdrawErrorView(result, itemId) {
  const name = warehouseSettings.itemDef(itemId)?.name || itemId;
  const { reason } = result;
  if (reason === "not_in_club")
    return warehouseView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "請先加入公會才能領取物資。",
    });
  if (reason === "club_missing")
    return warehouseView.buildErrorContainer({
      title: "❌ 公會資料異常",
      body: "公會已不存在。",
    });
  if (reason === "club_level_locked")
    return warehouseView.buildErrorContainer({
      title: "🔒 公會倉庫尚未解鎖",
      body: `倉庫於 Lv.${result.need} 解鎖。\n目前：Lv.${result.have}`,
      hint: "多 /公會 捐款 或做 /公會 任務 升等。",
    });
  if (reason === "tenure_not_enough")
    return warehouseView.buildErrorContainer({
      title: "🔒 入會時間不足",
      body: `需加入此公會至少 ${result.needHours} 小時，目前 ${result.haveHours} 小時。`,
      hint: `<t:${Math.floor(result.readyAt / 1000)}:R> 後可使用倉庫。`,
    });
  if (reason === "contribution_not_enough")
    return warehouseView.buildErrorContainer({
      title: "🔒 公會貢獻不足",
      body: `累積貢獻需 ≥ ${result.need}，目前 ${result.have}（差 ${result.need - result.have}）。`,
      hint: "可用 /公會 捐款 或 /公會 存入 補貢獻。",
    });
  if (reason === "daily_limit_reached")
    return warehouseView.buildErrorContainer({
      title: "🧊 今日領取次數用完",
      body: `已取 ${result.used}/${result.max} 次。`,
      hint: "明天 00:00 重置。",
    });
  if (reason === "item_already_taken_today")
    return warehouseView.buildErrorContainer({
      title: "🧊 今天已領過這項",
      body: `${name} 一天限領一次。`,
      hint: "改領別項，明天再來取此物品。",
    });
  if (reason === "self_deposit_24h_lock")
    return warehouseView.buildErrorContainer({
      title: "🧊 24 小時內存過此項",
      body: `你最近存了 ${result.qty} 個 ${name}，自存自領鎖到 <t:${Math.floor(result.unlock_at / 1000)}:R>。`,
      hint: "此鎖防止「存入刷貢獻 → 自己領回」零成本攻擊。",
    });
  if (reason === "qty_over_personal_limit")
    return warehouseView.buildErrorContainer({
      title: "❌ 超過單次上限",
      body: `${name} 單次最多 ${result.limit} 個，你申請 ${result.asked}。`,
    });
  if (reason === "qty_over_available")
    return warehouseView.buildErrorContainer({
      title: "❌ 倉庫可取量不足",
      body: `${name} 可取 ${result.available}（總 ${result.total}，其中 ${result.protected} 保護中），你申請 ${result.asked}。`,
      hint: "等保護期解鎖或請隊友存貨。",
    });
  if (reason === "warehouse_empty")
    return warehouseView.buildErrorContainer({
      title: "📦 倉庫暫時沒有此項",
      body: `${name} 目前可取 0（總 ${result.total}，其中 ${result.protected} 保護中）。`,
      hint: "可發布訊息請會員捐貨。",
    });
  if (reason === "insufficient_funds_for_fee")
    return warehouseView.buildErrorContainer({
      title: "❌ 手續費不足",
      body: `本次需 ${result.need} ${COIN_EMOJI}，你只有 ${result.have} ${COIN_EMOJI}。`,
      hint: "去 /打工 或 /賣礦 補幣再來。",
    });
  if (reason === "race_lost")
    return warehouseView.buildErrorContainer({
      title: "❌ 已被搶先領取",
      body: "別的會員剛剛領走了。",
    });
  if (reason === "charge_failed")
    return warehouseView.buildErrorContainer({
      title: "❌ 扣費失敗",
      body: "倉庫已回滾，請稍後再試。",
    });
  return warehouseView.buildErrorContainer({
    title: "❌ 領取失敗",
    body: `原因：${reason}`,
  });
}

// ───────── 寄售 ─────────

async function runConsign(client, interaction) {
  await interaction.deferReply();
  const itemId = interaction.options.getString("物品", true);
  const qty = interaction.options.getInteger("數量", true);
  const price = interaction.options.getInteger("售價", true);

  const result = await guildWarehouseListingService.createListing(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    sellerName: interaction.member?.displayName || interaction.user.username,
    itemId,
    qty,
    price,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [consignErrorView(result, itemId)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      warehouseView.buildConsignSuccessContainer({
        userId: interaction.user.id,
        club: result.club,
        itemDefArg: result.item,
        listing: result.listing,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

function consignErrorView(result, itemId) {
  const name = warehouseSettings.itemDef(itemId)?.name || itemId;
  const { reason } = result;
  if (reason === "disabled")
    return warehouseView.buildErrorContainer({
      title: "🔧 公會寄售未啟用",
      body: "目前無法使用此功能。",
    });
  if (reason === "not_in_club")
    return warehouseView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "寄售是公會專屬功能。",
    });
  if (reason === "not_manager")
    return warehouseView.buildErrorContainer({
      title: "🚫 僅會長 / 副會長可上架寄售",
      body: "請會長或副會長使用。",
    });
  if (reason === "club_missing")
    return warehouseView.buildErrorContainer({
      title: "❌ 公會資料異常",
      body: "公會已不存在。",
    });
  if (reason === "unknown_item")
    return warehouseView.buildErrorContainer({
      title: "❌ 未知物品",
      body: `「${itemId}」不在倉庫支援清單。`,
      hint: "請從 autocomplete 選單挑選。",
    });
  if (reason === "invalid_qty")
    return warehouseView.buildErrorContainer({
      title: "❌ 數量無效",
      body: "請輸入正整數。",
    });
  if (reason === "invalid_price")
    return warehouseView.buildErrorContainer({
      title: "❌ 售價無效",
      body: "請輸入正整數。",
    });
  if (reason === "qty_over_limit")
    return warehouseView.buildErrorContainer({
      title: "❌ 超過單次上架上限",
      body: `${name} 單次最多 ${result.limit} 個，你輸入 ${result.asked}。`,
      hint: "想清更多分多筆上架。",
    });
  if (reason === "price_too_low")
    return warehouseView.buildErrorContainer({
      title: "❌ 售價過低",
      body: `${name} 此批最低售價 ${result.minPrice.toLocaleString()} ${COIN_EMOJI}，你出 ${result.asked.toLocaleString()}。`,
      hint: "防止傾銷的最低保護價（市價 50%）。",
    });
  if (reason === "too_many")
    return warehouseView.buildErrorContainer({
      title: "❌ 公會寄售已達上限",
      body: `目前已有 ${result.count}/${result.max} 筆寄售中。`,
      hint: "等舊單成交、過期或下架後再上新單。",
    });
  if (reason === "warehouse_not_enough_available")
    return warehouseView.buildErrorContainer({
      title: "❌ 倉庫可上架數量不足",
      body: `${name} 目前可上架數量不足，可能有保護中庫存或其他寄售佔用。`,
      hint: "用 /公會 倉庫 查看當前可動用量。",
    });
  if (reason === "listing_insert_failed")
    return warehouseView.buildErrorContainer({
      title: "❌ 上架失敗",
      body: "倉庫已自動回滾，請稍後再試。",
    });
  return warehouseView.buildErrorContainer({
    title: "❌ 寄售失敗",
    body: `原因：${reason}`,
  });
}
