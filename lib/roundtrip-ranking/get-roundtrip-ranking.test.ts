import { describe, expect, it } from "vitest";

import {
  getRoundtripRanking,
  type CalendarFare,
  type CalendarQuery,
  type FlightLeg,
  type FlightPriceSource,
  type OneWayFare,
  type OneWayQuery,
} from "@/lib/roundtrip-ranking";

// Like the real provider, a calendar request returns only fares inside its window.
function inWindow(fares: CalendarFare[], q: CalendarQuery) {
  return fares.filter(
    (f) =>
      q.outboundStart <= f.departure &&
      f.departure <= q.outboundEnd &&
      q.returnStart <= f.return &&
      f.return <= q.returnEnd,
  );
}

const leg = (departAt: string, arriveAt: string, flightNumber: string, airline: string): FlightLeg => ({
  departAt,
  arriveAt,
  flightNumber,
  airline,
});

const OUT_LEG = leg("2026-11-02 08:30", "2026-11-02 10:05", "BX 607", "에어부산");
const BACK_LEG = leg("2026-11-04 11:00", "2026-11-04 13:00", "BX 608", "에어부산");

type Fake = {
  roundTrips?: CalendarFare[];
  outFares?: OneWayFare[];
  backFares?: OneWayFare[];
  /** Korean-market round-trip price per "departure|return"; missing means none offered. */
  krRoundTrip?: Record<string, number>;
  /** Korean-market one-way price per "ORIGIN date"; missing means none offered. */
  krOneWay?: Record<string, number>;
  flight?: FlightPriceSource["flight"];
  oneWayFlight?: FlightPriceSource["oneWayFlight"];
};

function fakeSource(fake: Fake = {}): FlightPriceSource {
  return {
    async calendar(query) {
      return inWindow(fake.roundTrips ?? [], query);
    },
    async oneWayCalendar(query) {
      return (query.origin === "PUS" ? fake.outFares : fake.backFares) ?? [];
    },
    flight:
      fake.flight ??
      (async ({ departure, return: ret }) => ({
        price: fake.krRoundTrip?.[`${departure}|${ret}`] ?? null,
        airline: "에어부산",
        outbound: OUT_LEG,
        inbound: BACK_LEG,
      })),
    oneWayFlight:
      fake.oneWayFlight ??
      (async ({ origin, date }) => {
        const price = fake.krOneWay?.[`${origin} ${date}`];
        return price === undefined
          ? null
          : { price, leg: origin === "PUS" ? OUT_LEG : BACK_LEG };
      }),
  };
}

const route = { origin: "PUS", destination: "KIX" } as const;

