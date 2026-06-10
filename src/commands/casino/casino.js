// /賭場 — 賭場遊戲母指令。各遊戲維持獨立檔案（標記 subcommandOnly），
// 這裡把它們的 builder 轉成 subcommand / subcommand group 掛在同一個指令下，
// 並依 subcommand 名稱 dispatch 回原本的 run()。

const {
  InteractionContextType,
  ApplicationCommandOptionType,
} = require("discord.js");

const GAMES = [
  require("./blackjack"),
  require("./crash"),
  require("./dragonGate"),
  require("./hilo"),
  require("./horseRacing"),
  require("./keno"),
  require("./lottery"),
  require("./pokerOpen"),
  require("./roulette"),
  require("./sicbo"),
  require("./slot"),
];

const gameByName = new Map();

const options = GAMES.map((mod) => {
  const json = typeof mod.data.toJSON === "function" ? mod.data.toJSON() : mod.data;
  gameByName.set(json.name, mod);

  const hasSubcommands = (json.options || []).some(
    (o) => o.type === ApplicationCommandOptionType.Subcommand
  );
  return {
    type: hasSubcommands
      ? ApplicationCommandOptionType.SubcommandGroup
      : ApplicationCommandOptionType.Subcommand,
    name: json.name,
    description: json.description,
    options: json.options || [],
  };
});

module.exports = {
  data: {
    name: "賭場",
    description: "賭場遊戲 🎰",
    contexts: [InteractionContextType.Guild],
    options,
  },

  run: (client, interaction) => {
    const name =
      interaction.options.getSubcommandGroup(false) ??
      interaction.options.getSubcommand();
    return gameByName.get(name).run(client, interaction);
  },
};
