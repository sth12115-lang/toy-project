import type { CalendarFare, CalendarQuery, TripQuery } from "./types";

const APIFY_ACTOR_RUN =
  "https://api.apify.com/v2/acts/apt_marble~google-flights-cheapest-date-finder/run-sync-get-dataset-items";
const APIFY_LIMITS = "https://api.apify.com/v2/users/me/limits";
const SERPAPI_SEARCH = "https://serpapi.com/search.json";

// One 13-day window returns about 26 rows: $0.03 + 26 x $0.0015 ≈ $0.07.
const MAX_CHARGE_PER_WINDOW_USD = "0.2";

type ApifyRow = {
  outboundDate?: string;
  returnDate?: string;
  price?: number | null;
  currencyMatchesRequest?: boolean;
};

/** Round-trip price grid for one window, from the Apify Google Flights calendar actor. */
export function createApifyCalendar(
  token: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (query: CalendarQuery): Promise<CalendarFare[]> => {
    const url = new URL(APIFY_ACTOR_RUN);
    url.searchParams.set("timeout", "280");
    url.searchParams.set("maxTotalChargeUsd", MAX_CHARGE_PER_WINDOW_USD);

    const response = await fetchImpl(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: query.origin,
        destination: query.destination,
        tripType: "roundTrip",
        dateRangeStart: query.outboundStart,
        dateRangeEnd: query.outboundEnd,
        returnRangeStart: query.returnStart,
        returnRangeEnd: query.returnEnd,
        minTripLengthNights: 2,
        maxTripLengthNights: 3,
        currency: "KRW",
        adults: 1,
        cabinClass: "economy",
        includeDatesWithoutFares: false,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body)) {
      throw new Error(
        `Apify calendar failed (${response.status}): ${body?.error?.message ?? "unexpected response"}`,
      );
    }

    return (body as ApifyRow[])
      .filter(
        (row) =>
          typeof row.price === "number" &&
          row.currencyMatchesRequest !== false &&
          row.outboundDate &&
          row.returnDate,
      )
      .map((row) => ({
        departure: row.outboundDate!,
        return: row.returnDate!,
        price: row.price!,
      }));
  };
}

/** Free usage left this month in USD, or null when it cannot be read. Costs nothing. */
export async function fetchApifyRemainingUsd(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const response = await fetchImpl(APIFY_LIMITS, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const data = (await response.json())?.data;
    const max = data?.limits?.maxMonthlyUsageUsd;
    const used = data?.current?.monthlyUsageUsd;
    return typeof max === "number" && typeof used === "number"
      ? Math.max(0, max - used)
      : null;
  } catch {
    return null;
  }
}

type FlightOption = {
  price?: number;
  flights?: { airline?: string }[];
};

/** Outbound airline of the cheapest round trip on given dates, from SerpApi Google Flights. */
export function createSerpApiAirline(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (query: TripQuery): Promise<string | null> => {
    const url = new URL(SERPAPI_SEARCH);
    const params = {
      engine: "google_flights",
      type: "1",
      departure_id: query.origin,
      arrival_id: query.destination,
      outbound_date: query.departure,
      return_date: query.return,
      currency: "KRW",
      gl: "kr",
      hl: "ko",
      api_key: apiKey,
    };
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetchImpl(url, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(
        `SerpApi google_flights failed (${response.status}): ${body.error ?? "unknown error"}`,
      );
    }

    const options: FlightOption[] = [
      ...(body.best_flights ?? []),
      ...(body.other_flights ?? []),
    ].filter((o: FlightOption) => typeof o.price === "number");
    if (options.length === 0) return null;

    const cheapest = options.reduce((a, b) => (b.price! < a.price! ? b : a));
    // `flights` holds only the outbound legs.
    const airlines = [
      ...new Set((cheapest.flights ?? []).flatMap((f) => f.airline ?? [])),
    ];
    return airlines.length > 0 ? airlines.join(" · ") : null;
  };
}
