require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { guildClub } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const guildClubService = require("../../features/guild_club/guildClubService");
const guildClubView = require("../../features/guild_club/guildClubView");

const SUB_CREATE = "建立";
const SUB_INFO = "資訊";
const SUB_DISBAND = "解散";

module.exports = {
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
        .setName(SUB_DISBAND)
        .setDescription("解散公會（僅會長可用，金庫平分給成員）")
    ),

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
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    try {
      if (sub === SUB_CREATE) return runCreate(client, interaction);
      if (sub === SUB_INFO) return runInfo(client, interaction);
      if (sub === SUB_DISBAND) return runDisband(client, interaction);
    } catch (e) {
      console.log(`[GUILD_CLUB] /公會 ${sub} 失敗：${e.stack || e.message}`.red);
      const reply = {
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 操作失敗",
            body: "出了點狀況，請稍後再試。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
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
  const isLeader = isMember && viewerMembership.role === "leader";

  return interaction.editReply({
    components: [
      guildClubView.buildInfoContainer({
        viewerId: interaction.user.id,
        club,
        members,
        isMember,
        isLeader,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runDisband(client, interaction) {
  await interaction.deferReply();

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
          body: "沒有公會可解散。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  if (membership.role !== "leader") {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🚫 只有會長能解散公會",
          body: "如要退出公會，請使用 /公會 退會。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const club = await guildClubService.getClubById(
    client,
    membership.guild_club_id
  );
  if (!club) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 公會資料異常",
          body: "公會已不存在。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const members = await guildClubService.listMembers(
    client,
    club.guild_club_id
  );
  const memberCount = members.length;
  const payoutPerMember =
    memberCount > 0
      ? Math.floor((club.treasury_current || 0) / memberCount)
      : 0;

  return interaction.editReply({
    components: [
      guildClubView.buildDisbandConfirmContainer({
        leaderId: interaction.user.id,
        club,
        members,
        payoutPerMember,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}
