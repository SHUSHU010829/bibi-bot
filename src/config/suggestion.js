const base = require("./suggestion.json");

module.exports = {
  suggestion: {
    ...base.suggestion,
    categoryId: process.env.SUGGESTION_CATEGORY_ID,
    supportRoleId: process.env.SUGGESTION_SUPPORT_ROLE_ID,
  },
};
