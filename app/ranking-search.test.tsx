import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RankingSearch, type SearchState } from "@/app/ranking-search";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

type Success = Extract<SearchState, { status: "success" }>;

function success(overrides: Partial<Success> = {}): SearchState {
  return {
    status: "success",
    ranking: {
      months: [
        {
          month: "2026-11",
          trips: [
            {
              departure: "2026-11-02",
              return: "2026-11-04",
              price: 249400,
              ticket: "roundTrip",
              outboundPrice: null,
              inboundPrice: null,
              market: "KR",
              airline: "에어부산",
              outbound: { departAt: "2026-11-02 08:35", arriveAt: "2026-11-02 10:00", flightNumber: "BX 122", airline: "에어부산" },
              inbound: { departAt: "2026-11-04 11:00", arriveAt: "2026-11-04 12:30", flightNumber: "LJ 612", airline: "진에어" },
            },
            {
              departure: "2026-11-09",
              return: "2026-11-11",
              price: 253874,
              ticket: "oneWays",
              outboundPrice: 103900,
              inboundPrice: 149974,
              market: "KR",
              airline: "제주항공",
              outbound: { departAt: "2026-11-09 07:00", arriveAt: "2026-11-09 08:25", flightNumber: "7C 1353", airline: "제주항공" },
              inbound: null,
            },
            { departure: "2026-11-16", return: "2026-11-18", price: 269400, ticket: "roundTrip", outboundPrice: null, inboundPrice: null, market: "overseas", airline: null, outbound: null, inbound: null },
          ],
        },
        { month: "2026-12", trips: [] },
      ],
    },
    fetchedAt: Date.now(),
    cached: false,
    refreshFailed: false,
    cacheExpiresAt: Date.now() + 12 * HOUR,
    remainingUsd: 4.3,
    ...overrides,
  };
}

const search = () =>
  fireEvent.click(screen.getByRole("button", { name: "최저가 조회" }));

function renderSearch(
  action: () => Promise<SearchState>,
  initial: { remainingUsd?: number | null; cacheExpiresAt?: number | null } = {},
) {
  return render(
    <RankingSearch
      action={action}
      initialRemainingUsd={initial.remainingUsd === undefined ? 5 : initial.remainingUsd}
      initialCacheExpiresAt={initial.cacheExpiresAt ?? null}
    />,
  );
}

