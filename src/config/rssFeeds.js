// RSS 推播 feed 設定。新增 feed 只需要動這個檔案。
// channelId 可用環境變數覆寫,方便不同部署環境切頻道。
//
// filter (可選):條件式過濾,留空 → 不過濾,全推。
//   match: "all" | "any"  條件之間的邏輯,預設 "all"
//   conditions: [{ field, op, pattern }]
//     field:   "description" | "title" | "author"  (description 對應貼文內文)
//     op:      "matches" | "not_matches"           (regex,大小寫不敏感)
//     pattern: 正則字串,用 | 串多個關鍵字

const DEFAULT_CHANNEL_ID = "1174352640210124877";

const RSS_FEEDS = [
  {
    id: "picnob_liveking",
    url: "https://discord-news.zeabur.app/picnob.info/user/liveking_is_life",
    channelId:
      process.env.RSS_THREADS_LIVEKING_CHANNEL_ID || DEFAULT_CHANNEL_ID,
    type: "picnob",
    filter: {
      match: "all",
      conditions: [
        {
          field: "description",
          op: "matches",
          pattern: "一週售票速報|演唱會行事曆|演唱會整理",
        },
        {
          field: "description",
          op: "not_matches",
          pattern: "收藏本|票根|周邊|預購中|商品",
        },
      ],
    },
  },
  {
    id: "picnob_room_exhibition",
    url: "https://discord-news.zeabur.app/picnob.info/user/room_exhibition",
    channelId:
      process.env.RSS_PICNOB_ROOM_EXHIBITION_CHANNEL_ID || DEFAULT_CHANNEL_ID,
    type: "picnob",
    filter: {
      match: "all",
      conditions: [
        {
          field: "description",
          op: "matches",
          pattern: "#月份選展合輯",
        },
      ],
    },
  },
];

module.exports = { RSS_FEEDS };
