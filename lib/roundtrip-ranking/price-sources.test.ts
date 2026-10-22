import { describe, expect, it } from "vitest";

import {
  createApifyCalendar,
  createApifyOneWayCalendar,
  createSerpApiFlight,
  createSerpApiOneWayFlight,
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

    await expect(createApifyCalendar("token", fetchImpl, { retryDelayMs: 0 })(window)).rejects.toThrow();
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

describe("SerpApi 항공편", () => {
  const trip = {
    origin: "PUS",
    destination: "KIX",
    departure: "2026-11-17",
    return: "2026-11-19",
  };

  const segment = (
    airline: string,
    flightNumber: string,
    from: string,
    departAt: string,
    to: string,
    arriveAt: string,
  ) => ({
    airline,
    flight_number: flightNumber,
    departure_airport: { id: from, time: departAt },
    arrival_airport: { id: to, time: arriveAt },
  });

  // Answers the outbound search, then the return search made with departure_token.
  function serpApi(returnStatus = 200) {
    const requests: URL[] = [];
    const fetchImpl = (async (url: URL | string) => {
      const u = new URL(String(url));
      requests.push(u);
      const isReturn = u.searchParams.has("departure_token");
      const body = isReturn
        ? returnStatus === 200
          ? {
              best_flights: [
                { price: 299900, flights: [segment("진에어", "LJ 616", "KIX", "2026-11-19 16:25", "PUS", "2026-11-19 18:05")] },
                { price: 249900, flights: [segment("진에어", "LJ 612", "KIX", "2026-11-19 11:00", "PUS", "2026-11-19 12:30")] },
              ],
            }
          : { error: "Temporary failure" }
        : {
            best_flights: [
              { price: 273700, departure_token: "tw", flights: [segment("티웨이항공", "TW 301", "PUS", "2026-11-17 07:00", "KIX", "2026-11-17 08:30")] },
              { price: 249900, departure_token: "lj", flights: [segment("진에어", "LJ 611", "PUS", "2026-11-17 08:35", "KIX", "2026-11-17 10:00")] },
            ],
          };
      return new Response(JSON.stringify(body), {
        status: isReturn ? returnStatus : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fetchImpl, requests };
  }

  it("한국 시장 왕복 최저가와 그 항공편의 항공사, 가는 편·오는 편 시각을 돌려준다", async () => {
    const { fetchImpl, requests } = serpApi();

    const details = await createSerpApiFlight("key", fetchImpl)(trip);

    expect(details).toEqual({
      price: 249900,
      airline: "진에어",
      outbound: { departAt: "2026-11-17 08:35", arriveAt: "2026-11-17 10:00", flightNumber: "LJ 611", airline: "진에어" },
      inbound: { departAt: "2026-11-19 11:00", arriveAt: "2026-11-19 12:30", flightNumber: "LJ 612", airline: "진에어" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.get("outbound_date")).toBe("2026-11-17");
    expect(requests[0].searchParams.get("currency")).toBe("KRW");
    expect(requests[0].searchParams.get("gl")).toBe("kr");
    expect(requests[1].searchParams.get("departure_token")).toBe("lj");
  });

  it("오는 편 조회만 실패하면 가는 편 정보는 남기고 오는 편만 비운다", async () => {
    const { fetchImpl } = serpApi(500);

    const details = await createSerpApiFlight("key", fetchImpl)(trip);

    expect(details.airline).toBe("진에어");
    expect(details.outbound?.flightNumber).toBe("LJ 611");
    expect(details.inbound).toBeNull();
  });

  it("가는 편 조회가 실패하면 오류를 던진다", async () => {
    const { fetchImpl } = respondWith({ error: "Invalid API key." }, 401);

    await expect(createSerpApiFlight("bad", fetchImpl)(trip)).rejects.toThrow();
  });
});

describe("Apify 편도 캘린더", () => {
  it("한 방향의 기간을 편도 원화로 묻고, 날짜별 가격을 돌려준다", async () => {
    const { fetchImpl, requests } = respondWith([
      { outboundDate: "2026-11-03", price: 149974, currency: "KRW", currencyMatchesRequest: true },
      { outboundDate: "2026-11-04", price: null, currency: "KRW" },
    ]);

    const fares = await createApifyOneWayCalendar("token", fetchImpl)({
      origin: "KIX",
      destination: "PUS",
      start: "2026-11-03",
      end: "2027-01-03",
    });

    expect(fares).toEqual([{ date: "2026-11-03", price: 149974 }]);
    const input = JSON.parse(String(requests[0].init?.body));
    expect(input).toMatchObject({
      origin: "KIX",
      destination: "PUS",
      tripType: "oneWay",
      dateRangeStart: "2026-11-03",
      dateRangeEnd: "2027-01-03",
      currency: "KRW",
    });
    expect(input).not.toHaveProperty("returnRangeStart");
  });
});

describe("SerpApi 편도 항공편", () => {
  it("그 날짜 한국 시장 편도 최저가와 그 항공편의 시각·편명·항공사를 편도로 묻는다", async () => {
    const { fetchImpl, requests } = respondWith({
      best_flights: [
        {
          price: 149974,
          flights: [
            {
              airline: "이스타항공",
              flight_number: "ZE 914",
              departure_airport: { id: "KIX", time: "2026-11-04 10:50" },
              arrival_airport: { id: "PUS", time: "2026-11-04 12:20" },
            },
          ],
        },
      ],
    });

    const leg = await createSerpApiOneWayFlight("key", fetchImpl)({
      origin: "KIX",
      destination: "PUS",
      date: "2026-11-04",
    });

    expect(leg).toEqual({
      price: 149974,
      leg: {
        departAt: "2026-11-04 10:50",
        arriveAt: "2026-11-04 12:20",
        flightNumber: "ZE 914",
        airline: "이스타항공",
      },
    });
    const url = new URL(requests[0].url);
    expect(url.searchParams.get("type")).toBe("2");
    expect(url.searchParams.get("departure_id")).toBe("KIX");
    expect(url.searchParams.get("outbound_date")).toBe("2026-11-04");
    expect(url.searchParams.has("return_date")).toBe(false);
  });

  it("응답이 실패하면 오류를 던진다", async () => {
    const { fetchImpl } = respondWith({ error: "Invalid API key." }, 401);

    await expect(
      createSerpApiOneWayFlight("bad", fetchImpl)({ origin: "PUS", destination: "KIX", date: "2026-11-02" }),
    ).rejects.toThrow();
  });
});

describe("Apify 동시 실행 한도", () => {
  it("왕복·편도 캘린더를 함께 요청해도 actor는 동시에 5개까지만 실행한다", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const calendar = createApifyCalendar("token", fetchImpl);
    const oneWay = createApifyOneWayCalendar("token", fetchImpl);

    await Promise.all([
      ...Array.from({ length: 5 }, () => calendar(window)),
      oneWay({ origin: "PUS", destination: "KIX", start: "2026-11-01", end: "2026-12-31" }),
      oneWay({ origin: "KIX", destination: "PUS", start: "2026-11-03", end: "2027-01-03" }),
    ]);

    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});

describe("SerpApi 편도 항공편 없음", () => {
  it("그 날짜에 편도 항공편이 없으면 null을 돌려준다", async () => {
    const { fetchImpl } = respondWith({ best_flights: [], other_flights: [] });

    const offer = await createSerpApiOneWayFlight("key", fetchImpl)({
      origin: "PUS",
      destination: "KIX",
      date: "2026-11-02",
    });

    expect(offer).toBeNull();
  });
});

describe("Apify 일시 거부 재시도", () => {
  const failedRun = () =>
    new Response(JSON.stringify({ error: { type: "run-failed", message: "Actor run did not succeed" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  const okRun = () =>
    new Response(JSON.stringify([{ outboundDate: "2026-11-17", returnDate: "2026-11-19", price: 249900 }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("실행이 한 번 실패하면 잠시 뒤 한 번 더 시도해 그 결과를 돌려준다", async () => {
    const responses = [failedRun(), okRun()];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return responses.shift()!;
    }) as typeof fetch;

    const fares = await createApifyCalendar("token", fetchImpl, { retryDelayMs: 0 })(window);

    expect(calls).toBe(2);
    expect(fares).toEqual([{ departure: "2026-11-17", return: "2026-11-19", price: 249900 }]);
  });

  it("다시 시도해도 실패하면 오류를 던진다", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return failedRun();
    }) as typeof fetch;

    await expect(
      createApifyCalendar("token", fetchImpl, { retryDelayMs: 0 })(window),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

