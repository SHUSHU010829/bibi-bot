require("colors");
const axios = require("axios");

const APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const DEFAULT_INTERVAL_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch Steam appdetails for a single appid in TW region (zh-tw).
 * Returns null when the app is not available in TW or the request fails.
 */
const fetchAppDetails = async (appid, { fetcher = axios.get } = {}) => {
  try {
    const response = await fetcher(APPDETAILS_URL, {
      params: {
        appids: appid,
        cc: "tw",
        l: "tchinese",
        filters: "basic,price_overview,release_date",
      },
      timeout: 15000,
      headers: {
        "Accept-Language": "zh-TW,zh;q=0.9",
      },
    });

    const entry = response?.data?.[String(appid)];
    if (!entry || entry.success !== true || !entry.data) {
      return null;
    }
    return entry.data;
  } catch (error) {
    console.log(
      `[ERROR] Steam appdetails ${appid} failed: ${error.message}`.red
    );
    return null;
  }
};

/**
 * Fetch a batch of appids sequentially with a fixed delay between requests
 * to stay below Steam's informal rate limit (~200 req / 5 min).
 *
 * onResult is called for each appid with { appid, data }; data is null on miss.
 */
const fetchAppDetailsBatch = async (
  appids,
  { intervalMs = DEFAULT_INTERVAL_MS, onResult } = {}
) => {
  const results = [];
  for (let i = 0; i < appids.length; i++) {
    const appid = appids[i];
    const data = await fetchAppDetails(appid);
    const item = { appid, data };
    results.push(item);
    if (typeof onResult === "function") onResult(item);
    if (i < appids.length - 1) await sleep(intervalMs);
  }
  return results;
};

const buildStoreUrl = (appid) =>
  `https://store.steampowered.com/app/${appid}/?cc=tw`;

module.exports = { fetchAppDetails, fetchAppDetailsBatch, buildStoreUrl };
