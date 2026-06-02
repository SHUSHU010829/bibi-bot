require("dotenv/config");
require("dns").setDefaultResultOrder("ipv4first");

// @discordjs/rest 2.6.1 內部硬綁 undici 6.24.1，它的 fetch + FormData →
// Blob([Buffer]) → multipart encoder 在送圖片時會跟 Cloudflare 算錯 byte
// count，連線在 stream body 一半被 RST → UND_ERR_SOCKET。已用 /dev upload
// test 確認：同一張 PNG buffer，discord.js 路徑 15s timeout，raw undici
// 7.27 routes 553ms 200 OK。
//
// 解法：攔截 client.rest.options.makeRequest，遇到 multipart body 自己拆 FormData
// 用 undici 7.27 重新組多部分送出去，繞過 undici 6.24 的 bug。JSON 請求照舊
// 走 discord.js（沒壞的不動）。
const undici = require("undici");
const { setGlobalDispatcher, Agent, request: undiciRequest } = undici;
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 10_000 },
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
  })
);

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

const CRLF = "\r\n";

function isFormDataLike(body) {
  return (
    body &&
    typeof body === "object" &&
    typeof body.entries === "function" &&
    typeof body.getAll === "function"
  );
}

async function sendMultipartViaUndici(url, init) {
  const boundary = `bibibot${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const parts = [];

  for (const [key, value] of init.body.entries()) {
    if (value && typeof value === "object" && typeof value.arrayBuffer === "function") {
      const ab = await value.arrayBuffer();
      const filename = value.name || key;
      const type = value.type || "application/octet-stream";
      parts.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${key}"; filename="${filename}"${CRLF}` +
            `Content-Type: ${type}${CRLF}${CRLF}`
        )
      );
      parts.push(Buffer.from(ab));
      parts.push(Buffer.from(CRLF));
    } else {
      parts.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
            String(value) +
            CRLF
        )
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  const rawBody = Buffer.concat(parts);

  const headers = {};
  if (init.headers) {
    const src =
      typeof init.headers.entries === "function"
        ? init.headers
        : Object.entries(init.headers);
    const iter = typeof init.headers.entries === "function" ? src.entries() : src;
    for (const [k, v] of iter) {
      const lk = k.toLowerCase();
      if (lk === "content-type" || lk === "content-length") continue;
      headers[k] = v;
    }
  }
  headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
  headers["content-length"] = String(rawBody.length);

  const res = await undiciRequest(url, {
    method: init.method || "GET",
    headers,
    body: rawBody,
  });
  const buf = await res.body.arrayBuffer();
  return new Response(buf, {
    status: res.statusCode,
    headers: res.headers,
  });
}

const _origMakeRequest = client.rest.options.makeRequest;
client.rest.options.makeRequest = async function patchedMakeRequest(url, init) {
  if (isFormDataLike(init?.body)) {
    return sendMultipartViaUndici(url, init);
  }
  return _origMakeRequest(url, init);
};

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

client.login(process.env.BOT_TOKEN);
