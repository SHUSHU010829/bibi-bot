require("colors");

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const autocompleteBeverageStore = require("../../../utils/autocompleteBeverageStore");

async function run(client, interaction) {
  const { options } = interaction;
  const beverageStore = options.getString("飲料店")?.trim();
  const menuText = options.getString("菜單");
  const shouldOverwrite = options.getBoolean("覆蓋現有") || false;

  const collection = client.collection;

  await interaction.deferReply();

  try {
    if (!beverageStore) {
      interaction.editReply("❌ 飲料店名稱不能為空白！");
      return;
    }

    let items = [];
    let lines = menuText.split(/\n+/);

    lines.forEach((line) => {
      const lineItems = line
        .split(/[,;，；、]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      items.push(...lineItems);
    });

    items = [...new Set(items)];

    if (items.length === 0) {
      interaction.editReply("❌ 沒有找到有效的品項！請檢查格式。");
      return;
    }

    if (shouldOverwrite) {
      const deleteResult = await collection.deleteMany({
        category: "beverage",
        beverageStore: beverageStore,
      });
      console.log(
        `[INFO] Deleted ${deleteResult.deletedCount} existing items from ${beverageStore}`.yellow
      );
    }

    const existingDocs = await collection
      .find(
        {
          name: { $in: items },
          category: "beverage",
          beverageStore: beverageStore,
        },
        { projection: { name: 1 } }
      )
      .toArray();
    const existingNames = new Set(existingDocs.map((doc) => doc.name));

    const skippedItems = [...existingNames];
    const toInsert = items
      .filter((name) => !existingNames.has(name))
      .map((name) => ({
        name,
        category: "beverage",
        beverageStore: beverageStore,
        drawCount: 0,
      }));

    let addedCount = 0;
    if (toInsert.length > 0) {
      try {
        const result = await collection.insertMany(toInsert, {
          ordered: false,
        });
        addedCount = result.insertedCount ?? toInsert.length;
      } catch (insertError) {
        addedCount = insertError.result?.insertedCount ?? 0;
        const failedNames = (insertError.writeErrors || [])
          .map((e) => e.err?.op?.name)
          .filter(Boolean);
        skippedItems.push(...failedNames);
      }
    }
    const skippedCount = skippedItems.length;

    let description = "";
    if (shouldOverwrite) description += `🗑️ 已清空現有菜單\n\n`;
    description +=
      `📊 **匯入統計**\n` +
      `✅ 成功新增：${addedCount} 項\n` +
      `⏭️ 已存在跳過：${skippedCount} 項\n` +
      `📝 總共處理：${items.length} 項`;

    const container = new ContainerBuilder()
      .setAccentColor(0x00ae86)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ✅ ${beverageStore} 菜單匯入完成\n${description}`,
        ),
      );

    if (addedCount > 0) {
      const addedItems = items.filter(
        (item) => !skippedItems.includes(item)
      );
      const displayItems =
        addedItems.length > 20
          ? addedItems.slice(0, 20).join(", ") + ` ... 等 ${addedItems.length} 項`
          : addedItems.join(", ");
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**新增的品項**\n${displayItems}`,
          ),
        );
    }

    if (skippedCount > 0 && skippedCount <= 10) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**已存在的品項**\n${skippedItems.join(", ")}`,
        ),
      );
    }

    const totalItems = await collection.countDocuments({
      category: "beverage",
      beverageStore: beverageStore,
    });

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${beverageStore} 目前共有 ${totalItems} 項飲品 ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

    interaction.editReply({
      content: "",
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    console.log(
      `[SUCCESS] Imported ${addedCount} items for ${beverageStore}`.green
    );
  } catch (error) {
    interaction.editReply("❌ 匯入失敗，請檢查格式或呼叫舒舒！");
    console.log(
      `[ERROR] An error occurred inside import beverage menu:\n${error}`.red
    );
  }
}

module.exports = { run, autocomplete: autocompleteBeverageStore };
