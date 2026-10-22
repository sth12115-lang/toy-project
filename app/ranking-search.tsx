"use client";

import { useActionState, useEffect, useState } from "react";
import { CalendarXIcon, CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import {
  DESTINATION_AIRPORT,
  ORIGIN_AIRPORT,
  type MonthRanking,
  type FlightLeg,
  type RankedTrip,
  type RoundtripRanking,
} from "@/lib/roundtrip-ranking";

export type SearchState =
  | { status: "idle" }
  | {
      status: "success";
      ranking: RoundtripRanking;
      fetchedAt: number;
      cached: boolean;
      refreshFailed: boolean;
      cacheExpiresAt: number | null;
      remainingUsd: number | null;
    }
  | {
      status: "error";
      message: string;
      cacheExpiresAt: number | null;
      remainingUsd: number | null;
    };

// Five 13-day round-trip windows (~$0.35) plus one one-way run per direction (~$0.18).
const USD_PER_REFRESH = 0.53;

type SearchAction = (
  previous: SearchState,
  formData: FormData,
) => Promise<SearchState>;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function formatDay(date: string) {
  const [, month, day] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${month}월 ${day}일 (${weekday})`;
}

function formatMonth(month: string) {
  const [year, m] = month.split("-").map(Number);
  return `${year}년 ${m}월`;
}

function nightsOf(trip: RankedTrip) {
  return Math.round(
    (Date.parse(trip.return) - Date.parse(trip.departure)) / 86_400_000,
  );
}

function ago(fetchedAt: number) {
  const minutes = Math.floor((Date.now() - fetchedAt) / 60_000);
  const hours = Math.floor(minutes / 60);
  if (minutes < 1) return "1분 안에";
  return hours < 1 ? `${minutes}분 전에` : `${hours}시간 ${minutes % 60}분 전에`;
}

function freshnessLabel(state: Extract<SearchState, { status: "success" }>) {
  if (!state.cached) return "방금 받아 온 가격입니다.";
  return `${ago(state.fetchedAt)} 받아 온 저장된 가격입니다. 가격은 12시간마다 새로 받아 옵니다.`;
}

function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "1분 미만";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}

/** Current time, refreshed once a minute so countdowns stay current. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function NextRefresh({ expiresAt }: { expiresAt: number | null }) {
  const now = useMinuteClock();
  const left = expiresAt === null ? 0 : expiresAt - now;
  return (
    <p className="text-sm text-muted-foreground" suppressHydrationWarning>
      {left > 0
        ? `다음 갱신까지 ${formatDuration(left)} 남았습니다. 그 전에는 저장된 가격을 보여 드립니다.`
        : "지금 조회하면 새 가격을 받아 옵니다."}
    </p>
  );
}

function RemainingRefreshes({ usd }: { usd: number | null }) {
  return (
    <p className="text-sm text-muted-foreground">
      {usd === null
        ? "이번 달 남은 갱신 횟수를 확인하지 못했습니다."
        : `이번 달 남은 갱신 ${Math.floor(usd / USD_PER_REFRESH + 1e-9)}회`}
    </p>
  );
}

const timeOf = (localDateTime: string) => localDateTime.slice(11, 16);

function legText(
  leg: FlightLeg | null | undefined,
  from: string,
  to: string,
  tripAirline: string | null,
) {
  if (!leg) return "시각 정보 없음";
  const parts = [`${timeOf(leg.departAt)} ${from} → ${timeOf(leg.arriveAt)} ${to}`];
  if (leg.flightNumber) parts.push(leg.flightNumber);
  // Name the airline here only when it differs from the trip's (outbound) airline.
  if (leg.airline && leg.airline !== tripAirline) parts.push(leg.airline);
  return parts.join(" · ");
}

function TripLegs({ trip }: { trip: RankedTrip }) {
  // Rankings stored before flight times existed have no leg fields at all.
  const rows = [
    ["가는 편", legText(trip.outbound, "김해", "간사이", trip.airline)],
    ["오는 편", legText(trip.inbound, "간사이", "김해", trip.airline)],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted-foreground">
      {rows.map(([label, text]) => (
        <div key={label} className="contents">
          <dt className="font-medium">{label}</dt>
          <dd className="tabular-nums">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

function TripItem({ trip, rank }: { trip: RankedTrip; rank: number }) {
  const nights = nightsOf(trip);
  return (
    <Item variant="outline" role="listitem">
      <ItemMedia className="w-10 font-heading text-base font-semibold">
        {rank}위
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap gap-x-1">
          <span className="whitespace-nowrap">{formatDay(trip.departure)}</span>
          <span> – </span>
          <span className="whitespace-nowrap">{formatDay(trip.return)}</span>
        </ItemTitle>
        <ItemDescription>
          {nights}박 {nights + 1}일 ·{" "}
          {trip.airline ?? "항공사 정보 없음"} ·{" "}
          {/* Rankings stored before one-way comparison have no ticket field. */}
          {trip.ticket === "oneWays" ? "편도 2장" : "왕복 1장"}
        </ItemDescription>
        <TripLegs trip={trip} />
      </ItemContent>
      <div className="flex flex-col items-end gap-0.5 text-right">
        <div className="font-heading text-base font-semibold tabular-nums">
          {trip.price.toLocaleString("ko-KR")}원
        </div>
        {trip.ticket === "oneWays" && (
          <div className="text-xs text-muted-foreground tabular-nums">
            가는 편 {trip.outboundPrice?.toLocaleString("ko-KR")}원 + 오는 편{" "}
            {trip.inboundPrice?.toLocaleString("ko-KR")}원
          </div>
        )}
        {trip.market === "overseas" && (
          <div className="text-xs text-muted-foreground">
            해외 시장 가격(한국 시장 확인 실패)
          </div>
        )}
      </div>
    </Item>
  );
}

function MonthSection({ month }: { month: MonthRanking }) {
  const titleId = `month-${month.month}`;
  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardHeader>
          <CardTitle id={titleId}>{formatMonth(month.month)}</CardTitle>
          <CardDescription>출발일 기준 최저가 왕복 일정</CardDescription>
        </CardHeader>
        <CardContent>
          {month.trips.length > 0 ? (
            <ItemGroup className="gap-2">
              {month.trips.map((trip, i) => (
                <TripItem
                  key={`${trip.departure}-${trip.return}`}
                  trip={trip}
                  rank={i + 1}
                />
              ))}
            </ItemGroup>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarXIcon />
                </EmptyMedia>
                <EmptyTitle>조건에 맞는 일정이 없습니다</EmptyTitle>
                <EmptyDescription>
                  이 달에는 2박 3일–3박 4일 왕복 가격을 찾지 못했습니다.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function RankingSearch({
  action,
  initialRemainingUsd,
  initialCacheExpiresAt = null,
}: {
  action: SearchAction;
  initialRemainingUsd: number | null;
  initialCacheExpiresAt?: number | null;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  });
  const remainingUsd =
    state.status === "idle" ? initialRemainingUsd : state.remainingUsd;
  const cacheExpiresAt =
    state.status === "idle" ? initialCacheExpiresAt : state.cacheExpiresAt;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent>
          <form
            action={formAction}
            className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">노선</span>
              <span className="font-medium">
                {ORIGIN_AIRPORT.name} ({ORIGIN_AIRPORT.code}) →{" "}
                {DESTINATION_AIRPORT.name} ({DESTINATION_AIRPORT.code})
              </span>
            </div>
            <Button
              type="submit"
              size="lg"
              disabled={pending}
              className="sm:w-auto"
            >
              {pending ? (
                <>
                  <Spinner data-icon="inline-start" />
                  조회 중…
                </>
              ) : (
                "최저가 조회"
              )}
            </Button>
          </form>
          <div className="mt-4 flex flex-col gap-1">
            <RemainingRefreshes usd={remainingUsd} />
            {/* Remount on a new expiry so the clock restarts from now. */}
            <NextRefresh
              key={cacheExpiresAt ?? "none"}
              expiresAt={cacheExpiresAt}
            />
          </div>
        </CardContent>
      </Card>

      {state.status === "error" && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>가격을 불러오지 못했습니다</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "success" && (
        <div className="flex flex-col gap-3">
          {state.refreshFailed && (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>새 가격을 받아 오지 못했습니다</AlertTitle>
              <AlertDescription>
                새 가격을 받아 오지 못해 {ago(state.fetchedAt)} 받아 온 가격을
                보여 드립니다. 이번 달 무료 사용량을 다 썼다면 다음 달에 다시
                받아 옵니다.
              </AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            {freshnessLabel(state)}
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            {state.ranking.months.map((month) => (
              <MonthSection key={month.month} month={month} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
