import {
  comparisonValue,
  previousPeriod,
} from "@/server/features/ga4/services/Ga4ReportEnhancements";
import {
  ONYXMETRIC_TIME_ZONE,
  type OnyxmetricOverview,
} from "@/server/lib/onyxmetricClient";
import {
  loadOnyxmetricContext,
  mapOnyxmetricError,
  ORGANIC_SEARCH_FILTERS,
  resolveOnyxmetricDateRange,
} from "./OnyxmetricReportService";

export const ONYXMETRIC_OVERVIEW_METRICS = [
  "sessions",
  "users",
  "pageviews",
  "pagesPerSession",
  "bounceRate",
  "sessionDuration",
] as const satisfies ReadonlyArray<keyof OnyxmetricOverview>;

function metricComparison(
  current: OnyxmetricOverview | null,
  previous: OnyxmetricOverview | null,
) {
  return Object.fromEntries(
    ONYXMETRIC_OVERVIEW_METRICS.map((metric) => [
      metric,
      comparisonValue(current?.[metric] ?? null, previous?.[metric] ?? null),
    ]),
  );
}

/** A period with no sessions comes back as zeros or no row; treat both as "no
 *  data" so the comparison shows null instead of a misleading 0. */
function orNull(row: OnyxmetricOverview | null): OnyxmetricOverview | null {
  return row && row.sessions ? row : null;
}

async function getOrganicOverview(
  input: {
    projectId: string;
    startDate?: string;
    endDate?: string;
    trend?: "daily" | "weekly";
  },
  opts: { now?: Date } = {},
) {
  const dateRange = resolveOnyxmetricDateRange(input, opts.now);
  const previousDateRange = previousPeriod(dateRange.resolvedDateRange);
  const trend = input.trend ?? "daily";
  try {
    const { connection, client } = await loadOnyxmetricContext(input.projectId);
    const siteId = connection.siteId;
    const range = dateRange.resolvedDateRange;
    const [current, previous, allChannels, trendRows] = await Promise.all([
      client.getOverview({ siteId, range, filters: ORGANIC_SEARCH_FILTERS }),
      client.getOverview({
        siteId,
        range: previousDateRange,
        filters: ORGANIC_SEARCH_FILTERS,
      }),
      client.getOverview({ siteId, range }),
      client.getTimeSeries({
        siteId,
        range,
        bucket: trend === "weekly" ? "week" : "day",
        filters: ORGANIC_SEARCH_FILTERS,
      }),
    ]);
    const currentSummary = orNull(current);
    const previousSummary = orNull(previous);
    const allSessions = allChannels?.sessions ?? null;
    return {
      status: "ok" as const,
      source: {
        provider: "onyxmetric" as const,
        siteId,
        siteName: connection.siteName,
      },
      request: {
        requestedDateRange: dateRange.requestedDateRange,
        resolvedDateRange: range,
        previousDateRange,
        timeZone: ONYXMETRIC_TIME_ZONE,
        channel: "organic_search" as const,
        trend,
      },
      current: currentSummary,
      previous: previousSummary,
      comparison: metricComparison(currentSummary, previousSummary),
      // Same period across every channel, for the organic share of traffic.
      allChannels: {
        current: orNull(allChannels),
        organicShareOfSessions:
          allSessions && currentSummary?.sessions != null
            ? currentSummary.sessions / allSessions
            : null,
      },
      trend: trendRows,
      diagnostics: [] as Array<Record<string, unknown>>,
      reportMetadata: { hasLimitedData: false },
      quota: null,
      warnings: dateRange.warnings,
    };
  } catch (error) {
    mapOnyxmetricError(error);
  }
}

export const OnyxmetricOverviewService = { getOrganicOverview };
