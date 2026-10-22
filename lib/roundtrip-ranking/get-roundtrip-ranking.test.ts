import { describe, expect, it } from "vitest";

import {
  getRoundtripRanking,
  type CalendarFare,
  type CalendarQuery,
  type FlightPriceSource,
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

function fakeSource(
  fares: CalendarFare[],
  airline: FlightPriceSource["airline"] = async () => "에어부산",
): FlightPriceSource {
  return {
    async calendar(query) {
      return inWindow(fares, query);
    },
    airline,
  };
}

const route = { origin: "PUS", destination: "KIX" } as const;

describe("getRoundtripRanking", () => {
  it("달마다 2박 3일과 3박 4일 왕복 일정을 싼 순서로 최대 3개 보여 준다", async () => {
    const source = fakeSource([
      { departure: "2026-11-02", return: "2026-11-04", price: 249400 },
      { departure: "2026-11-10", return: "2026-11-12", price: 259900 },
      { departure: "2026-11-02", return: "2026-11-05", price: 269400 },
      { departure: "2026-11-03", return: "2026-11-05", price: 279400 },
      { departure: "2026-12-05", return: "2026-12-08", price: 310000 },
      { departure: "2026-12-12", return: "2026-12-14", price: 300000 },
    ]);

    const ranking = await getRoundtripRanking(route, source);

    expect(ranking.months.map((m) => m.month)).toEqual(["2026-11", "2026-12"]);
    expect(ranking.months[0].trips.map((t) => t.price)).toEqual([
      249400, 259900, 269400,
    ]);
    expect(ranking.months[1].trips.map((t) => t.price)).toEqual([
      300000, 310000,
    ]);
  });

  it("가격이 같으면 출발일이 이른 일정을 앞에 둔다", async () => {
    const source = fakeSource([
      { departure: "2026-11-20", return: "2026-11-22", price: 250000 },
      { departure: "2026-11-05", return: "2026-11-08", price: 250000 },
      { departure: "2026-11-12", return: "2026-11-14", price: 250000 },
    ]);

    const ranking = await getRoundtripRanking(route, source);

    expect(ranking.months[0].trips.map((t) => t.departure)).toEqual([
      "2026-11-05",
      "2026-11-12",
      "2026-11-20",
    ]);
  });

  it("순위에 든 일정 모두의 항공사를 조회해 함께 보여 준다", async () => {
    const asked: string[] = [];
    const source = fakeSource(
      [
        { departure: "2026-11-02", return: "2026-11-04", price: 249400 },
        { departure: "2026-11-03", return: "2026-11-05", price: 279400 },
        { departure: "2026-11-09", return: "2026-11-11", price: 288700 },
        { departure: "2026-11-16", return: "2026-11-18", price: 299000 },
      ],
      async ({ departure }) => {
        asked.push(departure);
        return departure === "2026-11-02" ? "에어부산" : "제주항공";
      },
    );

    const ranking = await getRoundtripRanking(route, source);

    expect(ranking.months[0].trips.map((t) => t.airline)).toEqual([
      "에어부산",
      "제주항공",
      "제주항공",
    ]);
    // Only ranked trips are looked up; the 4th and the empty December are not.
    expect(asked.sort()).toEqual(["2026-11-02", "2026-11-03", "2026-11-09"]);
  });

  it("항공사 조회가 실패한 일정은 항공사를 비워 두고 순위는 그대로 돌려준다", async () => {
    const source = fakeSource(
      [
        { departure: "2026-11-02", return: "2026-11-04", price: 249400 },
        { departure: "2026-11-03", return: "2026-11-05", price: 279400 },
      ],
      async ({ departure }) => {
        if (departure === "2026-11-03") throw new Error("SerpApi failed");
        return "에어부산";
      },
    );

    const ranking = await getRoundtripRanking(route, source);

    expect(ranking.months[0].trips).toEqual([
      { departure: "2026-11-02", return: "2026-11-04", price: 249400, airline: "에어부산" },
      { departure: "2026-11-03", return: "2026-11-05", price: 279400, airline: null },
    ]);
  });

  it("가격 조회가 실패하면 오류를 그대로 던진다", async () => {
    const source: FlightPriceSource = {
      async calendar() {
        throw new Error("Apify failed");
      },
      async airline() {
        return "에어부산";
      },
    };

    await expect(getRoundtripRanking(route, source)).rejects.toThrow("Apify failed");
  });

  it("캘린더 요청마다 날짜 조합을 200개 이하로 나눠 11–12월 출발 2–3박 일정을 모두 덮는다", async () => {
    const queries: CalendarQuery[] = [];
    const source: FlightPriceSource = {
      async calendar(query) {
        queries.push(query);
        return [];
      },
      async airline() {
        return null;
      },
    };

    await getRoundtripRanking(route, source);

    const days = (from: string, to: string) =>
      (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    for (const q of queries) {
      expect(
        days(q.outboundStart, q.outboundEnd) * days(q.returnStart, q.returnEnd),
      ).toBeLessThanOrEqual(200);
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
});
