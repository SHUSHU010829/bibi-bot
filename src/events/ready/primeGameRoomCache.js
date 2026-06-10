require("colors");
const { primeCache } = require("../../features/gameRoom/service");

module.exports = async (client) => {
  await primeCache(client).catch((e) =>
    console.log(`[GAMEROOM] primeCache failed: ${e.message}`.red)
  );
};
