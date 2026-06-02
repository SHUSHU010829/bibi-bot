// 繞過 discord.js / @discordjs/rest，直接用 undici 對 Discord webhook
// 送 multipart followUp / PATCH。用來診斷圖卡上傳一直 SocketError 是
// discord.js 自己組 multipart body 的 bug，還是更底層的 undici/網路問題。

const { request } = require("undici");

const CRLF = "\r\n";
const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://github.com/SHUSHU010829/bibi-bot, 1.0)";

function buildMultipart(boundary, buffer, filename, payloadJson) {
  const parts = [
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="files[0]"; filename="${filename}"${CRLF}` +
        `Content-Type: image/png${CRLF}${CRLF}`
    ),
    buffer,
    Buffer.from(CRLF),
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="payload_json"${CRLF}` +
        `Content-Type: application/json${CRLF}${CRLF}` +
        payloadJson +
        CRLF
    ),
    Buffer.from(`--${boundary}--${CRLF}`),
  ];
  return Buffer.concat(parts);
}

async function rawFollowUpWithImage(
  interaction,
  { content, buffer, filename, ephemeral = true }
) {
  const url = `${API}/webhooks/${interaction.applicationId}/${interaction.token}`;
  const boundary = `bibibot${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const payload = {
    content,
    attachments: [{ id: 0, filename }],
    ...(ephemeral ? { flags: 64 } : {}),
  };
  const body = buildMultipart(boundary, buffer, filename, JSON.stringify(payload));

  const start = Date.now();
  const res = await request(url, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
      "user-agent": UA,
    },
    body,
  });
  const took = Date.now() - start;
  const text = await res.body.text().catch(() => "");
  return { status: res.statusCode, took, bodySize: body.length, text };
}

module.exports = { rawFollowUpWithImage };
