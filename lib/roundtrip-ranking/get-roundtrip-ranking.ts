import type {
  CalendarFare,
  CalendarQuery,
  FlightDetails,
  FlightPriceSource,
  MonthRanking,
  RankedTrip,
  Route,
  RoundtripRanking,
  TicketKind,
} from "./types";

const MONTHS = ["2026-11", "2026-12"];
const MIN_NIGHTS = 2;
const MAX_NIGHTS = 3;
const TRIPS_PER_MONTH = 3;

const FIRST_DEPARTURE = "2026-11-01";
const LAST_DEPARTURE = "2026-12-31";
// The provider rejects calendar requests over 200 date pairs:
// 13 departure days x 14 return days = 182.
const DEPARTURE_DAYS_PER_REQUEST = 13;

const DAY_MS = 86_400_000;

const NO_DETAILS: FlightDetails = { airline: null, outbound: null, inbound: null };

/** A dated trip at its cheapest ticketing, before flight details are looked up. */
type PricedTrip = CalendarFare & {
  ticket: TicketKind;
  outboundPrice: number | null;
  inboundPrice: number | null;
};

function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function calendarWindows(route: Route): CalendarQuery[] {
  const windows: CalendarQuery[] = [];
  for (
    let start = FIRST_DEPARTURE;
    start <= LAST_DEPARTURE;
    start = addDays(start, DEPARTURE_DAYS_PER_REQUEST)
  ) {
    const lastInWindow = addDays(start, DEPARTURE_DAYS_PER_REQUEST - 1);
    const end = lastInWindow < LAST_DEPARTURE ? lastInWindow : LAST_DEPARTURE;
    windows.push({
      ...route,
      outboundStart: start,
      outboundEnd: end,
      returnStart: addDays(start, MIN_NIGHTS),
      returnEnd: addDays(end, MAX_NIGHTS),
    });
  }
  return windows;
}

function cheapestFirst(a: CalendarFare, b: CalendarFare) {
  return a.price - b.price || a.departure.localeCompare(b.departure);
}

/**
 * Every 2–3 night date pair priced at whichever is cheaper: one round-trip
 * ticket or two one-way tickets (possibly different airlines). Ties keep the
 * round trip.
 */
function priceTrips(
  roundTrips: CalendarFare[],
  outbound: Map<string, number>,
  inbound: Map<string, number>,
): PricedTrip[] {
  const roundTripPrice = new Map(
    roundTrips.map((f) => [`${f.departure}|${f.return}`, f.price]),
  );
  const trips: PricedTrip[] = [];
  for (let day = FIRST_DEPARTURE; day <= LAST_DEPARTURE; day = addDays(day, 1)) {
    for (let nights = MIN_NIGHTS; nights <= MAX_NIGHTS; nights++) {
      const ret = addDays(day, nights);
      const rt = roundTripPrice.get(`${day}|${ret}`);
      const out = outbound.get(day);
      const back = inbound.get(ret);
      const oneWays = out !== undefined && back !== undefined ? out + back : undefined;

      if (rt !== undefined && (oneWays === undefined || rt <= oneWays)) {
        trips.push({ departure: day, return: ret, price: rt, ticket: "roundTrip", outboundPrice: null, inboundPrice: null });
      } else if (oneWays !== undefined) {
        trips.push({ departure: day, return: ret, price: oneWays, ticket: "oneWays", outboundPrice: out!, inboundPrice: back! });
      }
    }
  }
  return trips;
}

export async function getRoundtripRanking(
  route: Route,
  source: FlightPriceSource,
): Promise<RoundtripRanking> {
  const back = { origin: route.destination, destination: route.origin };
  const [roundTrips, outboundFares, inboundFares] = await Promise.all([
    Promise.all(calendarWindows(route).map((q) => source.calendar(q))).then((r) => r.flat()),
    source.oneWayCalendar({ ...route, start: FIRST_DEPARTURE, end: LAST_DEPARTURE }),
    source.oneWayCalendar({
      ...back,
      start: addDays(FIRST_DEPARTURE, MIN_NIGHTS),
      end: addDays(LAST_DEPARTURE, MAX_NIGHTS),
    }),
  ]);

  const trips = priceTrips(
    roundTrips,
    new Map(outboundFares.map((f) => [f.date, f.price])),
    new Map(inboundFares.map((f) => [f.date, f.price])),
  );

  /**
   * Re-checks a candidate in the Korean market (round trip and both one-ways)
   * and keeps whichever is cheaper there. Each lookup costs search credits, so
   * only candidates get one; a failed check keeps the overseas price.
   */
  async function inKoreanMarket(trip: PricedTrip): Promise<RankedTrip> {
    const [rt, out, ret] = await Promise.all([
      source.flight({ ...route, departure: trip.departure, return: trip.return }).catch(() => null),
      source.oneWayFlight({ ...route, date: trip.departure }).catch(() => null),
      source.oneWayFlight({ ...back, date: trip.return }).catch(() => null),
    ]);
    const dates = { departure: trip.departure, return: trip.return };
    const rtPrice = rt?.price ?? null;
    const oneWaysPrice =
      out?.price != null && ret?.price != null ? out.price + ret.price : null;

    if (rt && rtPrice !== null && (oneWaysPrice === null || rtPrice <= oneWaysPrice)) {
      return {
        ...dates,
        price: rtPrice,
        ticket: "roundTrip",
        outboundPrice: null,
        inboundPrice: null,
        market: "KR",
        airline: rt.airline,
        outbound: rt.outbound,
        inbound: rt.inbound,
      };
    }
    if (oneWaysPrice !== null) {
      return {
        ...dates,
        price: oneWaysPrice,
        ticket: "oneWays",
        outboundPrice: out!.price,
        inboundPrice: ret!.price,
        market: "KR",
        airline: out!.leg?.airline ?? null,
        outbound: out!.leg,
        inbound: ret!.leg,
      };
    }

    const details: FlightDetails =
      trip.ticket === "roundTrip"
        ? rt
          ? { airline: rt.airline, outbound: rt.outbound, inbound: rt.inbound }
          : NO_DETAILS
        : { airline: out?.leg?.airline ?? null, outbound: out?.leg ?? null, inbound: ret?.leg ?? null };
    return { ...trip, market: "overseas", ...details };
  }

  const months: MonthRanking[] = await Promise.all(
    MONTHS.map(async (month) => {
      const candidates = trips
        .filter((trip) => trip.departure.startsWith(month))
        .sort(cheapestFirst)
        .slice(0, TRIPS_PER_MONTH);

      const ranked = (await Promise.all(candidates.map(inKoreanMarket))).sort(cheapestFirst);
      return { month, trips: ranked };
    }),
  );

  return { months };
}
