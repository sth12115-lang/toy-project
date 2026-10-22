import { describe, expect, it } from "vitest";

import {
  createApifyCalendar,
  createSerpApiAirline,
  fetchApifyRemainingUsd,
} from "@/lib/roundtrip-ranking/server";

function respondWith(body: unknown, status = 200) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const window = {
  origin: "PUS",
  destination: "KIX",
  outboundStart: "2026-11-07",
  outboundEnd: "2026-11-19",
  returnStart: "2026-11-09",
  returnEnd: "2026-11-22",
};

describe("Apify 가격 캘린더", () => {
  it("요청한 기간을 왕복 2–3박 원화로 묻고, 가격이 있는 일정만 돌려준다", async () => {
    const { fetchImpl, requests } = respondWith([
      { outboundDate: "2026-11-17", returnDate: "2026-11-19", price: 249900, currency: "KRW", currencyMatchesRequest: true },
      { outboundDate: "2026-11-18", returnDate: "2026-11-20", price: null, currency: "KRW" },
      { outboundDate: "2026-11-19", returnDate: "2026-11-21", price: 9.9, currency: "USD", currencyMatchesRequest: false },
    ]);

    const fares = await createApifyCalendar("token", fetchImpl)(window);

    expect(fares).toEqual([
      { departure: "2026-11-17", return: "2026-11-19", price: 249900 },
    ]);
    const input = JSON.parse(String(requests[0].init?.body));
    expect(input).toMatchObject({
      origin: "PUS",
      destination: "KIX",
      tripType: "roundTrip",
      dateRangeStart: "2026-11-07",
      dateRangeEnd: "2026-11-19",
      returnRangeStart: "2026-11-09",
      returnRangeEnd: "2026-11-22",
      minTripLengthNights: 2,
      maxTripLengthNights: 3,
      currency: "KRW",
    });
    expect(requests[0].url).toContain("maxTotalChargeUsd=");
  });

  it("실행이 실패하면 오류를 던진다", async () => {
    const { fetchImpl } = respondWith(
      { error: { type: "run-failed", message: "Actor run did not succeed" } },
      400,
    );

    await expect(createApifyCalendar("token", fetchImpl)(window)).rejects.toThrow();
  });

  it("이번 달 남은 무료 사용 금액을 돌려주고, 확인하지 못하면 null을 돌려준다", async () => {
    const ok = respondWith({
      data: {
        limits: { maxMonthlyUsageUsd: 5 },
        current: { monthlyUsageUsd: 0.35 },
      },
    });
    expect(await fetchApifyRemainingUsd("token", ok.fetchImpl)).toBeCloseTo(4.65);

    const bad = respondWith({ error: { type: "token-not-valid" } }, 401);
    expect(await fetchApifyRemainingUsd("bad", bad.fetchImpl)).toBeNull();
  });
});

describe("SerpApi 항공사", () => {
  it("가장 싼 항공편의 가는 편 항공사를 돌려준다", async () => {
    const { fetchImpl, requests } = respondWith({
      best_flights: [
        { price: 273700, flights: [{ airline: "티웨이항공" }] },
        { price: 249900, flights: [{ airline: "진에어" }] },
      ],
      other_flights: [
        { price: 260000, flights: [{ airline: "제주항공" }, { airline: "제주항공" }] },
      ],
    });

    const airline = await createSerpApiAirline("key", fetchImpl)({
      origin: "PUS",
      destination: "KIX",
      departure: "2026-11-17",
      return: "2026-11-19",
    });

    expect(airline).toBe("진에어");
    const url = new URL(requests[0].url);
    expect(url.searchParams.get("engine")).toBe("google_flights");
    expect(url.searchParams.get("outbound_date")).toBe("2026-11-17");
    expect(url.searchParams.get("return_date")).toBe("2026-11-19");
    expect(url.searchParams.get("currency")).toBe("KRW");
  });

  it("응답이 실패하면 오류를 던진다", async () => {
    const { fetchImpl } = respondWith({ error: "Invalid API key." }, 401);

    await expect(
      createSerpApiAirline("bad", fetchImpl)({
        origin: "PUS",
        destination: "KIX",
        departure: "2026-11-17",
        return: "2026-11-19",
      }),
    ).rejects.toThrow();
  });
});
