import { expect, test } from "@playwright/test";

test("홈 화면이 열리고 부산-오사카 제목과 고정 노선이 보인다", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("FCA");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "부산-오사카 월별 최저가 왕복 항공권",
  );
  await expect(
    page.getByText("부산 김해 (PUS) → 오사카 간사이 (KIX)"),
  ).toBeVisible();
});
