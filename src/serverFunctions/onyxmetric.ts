import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { shiftGa4Date } from "@/server/features/ga4/services/Ga4Dates";
import { OnyxmetricOverviewService } from "@/server/features/onyxmetric/services/OnyxmetricOverviewService";
import { OnyxmetricService } from "@/server/features/onyxmetric/services/OnyxmetricService";
import { AppError } from "@/server/lib/errors";
import { isOnyxmetricConfigured } from "@/server/lib/onyxmetricClient";
import { OnyxmetricReportError } from "@/server/lib/onyxmetricErrors";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const setSiteSchema = projectScopedSchema.extend({
  siteId: z.string().regex(/^\d{1,12}$/),
});

export const getOnyxmetricConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [connection, configured] = await Promise.all([
      OnyxmetricService.getConnection(context.projectId),
      isOnyxmetricConfigured(),
    ]);
    return {
      connected: Boolean(connection),
      canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
      // False when the server has no ONYXMETRIC_API_KEY: the UI explains the
      // missing setup instead of offering a site picker that cannot work.
      configured,
      siteId: connection?.siteId ?? null,
      siteName: connection?.siteName ?? null,
      connectedAt: connection?.createdAt ?? null,
    };
  });

export const listOnyxmetricSites = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [siteList, connection] = await Promise.all([
      OnyxmetricService.listSites(),
      OnyxmetricService.getConnection(context.projectId),
    ]);
    return {
      available: siteList.available,
      sites: siteList.sites.map((site) => ({
        ...site,
        isSelected: connection?.siteId === site.siteId,
      })),
    };
  });

export const setOnyxmetricSite = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setSiteSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const connection = await OnyxmetricService.setSite({
      projectId: context.projectId,
      organizationId: context.organizationId,
      siteId: data.siteId,
      userId: context.userId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "onyxmetric:site_select",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return {
      connected: true as const,
      siteId: connection.siteId,
      siteName: connection.siteName,
      connectedAt: connection.createdAt,
    };
  });

export const disconnectOnyxmetric = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await OnyxmetricService.disconnect({ projectId: context.projectId });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "onyxmetric:disconnect",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return { connected: false as const };
  });

/** Zero-fill the daily trend across the resolved range: OnyxMetric omits days
 *  with no organic sessions, which would shrink the chart's x-axis. */
function fillDailySessions(
  rows: Array<{ time: string; sessions: number | null }>,
  range: { startDate: string; endDate: string },
): Array<{ date: string; sessions: number }> {
  // Bucket starts are "YYYY-MM-DD HH:MM:SS"; the date part keys the day.
  const sessionsByDate = new Map(
    rows.map((row) => [row.time.slice(0, 10), row.sessions ?? 0]),
  );
  const days: Array<{ date: string; sessions: number }> = [];
  for (
    let date = range.startDate;
    date <= range.endDate;
    date = shiftGa4Date(date, 1)
  ) {
    days.push({ date, sessions: sessionsByDate.get(date) ?? 0 });
  }
  return days;
}

function totals(
  row: {
    sessions: number | null;
    users: number | null;
    bounceRate: number | null;
    sessionDuration: number | null;
  } | null,
) {
  return {
    sessions: row?.sessions ?? null,
    users: row?.users ?? null,
    bounceRate: row?.bounceRate ?? null,
    sessionDuration: row?.sessionDuration ?? null,
  };
}

/** The dashboard's OnyxMetric card: organic totals vs the previous period plus
 *  a daily sessions trend, over the default (last 28 complete days) range. */
export const getOnyxmetricDashboardReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    try {
      const overview = await OnyxmetricOverviewService.getOrganicOverview({
        projectId: context.projectId,
      });
      return {
        connected: true as const,
        totals: totals(overview.current),
        prevTotals: totals(overview.previous),
        trend: fillDailySessions(
          overview.trend,
          overview.request.resolvedDateRange,
        ),
      };
    } catch (error) {
      // Not connected, no server key, a rejected key or a lost site: the card
      // falls back to the connect card instead of retrying a report that can
      // never succeed. Other report errors are real faults.
      if (
        error instanceof OnyxmetricReportError &&
        [
          "onyxmetric_not_connected",
          "onyxmetric_not_configured",
          "onyxmetric_auth_failed",
          "onyxmetric_site_inaccessible",
        ].includes(error.code)
      ) {
        return { connected: false as const };
      }
      // External throttling: transient, so error tracking skips it.
      if (
        error instanceof OnyxmetricReportError &&
        error.code === "onyxmetric_rate_limited"
      ) {
        throw new AppError("RATE_LIMITED");
      }
      throw error;
    }
  });
