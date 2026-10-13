import { z } from "zod";
import {
  OnyxmetricOverviewService,
  ONYXMETRIC_OVERVIEW_METRICS,
} from "@/server/features/onyxmetric/services/OnyxmetricOverviewService";
import {
  OnyxmetricReportService,
  type OnyxmetricBreakdownKind,
  type OnyxmetricReportResult,
} from "@/server/features/onyxmetric/services/OnyxmetricReportService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable } from "@/server/mcp/table";
import {
  analyticsEnvelopeSchema,
  dateSchema,
  errorResponse,
  type ProjectArgs,
} from "@/server/mcp/tools/google-analytics-tools";

const reportOutputSchema = analyticsEnvelopeSchema({
  source: looseObjectOutputSchema,
  request: looseObjectOutputSchema,
  rowCount: z.number(),
  totalRowCount: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
  pageInfo: looseObjectOutputSchema,
  reportMetadata: looseObjectOutputSchema,
  warnings: z.array(z.string()),
});

const overviewOutputSchema = analyticsEnvelopeSchema({
  source: looseObjectOutputSchema,
  request: looseObjectOutputSchema,
  current: looseObjectOutputSchema.nullable(),
  previous: looseObjectOutputSchema.nullable(),
  comparison: looseObjectOutputSchema,
  allChannels: looseObjectOutputSchema,
  trend: z.array(z.record(z.string(), z.unknown())),
  diagnostics: z.array(looseObjectOutputSchema),
  reportMetadata: looseObjectOutputSchema,
  warnings: z.array(z.string()),
  quota: looseObjectOutputSchema.nullable().optional(),
});

const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;

const READ_ONLY_NOTE =
  "Reads only the OnyxMetric site already connected to an OpenSEO project the caller is authorized to access. The server selects the site from that project's saved connection and holds the API key. Read-only and uses no OpenSEO credits.";

const reportInputShape = {
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  limit: z.number().int().min(1).max(1_000).optional().default(100),
  page: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .default(1)
    .describe("1-based page of rows."),
} as const;

function reportText(label: string, result: OnyxmetricReportResult) {
  const range = result.request.resolvedDateRange;
  const paginate = result.pageInfo.hasMore
    ? " More rows are available; call again with page to page through them."
    : "";
  const scope =
    result.request.channel === "organic_search" && result.totalRowCount === 0
      ? " This report is limited to Organic Search traffic."
      : "";
  const summary = `${label}: ${result.rowCount} of ${result.totalRowCount} rows for ${range.startDate} through ${range.endDate}.${scope}${paginate}`;
  if (result.rows.length === 0) return summary;
  const columns = Object.keys(result.rows[0]).map((key) => ({
    header: key,
    value: (row: Record<string, unknown>) => row[key],
  }));
  return `${summary}\n${formatMcpTable(result.rows, columns)}`;
}

function createReportHandler<
  TArgs extends ProjectArgs & {
    startDate?: string;
    endDate?: string;
    limit: number;
    page: number;
  },