describe("getRoundtripRanking", () => {
  it("달마다 2박 3일과 3박 4일 일정을 싼 순서로 최대 3개 보여 준다", async () => {
    const source = fakeSource({
      roundTrips: [
        { departure: "2026-11-02", return: "2026-11-04", price: 249400 },
        { departure: "2026-11-10", return: "2026-11-12", price: 259900 },
        { departure: "2026-11-02", return: "2026-11-05", price: 269400 },
        { departure: "2026-11-03", return: "2026-11-05", price: 279400 },
        { departure: "2026-12-05", return: "2026-12-08", price: 310000 },
        { departure: "2026-12-12", return: "2026-12-14", price: 300000 },
      ],
    });

    const ranking = await getRoundtripRanking(route, source);

    expect(ranking.months.map((m) => m.month)).toEqual(["2026-11", "2026-12"]);
    expect(ranking.months[0].trips.map((t) => t.price)).toEqual([249400, 259900, 269400]);
    expect(ranking.months[1].trips.map((t) => t.price)).toEqual([300000, 310000]);
  });

  it("가격이 같으면 출발일이 이른 일정을 앞에 둔다", async () => {
    const source = fakeSource({
      roundTrips: [
        { departure: "2026-11-20", return: "2026-11-22", price: 250000 },
        { departure: "2026-11-05", return: "2026-11-08", price: 250000 },
        { departure: "2026-11-12", return: "2026-11-14", price: 250000 },
      ],
    });

    const ranking = await getRoundtripRanking(route, source);

    expect(ranking.months[0].trips.map((t) => t.departure)).toEqual([
      "2026-11-05",
      "2026-11-12",
      "2026-11-20",
    ]);
  });

  it("캘린더 요청마다 날짜 조합을 200개 이하로 나눠 11–12월 출발 2–3박 일정을 모두 덮는다", async () => {
    const queries: CalendarQuery[] = [];
    const source = fakeSource();
    source.calendar = async (query) => {
      queries.push(query);
      return [];
    };

    await getRoundtripRanking(route, source);

    const days = (from: string, to: string) =>
      (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    for (const q of queries) {
      expect(days(q.outboundStart, q.outboundEnd) * days(q.returnStart, q.returnEnd)).toBeLessThanOrEqual(200);
    }

    const covers = (departure: string, ret: string) =>
      queries.some(
        (q) =>
          q.outboundStart <= departure &&
          departure <= q.outboundEnd &&
          q.returnStart <= ret &&
          ret <= q.returnEnd,
      );
    const plus = (date: string, n: number) =>
      new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
    for (let d = "2026-11-01"; d <= "2026-12-31"; d = plus(d, 1)) {
      expect(covers(d, plus(d, 2)), `${d} 2박`).toBe(true);
      expect(covers(d, plus(d, 3)), `${d} 3박`).toBe(true);
    }
  });

  it("가격 조회가 실패하면 오류를 그대로 던진다", async () => {
    const source = fakeSource();
    source.calendar = async () => {
      throw new Error("Apify failed");
    };

    await expect(getRoundtripRanking(route, source)).rejects.toThrow("Apify failed");
  });

  describe("왕복 한 장과 편도 두 장 비교", () => {
    it("편도 두 장 합계가 더 싸면 편도 2장으로 고르고 방향별 가격을 남긴다", async () => {
      const source = fakeSource({
        roundTrips: [{ departure: "2026-11-02", return: "2026-11-04", price: 249400 }],
        outFares: [{ date: "2026-11-02", price: 100000 }],
        backFares: [{ date: "2026-11-04", price: 120000 }],
      });

      const [trip] = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trip).toMatchObject({
        price: 220000,
        ticket: "oneWays",
        outboundPrice: 100000,
        inboundPrice: 120000,
      });
    });

    it("두 가격이 같으면 왕복 한 장을 고른다", async () => {
      const source = fakeSource({
        roundTrips: [{ departure: "2026-11-02", return: "2026-11-04", price: 220000 }],
        outFares: [{ date: "2026-11-02", price: 100000 }],
        backFares: [{ date: "2026-11-04", price: 120000 }],
      });

      const [trip] = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trip.ticket).toBe("roundTrip");
    });

    it("왕복 가격이 없는 날짜도 편도 두 장이 있으면 2–3박 일정으로 순위에 넣는다", async () => {
      const source = fakeSource({
        outFares: [{ date: "2026-12-07", price: 103900 }],
        backFares: [
          { date: "2026-12-08", price: 90000 },
          { date: "2026-12-09", price: 133151 },
          { date: "2026-12-10", price: 140000 },
          { date: "2026-12-11", price: 80000 },
        ],
      });

      const trips = (await getRoundtripRanking(route, source)).months[1].trips;

      // 1 night (12-08) and 4 nights (12-11) are out of range.
      expect(trips.map((t) => [t.return, t.price])).toEqual([
        ["2026-12-09", 237051],
        ["2026-12-10", 243900],
      ]);
    });

    it("편도 가격은 가는 방향 11/1–12/31, 오는 방향 11/3–1/3으로 한 번씩 요청한다", async () => {
      const queries: OneWayQuery[] = [];
      const source = fakeSource();
      source.oneWayCalendar = async (query) => {
        queries.push(query);
        return [];
      };

      await getRoundtripRanking(route, source);

      expect(queries).toEqual(
        expect.arrayContaining([
          { origin: "PUS", destination: "KIX", start: "2026-11-01", end: "2026-12-31" },
          { origin: "KIX", destination: "PUS", start: "2026-11-03", end: "2027-01-03" },
        ]),
      );
      expect(queries).toHaveLength(2);
    });
  });

  describe("한국 시장 가격 다시 확인", () => {
    it("후보마다 한국 시장 왕복·편도 가격을 다시 확인해, 더 싼 쪽의 한국 시장 가격과 항공편으로 보여 준다", async () => {
      const source = fakeSource({
        roundTrips: [{ departure: "2026-11-02", return: "2026-11-04", price: 249400 }],
        outFares: [{ date: "2026-11-02", price: 118900 }],
        backFares: [{ date: "2026-11-04", price: 145768 }],
        // In the Korean market the one-ways are cheaper than the round trip.
        krRoundTrip: { "2026-11-02|2026-11-04": 249400 },
        krOneWay: { "PUS 2026-11-02": 103900, "KIX 2026-11-04": 138726 },
      });

      const [trip] = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trip).toMatchObject({
        price: 242626,
        ticket: "oneWays",
        outboundPrice: 103900,
        inboundPrice: 138726,
        market: "KR",
        airline: "에어부산",
        outbound: OUT_LEG,
        inbound: BACK_LEG,
      });
    });

    it("한국 시장 가격으로 후보 순서를 다시 매긴다", async () => {
      const source = fakeSource({
        roundTrips: [
          { departure: "2026-11-02", return: "2026-11-04", price: 200000 },
          { departure: "2026-11-09", return: "2026-11-11", price: 210000 },
        ],
        krRoundTrip: {
          "2026-11-02|2026-11-04": 260000,
          "2026-11-09|2026-11-11": 205000,
        },
      });

      const trips = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trips.map((t) => [t.departure, t.price])).toEqual([
        ["2026-11-09", 205000],
        ["2026-11-02", 260000],
      ]);
    });

    it("달마다 후보 5개를 한국 시장으로 확인하고, 그중 싼 3개를 보여 준다", async () => {
      const asked: string[] = [];
      const dates = ["02", "03", "09", "10", "16", "17"];
      const source = fakeSource({
        // Overseas prices rise with the date; the 6th is never checked.
        roundTrips: dates.map((d, i) => ({
          departure: `2026-11-${d}`,
          return: `2026-11-${String(Number(d) + 2).padStart(2, "0")}`,
          price: 200000 + i * 10000,
        })),
        flight: async ({ departure }) => {
          asked.push(departure);
          // In the Korean market the 5th candidate is the cheapest.
          const price = departure === "2026-11-16" ? 150000 : 260000;
          return { price, airline: null, outbound: null, inbound: null };
        },
      });

      const trips = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(asked.sort()).toEqual(["2026-11-02", "2026-11-03", "2026-11-09", "2026-11-10", "2026-11-16"]);
      expect(trips).toHaveLength(3);
      expect(trips[0]).toMatchObject({ departure: "2026-11-16", price: 150000 });
    });

    it("한국 시장 가격을 확인하지 못하면 해외 시장 가격을 그대로 쓰고 그렇게 표시한다", async () => {
      const source = fakeSource({
        roundTrips: [{ departure: "2026-11-02", return: "2026-11-04", price: 249400 }],
        flight: async () => {
          throw new Error("SerpApi failed");
        },
        oneWayFlight: async () => {
          throw new Error("SerpApi failed");
        },
      });

      const [trip] = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trip).toMatchObject({
        price: 249400,
        ticket: "roundTrip",
        market: "overseas",
        airline: null,
        outbound: null,
        inbound: null,
      });
    });

    it("왕복으로 고른 일정에서 비어 있는 오는 편 시각은 이미 받은 편도 항공편으로 채우고 그렇게 표시한다", async () => {
      const source = fakeSource({
        roundTrips: [{ departure: "2026-11-30", return: "2026-12-02", price: 249400 }],
        flight: async () => ({ price: 228660, airline: "이스타항공", outbound: OUT_LEG, inbound: null }),
        krOneWay: { "PUS 2026-11-30": 130000, "KIX 2026-12-02": 140000 },
      });

      const [trip] = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trip.ticket).toBe("roundTrip");
      expect(trip.outbound).toEqual(OUT_LEG);
      expect(trip.inbound).toEqual({ ...BACK_LEG, fromOneWay: true });
    });

    it("한국 시장 왕복 가격만 확인되면 왕복으로 보여 준다", async () => {
      const source = fakeSource({
        outFares: [{ date: "2026-11-02", price: 100000 }],
        backFares: [{ date: "2026-11-04", price: 120000 }],
        krRoundTrip: { "2026-11-02|2026-11-04": 230000 },
      });

      const [trip] = (await getRoundtripRanking(route, source)).months[0].trips;

      expect(trip).toMatchObject({ price: 230000, ticket: "roundTrip", market: "KR" });
    });
  });
});
