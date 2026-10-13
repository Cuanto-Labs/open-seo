import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  OnyxmetricApiError,
  OnyxmetricMalformedResponseError,
  OnyxmetricNotConfiguredError,
} from "@/server/lib/onyxmetricErrors";

const DEFAULT_BASE_URL = "https://app.onyxmetric.com";
const REQUEST_TIMEOUT_MS = 15_000;
// Stats API date queries need an explicit IANA zone. Sites do not expose theirs
// through the API, so every report is bucketed in UTC.
export const ONYXMETRIC_TIME_ZONE = "UTC";

export type OnyxmetricDateRange = { startDate: string; endDate: string };
export type OnyxmetricFilter = {
  parameter: string;
  type: "equals" | "not_equals" | "contains";
  value: string[];
};
export type OnyxmetricMetricParameter =
  | "entry_page"
  | "pathname"
  | "referrer"
  | "channel"
  | "country"
  | "device_type";

// ClickHouse can serialize 64-bit counters as strings, so coerce.
const count = z.coerce.number();
const optionalCount = z.coerce.number().nullish();

const siteIdSchema = z.coerce.number().int().positive();
const organizationsSchema = z.array(
  z.object({ id: z.string(), name: z.string() }),
);
const organizationSitesSchema = z.object({
  sites: z.array(
    z.object({
      siteId: siteIdSchema,
      name: z.string(),
      domain: z.string().nullish(),
    }),
  ),
});
const siteSchema = z.object({
  siteId: siteIdSchema,
  name: z.string(),
  domain: z.string().nullish(),
});
const overviewRowSchema = z.object({
  sessions: optionalCount,
  pageviews: optionalCount,
  users: optionalCount,
  pages_per_session: optionalCount,
  bounce_rate: optionalCount,
  session_duration: optionalCount,
});
const overviewSchema = z.object({ data: overviewRowSchema.nullish() });
const timeSeriesSchema = z.object({
  data: z.array(overviewRowSchema.extend({ time: z.string() })),
});
const metricSchema = z.object({
  data: z.object({
    data: z.array(
      z.object({
        value: z.string().nullable(),
        count,
        percentage: optionalCount,
        pageviews: optionalCount,
        bounce_rate: optionalCount,
      }),
    ),
    totalCount: count.default(0),
  }),
});

type OnyxmetricSite = {
  siteId: string;
  name: string;
  domain: string | null;
  organizationName: string;
};
export type OnyxmetricOverview = {
  sessions: number | null;
  pageviews: number | null;
  users: number | null;
  pagesPerSession: number | null;
  bounceRate: number | null;
  sessionDuration: number | null;
};
type OnyxmetricTimeSeriesRow = OnyxmetricOverview & { time: string };
type OnyxmetricMetricRow = {
  value: string | null;
  sessions: number;
  percentage: number | null;
  pageviews: number | null;
  bounceRate: number | null;
};

function toOverview(
  row: z.infer<typeof overviewRowSchema>,
): OnyxmetricOverview {
  return {
    sessions: row.sessions ?? null,
    pageviews: row.pageviews ?? null,
    users: row.users ?? null,
    pagesPerSession: row.pages_per_session ?? null,
    bounceRate: row.bounce_rate ?? null,
    sessionDuration: row.session_duration ?? null,
  };
}

function safeRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value), 86_400);
}

function messageForStatus(status: number): string {
  if (status === 401) return "OnyxMetric rejected the API key.";
  if (status === 403) return "OnyxMetric denied access to this resource.";
  if (status === 404) return "OnyxMetric could not find this resource.";
  if (status === 429) return "OnyxMetric rate limit exceeded.";
  if (status === 400) return "OnyxMetric rejected this request.";
  return "OnyxMetric is temporarily unavailable.";
}

async function resolveBaseUrl(): Promise<string> {
  const configured = await getOptionalEnvValue("ONYXMETRIC_BASE_URL");
  if (!configured) return DEFAULT_BASE_URL;
  // The bearer key goes to this origin, so refuse anything but https
  // (plain http only for a local OnyxMetric instance).
  const url = new URL(configured);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("ONYXMETRIC_BASE_URL must use https.");
  }
  return url.origin;
}

