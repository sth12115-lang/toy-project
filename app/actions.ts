"use server";

import { join } from "node:path";

import {
  createApifyCalendar,
  createFileStore,
  createRankingCache,
  createSerpApiAirline,
  FIXED_ROUTE,
  fetchApifyRemainingUsd,
  getRoundtripRanking,
} from "@/lib/roundtrip-ranking/server";

import type { SearchState } from "./ranking-search";

// Prices are fetched at most every 12 hours and kept on disk across restarts.
const rankingCache = createRankingCache({
  ttlMs: 12 * 60 * 60 * 1000,
  store: createFileStore(join(process.cwd(), ".data", "ranking.json")),
});

/** When the stored ranking expires and the next search fetches new prices. */
export async function getCacheExpiresAt(): Promise<number | null> {
  return rankingCache.expiresAt(FIXED_ROUTE);
}

/** Apify free usage left this month in USD. */
export async function getRemainingUsd(): Promise<number | null> {
  const token = process.env.APIFY_TOKEN;
  return token ? fetchApifyRemainingUsd(token) : null;
}

// The route is fixed, so the form carries no fields to read.
export async function searchRanking(): Promise<SearchState> {
  const apifyToken = process.env.APIFY_TOKEN;
  const serpApiKey = process.env.SERPAPI_API_KEY;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { expiresAt, ...result } = await rankingCache.getOrLoad(
      FIXED_ROUTE,
      () => {
        if (!apifyToken || !serpApiKey) {
          throw new Error("APIFY_TOKEN or SERPAPI_API_KEY is not set");
        }
        return getRoundtripRanking(FIXED_ROUTE, {
          calendar: createApifyCalendar(apifyToken),
          airline: createSerpApiAirline(serpApiKey),
        });
      },
    );
    if (result.refreshFailed) console.error("Refresh failed; serving stored ranking");
    return {
      status: "success",
      ...result,
      // null after a failed refresh, so the page offers to fetch again.
      cacheExpiresAt: rankingCache.expiresAt(FIXED_ROUTE),
      remainingUsd: await getRemainingUsd(),
    };
  } catch (error) {
    console.error(error);
    return {
      status: "error",
      message: "잠시 후 다시 조회해 주세요.",
      cacheExpiresAt: rankingCache.expiresAt(FIXED_ROUTE),
      remainingUsd: await getRemainingUsd(),
    };
  }
}
