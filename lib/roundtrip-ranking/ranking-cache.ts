import type { Route, RoundtripRanking } from "./types";

export type CachedRanking = {
  ranking: RoundtripRanking;
  /** Epoch ms when the ranking was fetched from the provider. */
  fetchedAt: number;
  /** Epoch ms when the stored ranking stops being reused. */
  expiresAt: number;
  /** True when served from storage instead of a fresh fetch. */
  cached: boolean;
  /** True when a refresh was due but failed, so an older ranking is served. */
  refreshFailed: boolean;
};

export type StoredRanking = { ranking: RoundtripRanking; fetchedAt: number };

/** Where rankings are kept between requests (and, for files, restarts). */
export type RankingStore = {
  get(key: string): StoredRanking | undefined;
  set(key: string, entry: StoredRanking): void;
};

function createMemoryStore(): RankingStore {
  const entries = new Map<string, StoredRanking>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => void entries.set(key, entry),
  };
}

type Options = {
  ttlMs: number;
  now?: () => number;
  store?: RankingStore;
};

export function createRankingCache({
  ttlMs,
  now = Date.now,
  store = createMemoryStore(),
}: Options) {
  const keyOf = (route: Route) => `${route.origin}-${route.destination}`;
  const isLive = (entry: StoredRanking) => now() - entry.fetchedAt < ttlMs;
  const served = (entry: StoredRanking, cached: boolean, refreshFailed: boolean) => ({
    ...entry,
    expiresAt: entry.fetchedAt + ttlMs,
    cached,
    refreshFailed,
  });

  return {
    /** When the stored ranking for this route expires, or null if none is live. */
    expiresAt(route: Route): number | null {
      const entry = store.get(keyOf(route));
      return entry && isLive(entry) ? entry.fetchedAt + ttlMs : null;
    },

    async getOrLoad(
      route: Route,
      load: () => Promise<RoundtripRanking>,
    ): Promise<CachedRanking> {
      const key = keyOf(route);
      const stored = store.get(key);
      if (stored && isLive(stored)) return served(stored, true, false);

      try {
        const entry = { ranking: await load(), fetchedAt: now() };
        store.set(key, entry);
        return served(entry, false, false);
      } catch (error) {
        // Keep showing the last good ranking rather than nothing.
        if (stored) return served(stored, true, true);
        throw error;
      }
    },
  };
}
