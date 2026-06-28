// 互動 ack 統一入口：務必「先 ack（defer）再做 DB／運算」，否則慢查詢吃掉 Discord
// 的 3 秒回應視窗後，後續的 reply／update／editReply 會噴 DiscordAPIError[10062]
// Unknown interaction。
//
// 用法（原本以 interaction.reply 當第一個回應的分支）：
//   if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
//   ...（DB / 運算）...
//   await interaction.editReply({ components: [c], flags: MessageFlags.IsComponentsV2 });
//
// 用法（原本以 interaction.update 更新元件面板的分支）：
//   if (!(await deferUpdateSafe(interaction))) return;
//   ...（DB / 運算）...
//   await interaction.editReply({ components: [c], flags: MessageFlags.IsComponentsV2 });
//
// 兩個函式都是 idempotent：若互動已 defer / reply 過會直接回 true；若互動已逾期
// （10062）會回 false，呼叫端應 return、不要再嘗試回應一個死掉的互動。

function deferReplySafe(interaction, opts = {}) {
  return ackSafe(interaction, () => interaction.deferReply(opts));
}

function deferUpdateSafe(interaction) {
  return ackSafe(interaction, () => interaction.deferUpdate());
}

async function ackSafe(interaction, fn) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await fn();
    return true;
  } catch (err) {
    if (isUnknownInteraction(err)) return false;
    throw err;
  }
}

function isUnknownInteraction(err) {
  return err?.code === 10062;
}

module.exports = { deferReplySafe, deferUpdateSafe, isUnknownInteraction };
