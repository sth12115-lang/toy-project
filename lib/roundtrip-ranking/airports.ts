import type { Route } from "./types";

export type Airport = {
  code: string;
  name: string;
};

// The user only looks up Busan (Gimhae) to Osaka (Kansai).
export const ORIGIN_AIRPORT: Airport = { code: "PUS", name: "부산 김해" };
export const DESTINATION_AIRPORT: Airport = { code: "KIX", name: "오사카 간사이" };

export const FIXED_ROUTE: Route = {
  origin: ORIGIN_AIRPORT.code,
  destination: DESTINATION_AIRPORT.code,
};
