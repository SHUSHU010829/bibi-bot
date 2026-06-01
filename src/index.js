require("dotenv/config");
require("dns").setDefaultResultOrder("ipv4first");

const { Client, GatewayIntentBits, Partials } = require("discord.js");

const eventHandlers = require("./handlers/eventHandler.js");
const startHttpServer = require("./httpServer");
require("./utils/eventLoopMonitor");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  rest: { timeout: 30_000 },
});

eventHandlers(client);
startHttpServer(client);

client.on("error", (err) => {
  console.error("[Client error]", err);
});

client.rest.on("restDebug", (msg) => {
  console.log(`[RestDebug] ${msg}`);
});
client.rest.on("rateLimited", (info) => {
  console.log(`[RateLimited] ${JSON.stringify(info)}`);
});
client.rest.on("response", (req, res) => {
  console.log(
    `[RestResponse] ${req.method} ${req.path} -> ${res.status} (took ${res.headers?.get?.("x-runtime") || "?"})`
  );
});
client.rest.on("invalidRequestWarning", (info) => {
  console.log(`[InvalidRequestWarning] ${JSON.stringify(info)}`);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

client.login(process.env.BOT_TOKEN);
