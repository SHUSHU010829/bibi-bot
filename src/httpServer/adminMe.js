/**
 * GET /api/v1/admin/me — website 用來判斷當前 session 使用者是否 admin
 *
 * requireAdmin 已經幫我們做完所有檢查，到這裡就回 200 即可。
 */
module.exports = function createAdminMeHandler() {
  return async function (req, res) {
    return res.status(200).json({
      ok: true,
      userId: req.admin.userId,
      isOwner: req.admin.isOwner,
      username: req.admin.member.user?.username ?? null,
      displayName: req.admin.member.displayName ?? null,
    });
  };
};
