import type {
  CalendarFare,
  CalendarQuery,
  FlightLeg,
  LegQuery,
  OneWayFare,
  OneWayOffer,
  OneWayQuery,
  RoundTripOffer,
  TripQuery,
} from "./types";

const APIFY_ACTOR_RUN =
  "https://api.apify.com/v2/acts/apt_marble~google-flights-cheapest-date-finder/run-sync-get-dataset-items";
const APIFY_LIMITS = "https://api.apify.com/v2/users/me/limits";
const SERPAPI_SEARCH = "https://serpapi.com/search.json";

// A 13-day round-trip window returns about 26 rows: $0.03 + 26 x $0.0015 ≈ $0.07.
// A one-way run over about 62 days returns about 62 rows: ≈ $0.09.
const MAX_CHARGE_PER_RUN_USD = "0.2";

type ApifyRow = {
  outboundDate?: string;
  returnDate?: string;
  price?: number | null;
  currencyMatchesRequest?: boolean;
};

// The Apify free plan rejects a sixth concurrent actor run (HTTP 402), so every
// run in this process waits for a slot.
const MAX_CONCURRENT_ACTOR_RUNS = 5;
let runningActors = 0;
const waitingForSlot: (() => void)[] = [];

async function withActorSlot<T>(run: () => Promise<T>): Promise<T> {
  if (runningActors >= MAX_CONCURRENT_ACTOR_RUNS) {
    await new Promise<void>((resolve) => waitingForSlot.push(resolve));
  }
  runningActors += 1;
  try {
    return await run();
  } finally {
    runningActors -= 1;
    waitingForSlot.shift()?.();
  }
}

type ApifyOptions = {
  /** Wait before the single retry of a failed run (failed runs are not charged). */
  retryDelayMs?: number;
};

// Google Flights sometimes refuses a grid for a few seconds ("search allowance
// spent"); a failed run costs nothing, so one later retry is worth it.
const DEFAULT_RETRY_DELAY_MS = 10_000;

/** Runs the Google Flights calendar actor, retrying once, and returns rows priced in KRW. */
async function runCalendarActor(
  token: string,
  fetchImpl: typeof fetch,
  input: Record<string, unknown>,
  { retryDelayMs = DEFAULT_RETRY_DELAY_MS }: ApifyOptions = {},
) {
  try {
    return await withActorSlot(() => runCalendarActorNow(token, fetchImpl, input));
  } catch {
    // Wait outside the slot so other runs can proceed meanwhile.
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return withActorSlot(() => runCalendarActorNow(token, fetchImpl, input));
  }
}

