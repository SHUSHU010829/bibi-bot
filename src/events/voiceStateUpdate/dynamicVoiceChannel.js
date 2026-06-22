require("colors");

const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { createVoiceChannelId, voiceChannel } = require("../../config");
const dynamicChannels = require("../../utils/dynamicChannelStore");

module.exports = async (client, oldState, newState) => {
  try {
    // 從 config.json 讀取"點選新增頻道"的 ID
    const CREATE_CHANNEL_ID = createVoiceChannelId;

    if (!CREATE_CHANNEL_ID) {
      console.log(
        "[WARNING] createVoiceChannelId not set in config.json"
          .yellow
      );
      return;
    }

    const member = newState.member || oldState.member;
    const guild = newState.guild || oldState.guild;

    // 當用戶加入"點選新增頻道"時（含從其他語音房切過來的情況）
    if (
      newState.channelId === CREATE_CHANNEL_ID &&
      oldState.channelId !== CREATE_CHANNEL_ID
    ) {
      try {
        console.log(
          `[VOICE] ${member.user.tag} joined the create channel, creating new voice channel...`
            .cyan
        );

        // 獲取創建頻道所在的分類
        const createChannel = guild.channels.cache.get(CREATE_CHANNEL_ID);
        const parentId = createChannel?.parentId;

        // 創建新的語音頻道
        const newChannel = await guild.channels.create({
          name: voiceChannel.defaultChannelName,
          type: ChannelType.GuildVoice,
          parent: parentId,
          permissionOverwrites: [
            // 基礎權限：所有人都可以查看和連接
            {
              id: guild.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
            },
            // 創建者權限：可以管理頻道（編輯名稱、調整人數上限）
            {
              id: member.id,
              allow: [
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.MoveMembers,
              ],
            },
          ],
        });

        // 記錄創建者
        dynamicChannels.set(newChannel.id, {
          ownerId: member.id,
          guildId: guild.id,
          parentId: parentId || null,
          createdAt: Date.now(),
        });

        // 將用戶移動到新頻道
        await member.voice.setChannel(newChannel);

        console.log(
          `[VOICE] Created new voice channel: ${newChannel.name} (${newChannel.id}) for ${member.user.tag}`
            .green
        );
      } catch (error) {
        console.error(`[ERROR] Failed to create dynamic voice channel: ${error}`.red);
      }
    }

    // 當用戶加入動態頻道時，給予編輯狀態的權限
    if (
      newState.channelId &&
      dynamicChannels.has(newState.channelId) &&
      newState.channelId !== oldState.channelId
    ) {
      try {
        const channel = guild.channels.cache.get(newState.channelId);
        // 給予加入者設置狀態的權限（如果該權限存在）
        if (channel && PermissionFlagsBits.SetVoiceChannelStatus) {
          await channel.permissionOverwrites.edit(member.id, {
            SetVoiceChannelStatus: true,
          });

          console.log(
            `[VOICE] Granted status edit permission to ${member.user.tag} in ${channel.name}`
              .cyan
          );
        }
      } catch (error) {
        console.error(
          `[ERROR] Failed to grant status permission in dynamic voice channel: ${error}`.red
        );
      }
    }

    // 當動態頻道為空時刪除
    if (
      oldState.channelId &&
      dynamicChannels.has(oldState.channelId) &&
      oldState.channelId !== newState.channelId
    ) {
      // 使用 setTimeout 來確保 Discord 緩存已更新
      const t = setTimeout(async () => {
        try {
          // 重新 fetch 頻道以確保成員列表最新（cache 偶爾不準）
          const channel = await guild.channels
            .fetch(oldState.channelId)
            .catch(() => null);

          if (!channel) {
            // 已被別人或 Discord 刪掉，清掉紀錄即可
            dynamicChannels.remove(oldState.channelId);
            return;
          }

          if (channel.members.size === 0) {
            const channelName = channel.name;
            await channel.delete(voiceChannel.deleteReason);
            dynamicChannels.remove(oldState.channelId);

            console.log(
              `[VOICE] Deleted empty dynamic voice channel: ${channelName}`
                .yellow
            );
          }
        } catch (error) {
          console.error(
            `[ERROR] Failed to delete dynamic voice channel: ${error}`.red
          );
        }
      }, 1000); // 延遲 1 秒以確保緩存更新
      t.unref?.();
    }
  } catch (error) {
    console.error(
      `[ERROR] Error in dynamic voice channel handler: ${error}`.red
    );
  }
};
