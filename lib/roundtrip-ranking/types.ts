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

/** Boundary to the external flight price provider. */
export type FlightPriceSource = {
  calendar(query: CalendarQuery): Promise<CalendarFare[]>;
  airline(query: TripQuery): Promise<string | null>;
};

export type RankedTrip = CalendarFare & {
  /** Outbound airline; null when the provider could not name one. */
  airline: string | null;
};

export type MonthRanking = {
  month: string;
  trips: RankedTrip[];
};

export type RoundtripRanking = {
  months: MonthRanking[];
};
