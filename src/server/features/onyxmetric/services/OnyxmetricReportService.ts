import {
  createOnyxmetricClient,
  ONYXMETRIC_TIME_ZONE,
  type OnyxmetricDateRange,
  type OnyxmetricFilter,
  type OnyxmetricMetricParameter,
} from "@/server/lib/onyxmetricClient";
import {
  OnyxmetricApiError,
  OnyxmetricMalformedResponseError,
  OnyxmetricNotConfiguredError,
  OnyxmetricReportError,
} from "@/server/lib/onyxmetricErrors";
import { OnyxmetricConnectionRepository } from "@/server/features/onyxmetric/repositories/OnyxmetricConnectionRepository";
import {
  ga4DateInTimeZone,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";

type OnyxmetricChannel = "organic_search" | "all";
export type OnyxmetricBreakdownKind =
  | "landing_pages"
  | "channels"
  | "referrers"
  | "countries"
  | "devices"
  | "pages";

type OnyxmetricReportInput = {
  projectId: string;
  kind: OnyxmetricBreakdownKind;
  startDate?: string;
  endDate?: string;
  limit?: number;
  page?: number;
  channel?: OnyxmetricChannel;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const ORGANIC_SEARCH_CHANNEL = "Organic Search";

export const ORGANIC_SEARCH_FILTERS: OnyxmetricFilter[] = [
  { parameter: "channel", type: "equals", value: [ORGANIC_SEARCH_CHANNEL] },
];

// `organicOnly` reports ignore the channel argument: landing pages and search
// referrers only mean something for Organic Search, and the channel report is
// the all-channel view by definition.
const BREAKDOWNS: Record<
  OnyxmetricBreakdownKind,
  {
    parameter: OnyxmetricMetricParameter;
    key: string;
    channel: "organic_search" | "all" | "selectable";
  }
> = {
  landing_pages: {
    parameter: "entry_page",
    key: "landingPage",
    channel: "organic_search",
  },
  channels: { parameter: "channel", key: "channel", channel: "all" },
  referrers: {
    parameter: "referrer",
    key: "referrer",
    channel: "organic_search",
  },
  countries: { parameter: "country", key: "country", channel: "selectable" },
  devices: {
    parameter: "device_type",
    key: "deviceType",
    channel: "selectable",
  },
  pages: { parameter: "pathname", key: "pagePath", channel: "selectable" },
};

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

/** Default: the last 28 complete UTC days. An end date in the future is moved
 *  back so an incomplete day never skews the period comparison. */
export function resolveOnyxmetricDateRange(
  input: { startDate?: string; endDate?: string },
  now: Date = new Date(),
) {
  if (Boolean(input.startDate) !== Boolean(input.endDate)) {
    throw new OnyxmetricReportError(
      "validation_error",
      "Provide both startDate and endDate, or neither.",
    );
  }
  const requestedDateRange =
    input.startDate && input.endDate
      ? { startDate: input.startDate, endDate: input.endDate }
      : null;
  if (
    requestedDateRange &&
    (!isValidDate(requestedDateRange.startDate) ||
      !isValidDate(requestedDateRange.endDate) ||
      requestedDateRange.startDate > requestedDateRange.endDate)
  ) {
    throw new OnyxmetricReportError(
      "validation_error",
      "Dates must be valid YYYY-MM-DD values with startDate on or before endDate.",
    );
  }
  const lastCompleteDay = shiftGa4Date(
    ga4DateInTimeZone(now, ONYXMETRIC_TIME_ZONE),
    -1,
  );
  let endDate = requestedDateRange?.endDate ?? lastCompleteDay;
  const startDate = requestedDateRange?.startDate ?? shiftGa4Date(endDate, -27);
  const warnings: string[] = [];
  if (endDate > lastCompleteDay) {
    endDate = lastCompleteDay;
    warnings.push("end_date_clamped");
  }
  if (startDate > endDate) {
    throw new OnyxmetricReportError(
      "validation_error",
      "The resolved startDate is after the last complete day.",
    );
  }
  return {
    requestedDateRange,
    resolvedDateRange: { startDate, endDate } satisfies OnyxmetricDateRange,
    warnings,
  };
}

export function mapOnyxmetricError(error: unknown): never {
  if (error instanceof OnyxmetricReportError) throw error;
  if (error instanceof OnyxmetricNotConfiguredError) {
    throw new OnyxmetricReportError(
      "onyxmetric_not_configured",
      "OnyxMetric is not configured on this server.",
    );
  }
  if (error instanceof OnyxmetricMalformedResponseError) {
    throw new OnyxmetricReportError(
      "onyxmetric_malformed_response",
      "OnyxMetric returned an invalid report.",
    );
  }
  if (error instanceof OnyxmetricApiError) {
    if (error.status === 400) {
      throw new OnyxmetricReportError(
        "validation_error",
        "OnyxMetric rejected this report request.",
      );
    }
    if (error.status === 401) {
      throw new OnyxmetricReportError(
        "onyxmetric_auth_failed",
        "OnyxMetric rejected this server's API key.",
      );
    }
    if (error.status === 403 || error.status === 404) {
      throw new OnyxmetricReportError(
        "onyxmetric_site_inaccessible",
        "The connected OnyxMetric site is no longer available to this server's API key.",
      );
    }
    if (error.status === 429) {
      throw new OnyxmetricReportError(
        "onyxmetric_rate_limited",
        "OnyxMetric rate limit exceeded. Try again later.",
        error.retryAfterSeconds,
      );
    }
    throw new OnyxmetricReportError(
      "onyxmetric_upstream_unavailable",
      "OnyxMetric is temporarily unavailable.",
    );
  }
  throw error;
}

/** Project's saved site plus a ready client; shared by every report. */
export async function loadOnyxmetricContext(projectId: string) {
  const connection =
    await OnyxmetricConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new OnyxmetricReportError(
      "onyxmetric_not_connected",
      "OnyxMetric is not connected for this project.",
    );
  }
  return { connection, client: await createOnyxmetricClient() };
}

function integerInRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new OnyxmetricReportError(
      "validation_error",
      `${name} must be an integer from ${min} to ${max}.`,
    );
  }
  return resolved;
}

