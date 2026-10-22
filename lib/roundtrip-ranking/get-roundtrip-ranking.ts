import type {
  CalendarFare,
  CalendarQuery,
  FlightPriceSource,
  MonthRanking,
  Route,
  RoundtripRanking,
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

function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function nightsOf(fare: CalendarFare) {
  return Math.round((Date.parse(fare.return) - Date.parse(fare.departure)) / DAY_MS);
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

export async function getRoundtripRanking(
  route: Route,
  source: FlightPriceSource,
): Promise<RoundtripRanking> {
  const fares = (
    await Promise.all(calendarWindows(route).map((q) => source.calendar(q)))
  ).flat();

  const eligible = fares.filter((fare) => {
    const nights = nightsOf(fare);
    return nights >= MIN_NIGHTS && nights <= MAX_NIGHTS;
  });

  const months: MonthRanking[] = await Promise.all(
    MONTHS.map(async (month) => {
      const top = eligible
        .filter((fare) => fare.departure.startsWith(month))
        .sort(cheapestFirst)
        .slice(0, TRIPS_PER_MONTH);

      // Each airline lookup costs a search credit; only ranked trips get one.
      // A failed lookup leaves that airline empty so the paid prices are kept.
      const trips = await Promise.all(
        top.map(async (fare) => ({
          ...fare,
          airline: await source
            .airline({ ...route, departure: fare.departure, return: fare.return })
            .catch(() => null),
        })),
      );

      return { month, trips };
    }),
  );

  return { months };
}
