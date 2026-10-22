import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import Home from "@/app/page";

vi.mock("@/app/actions", () => ({
  searchRanking: vi.fn(),
  getRemainingUsd: vi.fn(async () => 5),
  getCacheExpiresAt: vi.fn(async () => null),
}));

test("홈 화면은 부산-오사카 제목과 최저가 조회 버튼, 이번 달 남은 갱신 횟수를 보여준다", async () => {
  render(await Home());

  expect(
    screen.getByRole("heading", {
      level: 1,
      name: "부산-오사카 월별 최저가 왕복 항공권",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "최저가 조회" }),
  ).toBeInTheDocument();
  expect(screen.getByText("이번 달 남은 갱신 14회")).toBeInTheDocument();
});