async function runReport(
  input: OnyxmetricReportInput,
  opts: { now?: Date } = {},
) {
  const definition = BREAKDOWNS[input.kind];
  const limit = integerInRange(
    input.limit,
    DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
    "limit",
  );
  const page = integerInRange(input.page, 1, 1, 10_000, "page");
  const dateRange = resolveOnyxmetricDateRange(input, opts.now);
  const channel =
    definition.channel === "selectable"
      ? (input.channel ?? "organic_search")
      : definition.channel;
  try {
    const { connection, client } = await loadOnyxmetricContext(input.projectId);
    const result = await client.getMetric({
      siteId: connection.siteId,
      parameter: definition.parameter,
      range: dateRange.resolvedDateRange,
      filters: channel === "organic_search" ? ORGANIC_SEARCH_FILTERS : [],
      limit,
      page,
    });
    const rows = result.rows.map((row) => ({
      [definition.key]: row.value ?? "(not set)",
      sessions: row.sessions,
      percentage: row.percentage,
      pageviews: row.pageviews,
      bounceRate: row.bounceRate,
    }));
    return {
      status: "ok" as const,
      source: {
        provider: "onyxmetric" as const,
        siteId: connection.siteId,
        siteName: connection.siteName,
      },
      request: {
        reportKind: input.kind,
        dimension: definition.parameter,
        requestedDateRange: dateRange.requestedDateRange,
        resolvedDateRange: dateRange.resolvedDateRange,
        timeZone: ONYXMETRIC_TIME_ZONE,
        channel,
      },
      rowCount: rows.length,
      totalRowCount: result.totalCount,
      rows,
      pageInfo: {
        limit,
        page,
        hasMore: (page - 1) * limit + rows.length < result.totalCount,
      },
      // OnyxMetric reports exact counts: there is no sampling or thresholding.
      reportMetadata: { hasLimitedData: false },
      warnings: dateRange.warnings,
    };
  } catch (error) {
    mapOnyxmetricError(error);
  }
}

export const OnyxmetricReportService = { runReport };
export type OnyxmetricReportResult = Awaited<ReturnType<typeof runReport>>;
