require("colors");

const { coinSystem, bank } = require("../../config");
const loanService = require("../../features/bank/loanService");
const { registerCron } = require("../../utils/cronRegistry");

module.exports = async (client) => {
  if (!coinSystem?.enabled || !bank?.loan?.enabled) return;

  registerCron(client, {
    name: "bank.loanOverdue",
    label: "貸款逾期結算",
    schedule: "0 3 * * *",
    timezone: coinSystem?.daily?.resetTimezone || "Asia/Taipei",
    runner: async () => {
      const res = await loanService.processOverdue(client);
      if (res.penalized || res.defaulted) {
        console.log(
          `[BANK] 逾期貸款結算：加罰 ${res.penalized} 筆、違約 ${res.defaulted} 筆`.yellow,
        );
      }
      return res;
    },
  });
};
