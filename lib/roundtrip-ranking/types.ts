export type Route = {
  origin: string;
  destination: string;
};

/** One round-trip price for a departure/return date pair. */
export type CalendarFare = {
  departure: string;
  return: string;
  price: number;
};

export type CalendarQuery = Route & {
  outboundStart: string;
  outboundEnd: string;
  returnStart: string;
  returnEnd: string;
};

export type TripQuery = Route & {
  departure: string;
  return: string;
};

/** One direction of the cheapest round trip on given dates. */
export type FlightLeg = {
  /** Local time at the departure airport, "YYYY-MM-DD HH:mm". */
  departAt: string;
  /** Local time at the arrival airport, "YYYY-MM-DD HH:mm". */
  arriveAt: string;
  flightNumber: string | null;
  airline: string | null;
  /**
   * True when a round trip's leg was filled from that day's cheapest one-way
   * flight, which may not be the flight the round-trip ticket uses.
   */
  fromOneWay?: boolean;
};

export type FlightDetails = {
  /** Outbound airline; null when the provider could not name one. */
  airline: string | null;
  outbound: FlightLeg | null;
  inbound: FlightLeg | null;
};

/** Cheapest one-way fares per departure date, for one direction. */
export type OneWayQuery = Route & {
  start: string;
  end: string;
};

export type OneWayFare = {
  date: string;
  price: number;
};

/** One direction on one date. */
export type LegQuery = Route & {
  date: string;
};

/** Korean-market cheapest round trip on given dates, with its flights. */
export type RoundTripOffer = FlightDetails & {
  price: number | null;
};

/** Korean-market cheapest one-way flight on a date. */
export type OneWayOffer = {
  price: number | null;
  leg: FlightLeg | null;
};

/**
 * Boundary to the external flight price providers. The calendars cover every
 * date in an overseas market; the offers re-check single dates in the Korean market.
 */
export type FlightPriceSource = {
  calendar(query: CalendarQuery): Promise<CalendarFare[]>;
  oneWayCalendar(query: OneWayQuery): Promise<OneWayFare[]>;
  flight(query: TripQuery): Promise<RoundTripOffer>;
  /** null when no one-way flight is offered on that date. */
  oneWayFlight(query: LegQuery): Promise<OneWayOffer | null>;
};

/** One round-trip ticket, or two one-way tickets bought separately. */
export type TicketKind = "roundTrip" | "oneWays";

/** "KR" once re-checked in the Korean market; "overseas" when that check failed. */
export type PriceMarket = "KR" | "overseas";

export type RankedTrip = CalendarFare &
  FlightDetails & {
    ticket: TicketKind;
    /** One-way prices when ticket is "oneWays"; null for a round trip. */
    outboundPrice: number | null;
    inboundPrice: number | null;
    market: PriceMarket;
  };

export type MonthRanking = {
  month: string;
  trips: RankedTrip[];
};

export type RoundtripRanking = {
  months: MonthRanking[];
};