export async function isOnyxmetricConfigured(): Promise<boolean> {
  return Boolean(await getOptionalEnvValue("ONYXMETRIC_API_KEY"));
}

function filtersParam(filters: OnyxmetricFilter[] | undefined) {
  return filters && filters.length > 0 ? JSON.stringify(filters) : undefined;
}

function timeParams(range: OnyxmetricDateRange): Record<string, string> {
  return {
    start_date: range.startDate,
    end_date: range.endDate,
    time_zone: ONYXMETRIC_TIME_ZONE,
  };
}

/** Read-only Stats API client. The key comes from server env on every call and
 *  is only ever placed in the Authorization header. */
export async function createOnyxmetricClient() {
  const apiKey = await getOptionalEnvValue("ONYXMETRIC_API_KEY");
  if (!apiKey) throw new OnyxmetricNotConfiguredError();
  const baseUrl = await resolveBaseUrl();

  async function get<T extends z.ZodType>(
    path: string,
    schema: T,
    params: Record<string, string | undefined> = {},
  ): Promise<z.infer<T>> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OnyxmetricApiError(0, messageForStatus(0));
    }
    if (!response.ok) {
      throw new OnyxmetricApiError(
        response.status,
        messageForStatus(response.status),
        response.status === 429 ? safeRetryAfter(response) : null,
      );
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new OnyxmetricMalformedResponseError();
    return parsed.data;
  }

  return {
    /** Every site in every organization the key can read. */
    async listSites(): Promise<OnyxmetricSite[]> {
      const organizations = await get(
        "/api/organizations",
        organizationsSchema,
      );
      const perOrganization = await Promise.all(
        organizations.map(async (organization) => {
          const { sites } = await get(
            `/api/organizations/${encodeURIComponent(organization.id)}/sites`,
            organizationSitesSchema,
          );
          return sites.map((site) => ({
            siteId: String(site.siteId),
            name: site.name,
            domain: site.domain ?? null,
            organizationName: organization.name,
          }));
        }),
      );
      return perOrganization.flat();
    },

    async getSite(siteId: string) {
      const site = await get(
        `/api/sites/${encodeURIComponent(siteId)}`,
        siteSchema,
      );
      return {
        siteId: String(site.siteId),
        name: site.name,
        domain: site.domain ?? null,
      };
    },

    async getOverview(input: {
      siteId: string;
      range: OnyxmetricDateRange;
      filters?: OnyxmetricFilter[];
    }): Promise<OnyxmetricOverview | null> {
      const { data } = await get(
        `/api/sites/${encodeURIComponent(input.siteId)}/overview`,
        overviewSchema,
        { ...timeParams(input.range), filters: filtersParam(input.filters) },
      );
      return data ? toOverview(data) : null;
    },

    async getTimeSeries(input: {
      siteId: string;
      range: OnyxmetricDateRange;
      bucket: "day" | "week";
      filters?: OnyxmetricFilter[];
    }): Promise<OnyxmetricTimeSeriesRow[]> {
      const { data } = await get(
        `/api/sites/${encodeURIComponent(input.siteId)}/overview/time-series`,
        timeSeriesSchema,
        {
          ...timeParams(input.range),
          bucket: input.bucket,
          filters: filtersParam(input.filters),
        },
      );
      return data.map((row) => ({ time: row.time, ...toOverview(row) }));
    },

    async getMetric(input: {
      siteId: string;
      parameter: OnyxmetricMetricParameter;
      range: OnyxmetricDateRange;
      filters?: OnyxmetricFilter[];
      limit: number;
      page: number;
    }): Promise<{ rows: OnyxmetricMetricRow[]; totalCount: number }> {
      const { data } = await get(
        `/api/sites/${encodeURIComponent(input.siteId)}/metric`,
        metricSchema,
        {
          ...timeParams(input.range),
          parameter: input.parameter,
          limit: String(input.limit),
          page: String(input.page),
          filters: filtersParam(input.filters),
        },
      );
      return {
        totalCount: data.totalCount,
        rows: data.data.map((row) => ({
          value: row.value,
          sessions: row.count,
          percentage: row.percentage ?? null,
          pageviews: row.pageviews ?? null,
          bounceRate: row.bounce_rate ?? null,
        })),
      };
    },
  };
}
