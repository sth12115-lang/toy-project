// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createFileStore,
  createRankingCache,
  type RoundtripRanking,
} from "@/lib/roundtrip-ranking/server";

const HOUR = 60 * 60 * 1000;
const kix = { origin: "PUS", destination: "KIX" };
const fuk = { origin: "PUS", destination: "FUK" };

function clock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function countingLoader() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    load: async (): Promise<RoundtripRanking> => {
      calls += 1;
      return { months: [{ month: "2026-11", trips: [] }] };
    },
  };
}

describe("createRankingCache", () => {
  it("같은 노선을 1시간 안에 다시 조회하면 새로 검색하지 않고 저장된 결과와 조회 시각을 돌려준다", async () => {
    const time = clock(Date.parse("2026-10-22T05:00:00Z"));
    const cache = createRankingCache({ ttlMs: HOUR, now: time.now });
    const loader = countingLoader();

    const first = await cache.getOrLoad(kix, loader.load);
    time.advance(59 * 60 * 1000);
    const second = await cache.getOrLoad(kix, loader.load);

    expect(loader.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.fetchedAt).toBe(Date.parse("2026-10-22T05:00:00Z"));
  });

  it("1시간이 지났거나 다른 노선이면 새로 검색한다", async () => {
    const time = clock(0);
    const cache = createRankingCache({ ttlMs: HOUR, now: time.now });
    const loader = countingLoader();

    await cache.getOrLoad(kix, loader.load);
    await cache.getOrLoad(fuk, loader.load);
    time.advance(HOUR);
    const again = await cache.getOrLoad(kix, loader.load);

    expect(loader.calls).toBe(3);
    expect(again.cached).toBe(false);
    expect(again.fetchedAt).toBe(HOUR);
  });

  it("저장된 결과가 언제 끝나는지 알려 주고, 끝났거나 없으면 null을 돌려준다", async () => {
    const time = clock(0);
    const cache = createRankingCache({ ttlMs: HOUR, now: time.now });
    const loader = countingLoader();

    expect(cache.expiresAt(kix)).toBeNull();

    const result = await cache.getOrLoad(kix, loader.load);
    expect(result.expiresAt).toBe(HOUR);

    time.advance(HOUR - 1);
    expect(cache.expiresAt(kix)).toBe(HOUR);

    time.advance(1);
    expect(cache.expiresAt(kix)).toBeNull();
    expect(loader.calls).toBe(1);
  });

  it("저장 기간이 지난 뒤 새로 받아 오지 못하면, 지난 결과를 갱신 실패 표시와 함께 돌려준다", async () => {
    const time = clock(0);
    const cache = createRankingCache({ ttlMs: HOUR, now: time.now });
    const loader = countingLoader();
    await cache.getOrLoad(kix, loader.load);

    time.advance(2 * HOUR);
    const result = await cache.getOrLoad(kix, async () => {
      throw new Error("Apify usage exhausted");
    });

    expect(result.cached).toBe(true);
    expect(result.refreshFailed).toBe(true);
    expect(result.fetchedAt).toBe(0);
    expect(result.ranking.months[0].month).toBe("2026-11");

    // The next search tries again instead of keeping the failure.
    const next = await cache.getOrLoad(kix, loader.load);
    expect(next.refreshFailed).toBe(false);
    expect(next.cached).toBe(false);
  });

  it("저장소에 넣은 결과는 새로 만든 캐시(서버 재시작)에서도 그대로 쓴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fca-cache-"));
    try {
      const file = join(dir, "ranking.json");
      const loader = countingLoader();

      const first = createRankingCache({
        ttlMs: HOUR,
        now: () => 0,
        store: createFileStore(file),
      });
      await first.getOrLoad(kix, loader.load);

      const afterRestart = createRankingCache({
        ttlMs: HOUR,
        now: () => 10 * 60 * 1000,
        store: createFileStore(file),
      });
      const result = await afterRestart.getOrLoad(kix, loader.load);

      expect(loader.calls).toBe(1);
      expect(result.cached).toBe(true);
      expect(afterRestart.expiresAt(kix)).toBe(HOUR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("저장소에 쓰지 못해도(읽기 전용 파일 시스템) 새로 받아 온 결과는 그대로 돌려준다", async () => {
    const cache = createRankingCache({
      ttlMs: HOUR,
      now: () => 0,
      store: {
        get: () => undefined,
        set: () => {
          throw new Error("EROFS: read-only file system");
        },
      },
    });
    const loader = countingLoader();

    const result = await cache.getOrLoad(kix, loader.load);

    expect(result.cached).toBe(false);
    expect(result.refreshFailed).toBe(false);
    expect(result.ranking.months[0].month).toBe("2026-11");
  });

  it("실패한 조회는 저장하지 않아 다음 조회에서 새로 검색한다", async () => {
    const cache = createRankingCache({ ttlMs: HOUR, now: () => 0 });
    const loader = countingLoader();

    await expect(
      cache.getOrLoad(kix, async () => {
        throw new Error("SearchApi failed");
      }),
    ).rejects.toThrow("SearchApi failed");
    const next = await cache.getOrLoad(kix, loader.load);

    expect(loader.calls).toBe(1);
    expect(next.cached).toBe(false);
  });
});