describe("RankingSearch", () => {
  it("노선은 김해→간사이로 고정되어 글로 보이고, 공항을 고르는 입력은 없다", () => {
    renderSearch(async () => success());

    expect(
      screen.getByText("부산 김해 (PUS) → 오사카 간사이 (KIX)"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "최저가 조회" })).toBeEnabled();
  });

  it("조회하면 달마다 순위와 1–3위 항공사를 보여 주고, 일정이 없는 달은 빈 상태를 보여 준다", async () => {
    renderSearch(async () => success());

    search();

    const november = await screen.findByRole("region", { name: "2026년 11월" });
    const [first, second, third] = within(november).getAllByRole("listitem");
    expect(first).toHaveTextContent("1위");
    expect(first).toHaveTextContent("11월 2일 (월) – 11월 4일 (수)");
    expect(first).toHaveTextContent("2박 3일");
    expect(first).toHaveTextContent("249,400원");
    expect(first).toHaveTextContent("에어부산");
    expect(second).toHaveTextContent("제주항공");
    expect(third).toHaveTextContent("항공사 정보 없음");

    expect(first).toHaveTextContent("가는 편08:35 김해 → 10:00 간사이 · BX 122");
    // A return airline that differs from the outbound one is named on its line.
    expect(first).toHaveTextContent("오는 편11:00 간사이 → 12:30 김해 · LJ 612 · 진에어");
    expect(second).toHaveTextContent("가는 편07:00 김해 → 08:25 간사이 · 7C 1353");
    expect(second).toHaveTextContent("오는 편시각 정보 없음");

    expect(first).toHaveTextContent("왕복 1장");
    expect(second).toHaveTextContent("편도 2장");
    expect(second).toHaveTextContent("253,874원");
    expect(second).toHaveTextContent("가는 편 103,900원 + 오는 편 149,974원");
    expect(first).not.toHaveTextContent("편도 2장");

    // Only a trip the Korean market could not re-check says so.
    expect(third).toHaveTextContent("해외 시장 가격");
    expect(first).not.toHaveTextContent("해외 시장 가격");
    expect(third).toHaveTextContent("가는 편시각 정보 없음");

    const december = screen.getByRole("region", { name: "2026년 12월" });
    expect(december).toHaveTextContent("조건에 맞는 일정이 없습니다");
  });

  it("시각 정보가 없는 예전 저장 결과도 시각 정보 없음으로 보여 준다", async () => {
    const legacy = success();
    if (legacy.status === "success") {
      legacy.ranking.months[0].trips = [
        // Stored before flight times existed: no outbound/inbound fields at all.
        { departure: "2026-11-02", return: "2026-11-04", price: 249400, airline: "에어부산" } as never,
      ];
    }
    renderSearch(async () => legacy);

    search();

    const november = await screen.findByRole("region", { name: "2026년 11월" });
    const [only] = within(november).getAllByRole("listitem");
    expect(only).toHaveTextContent("에어부산");
    expect(only).toHaveTextContent("가는 편시각 정보 없음");
    expect(only).toHaveTextContent("오는 편시각 정보 없음");
    // Stored before one-way comparison existed: treated as one round-trip ticket.
    expect(only).toHaveTextContent("왕복 1장");
  });

  it("조회하는 동안에는 진행 중임을 보여 주고 다시 조회할 수 없다", async () => {
    let finish: (state: SearchState) => void = () => {};
    renderSearch(() => new Promise<SearchState>((resolve) => (finish = resolve)));

    search();

    const button = await screen.findByRole("button", { name: /조회 중/ });
    expect(button).toBeDisabled();

    finish(success());
    await screen.findByRole("region", { name: "2026년 11월" });
  });

  it("저장된 순위 없이 실패하면 안내를 보여 주고 이전 결과를 남기지 않는다", async () => {
    const results: SearchState[] = [
      success(),
      {
        status: "error",
        message: "가격을 불러오지 못했습니다.",
        cacheExpiresAt: null,
        remainingUsd: 4.3,
      },
    ];
    renderSearch(async () => results.shift()!);

    search();
    await screen.findByRole("region", { name: "2026년 11월" });

    search();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "가격을 불러오지 못했습니다.",
      ),
    );
    expect(screen.queryByRole("region", { name: "2026년 11월" })).toBeNull();
  });

  it("새로 받아 오지 못하면 저장된 순위를 계속 보여 주며 그 사실을 알린다", async () => {
    renderSearch(async () =>
      success({ cached: true, refreshFailed: true, fetchedAt: Date.now() - 26 * HOUR }),
    );

    search();

    expect(
      await screen.findByText(/새 가격을 받아 오지 못해 26시간 0분 전에 받아 온 가격을 보여 드립니다/),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "2026년 11월" })).toBeInTheDocument();
  });

  it("저장된 순위는 언제 받아 온 가격인지 보여 준다", async () => {
    renderSearch(async () =>
      success({ cached: true, fetchedAt: Date.now() - 125 * MINUTE }),
    );

    search();

    expect(
      await screen.findByText(/2시간 5분 전에 받아 온 저장된 가격입니다.*12시간마다/),
    ).toBeInTheDocument();
  });

  it("새로 받아 온 순위는 방금 받아 온 가격이라고 보여 준다", async () => {
    renderSearch(async () => success({ cached: false }));

    search();

    expect(await screen.findByText(/방금 받아 온 가격입니다/)).toBeInTheDocument();
  });

  it("다음 갱신까지 남은 시간을 보여 주고 1분마다 줄인다", () => {
    vi.useFakeTimers();
    try {
      renderSearch(async () => success(), {
        cacheExpiresAt: Date.now() + (5 * 60 + 12) * MINUTE + 30_000,
      });

      expect(screen.getByText(/다음 갱신까지 5시간 12분 남았습니다/)).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(MINUTE));

      expect(screen.getByText(/다음 갱신까지 5시간 11분 남았습니다/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("저장된 순위가 없으면 지금 조회하면 새 가격을 받아 온다고 보여 준다", () => {
    renderSearch(async () => success(), { cacheExpiresAt: null });

    expect(
      screen.getByText("지금 조회하면 새 가격을 받아 옵니다."),
    ).toBeInTheDocument();
  });

  it("이번 달 남은 갱신 횟수를 보여 주고, 조회한 뒤 최신 값으로 바꾼다", async () => {
    // $5.00 / $0.53 = 9, $4.30 / $0.53 = 8
    renderSearch(async () => success({ remainingUsd: 4.3 }), { remainingUsd: 5 });

    expect(screen.getByText("이번 달 남은 갱신 9회")).toBeInTheDocument();

    search();

    expect(await screen.findByText("이번 달 남은 갱신 8회")).toBeInTheDocument();
  });

  it("남은 갱신 횟수를 확인하지 못하면 그렇게 표시하고 조회는 할 수 있다", () => {
    renderSearch(async () => success(), { remainingUsd: null });

    expect(
      screen.getByText("이번 달 남은 갱신 횟수를 확인하지 못했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "최저가 조회" })).toBeEnabled();
  });
});
