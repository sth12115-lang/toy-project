import { getCacheExpiresAt, getRemainingUsd, searchRanking } from "./actions";
import { RankingSearch } from "./ranking-search";

// A fresh fetch (7 Apify runs, then SerpApi re-checks) takes about 20–30s,
// longer than some platform defaults for the page's Server Actions.
export const maxDuration = 60;

export default async function Home() {
  const [remainingUsd, cacheExpiresAt] = await Promise.all([
    getRemainingUsd(),
    getCacheExpiresAt(),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance break-keep">
          부산-오사카 월별 최저가 왕복 항공권
        </h1>
        <p className="text-muted-foreground">
          2026년 11–12월, 2박 3일–3박 4일 왕복 일정 중 달마다 가장 싼 3개를
          보여 드립니다. 가격은 Google Flights 한국 시장, 성인 1명 이코노미
          기준이며 왕복 1장과 편도 2장 중 더 싼 쪽입니다.
        </p>
      </header>
      <RankingSearch
        action={searchRanking}
        initialRemainingUsd={remainingUsd}
        initialCacheExpiresAt={cacheExpiresAt}
      />
    </main>
  );
}