async function runCalendarActorNow(
  token: string,
  fetchImpl: typeof fetch,
  input: Record<string, unknown>,
): Promise<(ApifyRow & { price: number; outboundDate: string })[]> {
  const url = new URL(APIFY_ACTOR_RUN);
  url.searchParams.set("timeout", "280");
  url.searchParams.set("maxTotalChargeUsd", MAX_CHARGE_PER_RUN_USD);

  const response = await fetchImpl(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...input,
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

  return (body as ApifyRow[]).filter(
    (row): row is ApifyRow & { price: number; outboundDate: string } =>
      typeof row.price === "number" &&
      row.currencyMatchesRequest !== false &&
      Boolean(row.outboundDate),
  );
}

/** Round-trip price grid for one window, from the Apify Google Flights calendar actor. */
export function createApifyCalendar(
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: ApifyOptions = {},
) {
  return async (query: CalendarQuery): Promise<CalendarFare[]> => {
    const rows = await runCalendarActor(token, fetchImpl, {
      origin: query.origin,
      destination: query.destination,
      tripType: "roundTrip",
      dateRangeStart: query.outboundStart,
      dateRangeEnd: query.outboundEnd,
      returnRangeStart: query.returnStart,
      returnRangeEnd: query.returnEnd,
      minTripLengthNights: 2,
      maxTripLengthNights: 3,
    }, options);
    return rows
      .filter((row) => row.returnDate)
      .map((row) => ({
        departure: row.outboundDate,
        return: row.returnDate!,
        price: row.price,
      }));
  };
}

/** Cheapest one-way fare per date for one direction (up to 200 days per run). */
export function createApifyOneWayCalendar(
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: ApifyOptions = {},
) {
  return async (query: OneWayQuery): Promise<OneWayFare[]> => {
    const rows = await runCalendarActor(token, fetchImpl, {
      origin: query.origin,
      destination: query.destination,
      tripType: "oneWay",
      dateRangeStart: query.start,
      dateRangeEnd: query.end,
    }, options);
    return rows.map((row) => ({ date: row.outboundDate, price: row.price }));
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

type Segment = {
  airline?: string;
  flight_number?: string;
  departure_airport?: { time?: string };
  arrival_airport?: { time?: string };
};

type FlightOption = {
  price?: number;
  departure_token?: string;
  flights?: Segment[];
};

function cheapestOption(body: { best_flights?: FlightOption[]; other_flights?: FlightOption[] }) {
  const options = [...(body.best_flights ?? []), ...(body.other_flights ?? [])].filter(
    (o) => typeof o.price === "number",
  );
  if (options.length === 0) return null;
  return options.reduce((a, b) => (b.price! < a.price! ? b : a));
}

const joinUnique = (values: (string | undefined)[]) => {
  const unique = [...new Set(values.filter((v): v is string => Boolean(v)))];
  return unique.length > 0 ? unique.join(" · ") : null;
};

/** One direction from its segments: first departure, last arrival. */
function legOf(option: FlightOption | null): FlightLeg | null {
  const segments = option?.flights ?? [];
  const departAt = segments[0]?.departure_airport?.time;
  const arriveAt = segments.at(-1)?.arrival_airport?.time;
  if (!departAt || !arriveAt) return null;
  return {
    departAt,
    arriveAt,
    flightNumber: joinUnique(segments.map((s) => s.flight_number)),
    airline: joinUnique(segments.map((s) => s.airline)),
  };
}

/** One SerpApi Google Flights search; each call costs one credit. */
async function serpApiSearch(
  apiKey: string,
  fetchImpl: typeof fetch,
  params: Record<string, string>,
) {
  const url = new URL(SERPAPI_SEARCH);
  const all = {
    engine: "google_flights",
    currency: "KRW",
    gl: "kr",
    hl: "ko",
    ...params,
    api_key: apiKey,
  };
  for (const [key, value] of Object.entries(all)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchImpl(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(
      `SerpApi google_flights failed (${response.status}): ${body.error ?? "unknown error"}`,
    );
  }
  return body;
}

/**
 * Korean-market price, airline and both legs of the cheapest round trip on
 * given dates, from SerpApi Google Flights. The outbound search costs one
 * credit and the return search, made with the cheapest option's
 * departure_token, costs one more.
 */
export function createSerpApiFlight(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
) {
  const search = (query: TripQuery, extra: Record<string, string> = {}) =>
    serpApiSearch(apiKey, fetchImpl, {
      type: "1",
      departure_id: query.origin,
      arrival_id: query.destination,
      outbound_date: query.departure,
      return_date: query.return,
      ...extra,
    });

  return async (query: TripQuery): Promise<RoundTripOffer> => {
    const outboundOption = cheapestOption(await search(query));
    const outbound = legOf(outboundOption);

    // A failed return search keeps the outbound details already paid for.
    const token = outboundOption?.departure_token;
    const inbound = token
      ? await search(query, { departure_token: token })
          .then((body) => legOf(cheapestOption(body)))
          .catch(() => null)
      : null;

    return {
      // The outbound search already prices the whole round trip.
      price: outboundOption?.price ?? null,
      airline: outbound?.airline ?? null,
      outbound,
      inbound,
    };
  };
}

/** Korean-market cheapest one-way flight on a date, from SerpApi Google Flights (one credit). */
export function createSerpApiOneWayFlight(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (query: LegQuery): Promise<OneWayOffer | null> => {
    const option = cheapestOption(
      await serpApiSearch(apiKey, fetchImpl, {
        type: "2",
        departure_id: query.origin,
        arrival_id: query.destination,
        outbound_date: query.date,
      }),
    );
    return option ? { price: option.price ?? null, leg: legOf(option) } : null;
  };
}