>(
  label: string,
  toKind: (args: TArgs) => {
    kind: OnyxmetricBreakdownKind;
    channel?: "organic_search" | "all";
  },
) {
  return withMcpProjectAuth(async (args: TArgs, context) => {
    try {
      const result = await OnyxmetricReportService.runReport({
        projectId: args.projectId,
        startDate: args.startDate,
        endDate: args.endDate,
        limit: args.limit,
        page: args.page,
        ...toKind(args),
      });
      return mcpResponse({
        text: reportText(label, result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  });
}

const overviewInputSchema = z.strictObject({
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  trend: z.enum(["daily", "weekly"]).optional().default("daily"),
});
type OverviewArgs = z.infer<typeof overviewInputSchema>;

export const getOnyxmetricOverviewTool = {
  name: "get_onyxmetric_overview",
  config: {
    title: "Get OnyxMetric organic overview",
    description: `Answer whether organic traffic is improving with Organic Search sessions, users, pageviews, pages per session, bounce rate, session duration, an equal-length previous-period comparison, the organic share of all-channel sessions, and a daily or weekly trend. Defaults to the last 28 days (UTC). ${READ_ONLY_NOTE}`,
    inputSchema: overviewInputSchema,
    outputSchema: overviewOutputSchema,
    annotations,
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    try {
      const result = await OnyxmetricOverviewService.getOrganicOverview(args);
      const range = result.request.resolvedDateRange;
      const previousRange = result.request.previousDateRange;
      const summary = `Organic overview for ${range.startDate} through ${range.endDate}, compared with ${previousRange.startDate} through ${previousRange.endDate}.`;
      const current = result.current;
      const text = current
        ? `${summary}\n${formatMcpTable(
            ONYXMETRIC_OVERVIEW_METRICS.map((metric) => ({
              metric,
              current: current[metric],
              previous: result.previous?.[metric] ?? null,
            })),
            [
              { header: "metric", value: (row) => row.metric },
              { header: "current", value: (row) => row.current },
              { header: "previous", value: (row) => row.previous },
            ],
          )}`
        : `${summary} No Organic Search rows for this date range.`;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const landingPagesInputSchema = z.strictObject(reportInputShape);
type LandingPagesArgs = z.infer<typeof landingPagesInputSchema>;

export const getOnyxmetricLandingPagesTool = {
  name: "get_onyxmetric_landing_pages",
  config: {
    title: "Get OnyxMetric organic landing pages",
    description: `Read Organic Search landing pages with sessions, share of sessions, pageviews, and bounce rate from the project's connected OnyxMetric site. Defaults to the last 28 days (UTC). ${READ_ONLY_NOTE}`,
    inputSchema: landingPagesInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<LandingPagesArgs>(
    "Organic landing pages",
    () => ({ kind: "landing_pages" }),
  ),
};

const channelsInputSchema = z.strictObject(reportInputShape);
type ChannelsArgs = z.infer<typeof channelsInputSchema>;

export const getOnyxmetricChannelsTool = {
  name: "get_onyxmetric_channels",
  config: {
    title: "Get OnyxMetric channels",
    description: `Compare sessions by acquisition channel (Organic Search, Direct, Referral, Social, and so on) across all traffic. ${READ_ONLY_NOTE}`,
    inputSchema: channelsInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<ChannelsArgs>("Channels", () => ({
    kind: "channels",
  })),
};

const referrersInputSchema = z.strictObject(reportInputShape);
type ReferrersArgs = z.infer<typeof referrersInputSchema>;

export const getOnyxmetricReferrersTool = {
  name: "get_onyxmetric_referrers",
  config: {
    title: "Get OnyxMetric search-engine referrers",
    description: `Read which referrers (search engines such as Google, Bing, DuckDuckGo) send Organic Search sessions. ${READ_ONLY_NOTE}`,
    inputSchema: referrersInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<ReferrersArgs>(
    "Search-engine referrers",
    () => ({ kind: "referrers" }),
  ),
};

const breakdownInputSchema = z.strictObject({
  ...reportInputShape,
  dimension: z.enum(["countries", "devices", "pages"]),
  channel: z
    .enum(["organic_search", "all"])
    .optional()
    .default("organic_search"),
});
type BreakdownArgs = z.infer<typeof breakdownInputSchema>;

export const getOnyxmetricBreakdownTool = {
  name: "get_onyxmetric_breakdown",
  config: {
    title: "Get OnyxMetric breakdown",
    description: `Break sessions down by country, device type, or page path. Organic Search is the default; set channel to all to include every channel. ${READ_ONLY_NOTE}`,
    inputSchema: breakdownInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<BreakdownArgs>("Breakdown", (args) => ({
    kind: args.dimension,
    channel: args.channel,
  })),
};
