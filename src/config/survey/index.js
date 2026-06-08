const fs = require("fs");
const path = require("path");

const system = require("./system.json");

const templates = {};
const templatesDir = path.join(__dirname, "templates");
for (const file of fs.readdirSync(templatesDir)) {
  if (!file.endsWith(".json")) continue;
  const tpl = require(path.join(templatesDir, file));
  if (!tpl?.id) {
    console.log(`[WARN] survey template ${file} 缺少 id，已略過`);
    continue;
  }
  templates[tpl.id] = tpl;
}

const active = templates[system.activeTemplate];
if (!active) {
  console.log(
    `[WARN] survey.activeTemplate "${system.activeTemplate}" 找不到對應模板，問卷將顯示無效`,
  );
}

const survey = {
  ...system,
  templates,
  title: active?.title ?? "玩家問卷",
  intro: active?.intro ?? "",
  selectQuestions: active?.selectQuestions ?? [],
  openQuestions: active?.openQuestions ?? [],
};

module.exports = { survey };
