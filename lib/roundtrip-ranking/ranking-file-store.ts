import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RankingStore, StoredRanking } from "./ranking-cache";

/** JSON-file store so the stored ranking survives server restarts. */
export function createFileStore(path: string): RankingStore {
  function readAll(): Record<string, StoredRanking> {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  }

  return {
    get: (key) => readAll()[key],
    set(key, entry) {
      const all = readAll();
      all[key] = entry;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(all), "utf8");
    },
  };
}
