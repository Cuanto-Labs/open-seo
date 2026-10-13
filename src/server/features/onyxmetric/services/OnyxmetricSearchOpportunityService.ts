import { GscService } from "@/server/features/gsc/services/GscService";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  ga4DateInTimeZone,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";
import {
  normalizePageKey,
  scoreOpportunities,
  SEARCH_OPPORTUNITY_SCORE_FORMULA,
} from "@/server/features/ga4/services/SearchOpportunityScoring";
import { ONYXMETRIC_TIME_ZONE } from "@/server/lib/onyxmetricClient";
import { OnyxmetricReportError } from "@/server/lib/onyxmetricErrors";
import {
  OnyxmetricReportService,
  resolveOnyxmetricDateRange,
} from "./OnyxmetricReportService";

type OpportunityInput = {
  projectId: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
};

type Candidate = {
  page: string;
  normalizedPage: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  joinStatus: "joined" | "gsc_only";
  onyxmetric: {
    sessions: number;
    bounceRate: number | null;
    engagementRate: number;
  } | null;
  score: number | null;
  scoreComponents: {
    demand: number;
    businessValue: number;
    reachability: number;
  } | null;
};

/** OnyxMetric reports landing pages as bare paths, so the join is path-only. */
function pathKey(value: string): string | null {
  // A bare path needs a placeholder host, or URL parsing reads it as one.
  const key = normalizePageKey(
    value.startsWith("/") ? `https://placeholder.invalid${value}` : value,
  );
  return key ? key.slice(key.indexOf("/")) : null;
}

function resolveDates(input: OpportunityInput, now: Date) {
  if (!input.startDate && !input.endDate) {
    // Search Console's final data trails by about three days.
    const endDate = shiftGa4Date(
      ga4DateInTimeZone(now, ONYXMETRIC_TIME_ZONE),
      -3,
    );
    return { startDate: shiftGa4Date(endDate, -27), endDate };
  }
  return resolveOnyxmetricDateRange(input, now).resolvedDateRange;
}

/** Search opportunities for projects whose analytics source is OnyxMetric:
 *  Search Console pages ranking 4-20 joined to organic landing pages. */
async function getOpportunities(
  input: OpportunityInput,
  opts: { now?: Date } = {},
) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new OnyxmetricReportError(
      "validation_error",
      "limit must be an integer from 1 to 100.",
    );
  }
  if (!(await GscService.getConnection(input.projectId))) {
    throw new GscNotConnectedError(input.projectId);
  }
  const dates = resolveDates(input, opts.now ?? new Date());
  const gsc = await GscService.getPerformance({
    projectId: input.projectId,
    dimensions: ["page"],
    startDate: dates.startDate,
    endDate: dates.endDate,
    rowLimit: 1_000,
    startRow: 0,
    type: "web",
    dataState: "final",
  });
  const landing = await OnyxmetricReportService.runReport({
    projectId: input.projectId,
    kind: "landing_pages",
    startDate: dates.startDate,
    endDate: dates.endDate,
    limit: 1_000,
  });

  const landingByPath = new Map<
    string,
    { sessions: number; bounceRate: number | null }
  >();
  let invalidLandingRows = 0;
  for (const row of landing.rows) {
    const key =
      typeof row.landingPage === "string" ? pathKey(row.landingPage) : null;
    if (!key) {
      invalidLandingRows += 1;
      continue;
    }
    const existing = landingByPath.get(key);
    // Query-string variants collapse onto one path; keep the busiest row.
    if (!existing || row.sessions > existing.sessions) {
      landingByPath.set(key, {
        sessions: row.sessions,
        bounceRate: row.bounceRate,
      });
    }
  }

  const candidates: Candidate[] = gsc.rows
    .filter((row) => row.position >= 4 && row.position <= 20)
    .map((row) => {
      const page = row.keys?.[0] ?? "";
      const key = pathKey(page);
      const analytics = key ? landingByPath.get(key) : undefined;
      return {
        page,
        normalizedPage: key,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        joinStatus: analytics ? "joined" : "gsc_only",
        onyxmetric: analytics
          ? {
              sessions: analytics.sessions,
              bounceRate: analytics.bounceRate,
              // Engagement proxy: share of sessions that viewed another page.
              engagementRate:
                analytics.bounceRate == null
                  ? 0
                  : Math.max(0, 1 - analytics.bounceRate / 100),
            }
          : null,
        score: null,
        scoreComponents: null,
      } satisfies Candidate;
    });

  const joined = candidates.filter(
    (
      candidate,
    ): candidate is Candidate & {
      onyxmetric: NonNullable<Candidate["onyxmetric"]>;
    } => candidate.onyxmetric !== null,
  );
  const scores = scoreOpportunities(
    joined.map((candidate) => ({
      impressions: candidate.impressions,
      position: candidate.position,
      businessValue: candidate.onyxmetric.engagementRate,
    })),
  );
  joined.forEach((candidate, index) => {
    const scored = scores[index];
    if (!scored) return;
    candidate.scoreComponents = scored.components;
    candidate.score = scored.score;
  });
  candidates.sort((a, b) => {
    if (a.score == null && b.score != null) return 1;
    if (a.score != null && b.score == null) return -1;
    return (b.score ?? 0) - (a.score ?? 0) || b.impressions - a.impressions;
  });

  const returned = candidates.slice(0, limit);
  return {
    status: "ok" as const,
    source: {
      searchConsoleSiteUrl: gsc.siteUrl,
      analyticsProvider: "onyxmetric" as const,
      onyxmetricSiteId: landing.source.siteId,
      onyxmetricSiteName: landing.source.siteName,
    },
    request: {
      dateRange: dates,
      limit,
      searchConsoleTimeZone: "America/Los_Angeles",
      analyticsTimeZone: ONYXMETRIC_TIME_ZONE,
    },
    rowCount: returned.length,
    totalCandidateRows: candidates.length,
    rows: returned,
    scoring: {
      formula: SEARCH_OPPORTUNITY_SCORE_FORMULA,
      businessValueMetric: "engagementRate",
      // OnyxMetric has no key-event outcome here, so engagement stands in.
      engagementFallback: true,
      scoreDataLimited: landing.reportMetadata.hasLimitedData,
    },
    coverage: {
      gscRowsConsidered: gsc.rows.length,
      ga4RowsConsidered: landing.rows.length,
      matchedRows: joined.length,
      unmatchedGscRows: candidates.length - joined.length,
      unmatchedGa4Rows:
        Math.max(landingByPath.size - joined.length, 0) + invalidLandingRows,
    },
    truncated: {
      gsc: gsc.rows.length >= 1_000,
      ga4: landing.totalRowCount > landing.rows.length,
      candidates: returned.length < candidates.length,
    },
    warnings: [
      ...landing.warnings,
      "joined_by_path_only",
      "source_time_zones_differ",
    ],
    reportMetadata: landing.reportMetadata,
    quota: null,
  };
}

export const OnyxmetricSearchOpportunityService = { getOpportunities };
