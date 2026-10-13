import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import { CardShell } from "@/client/components/CardShell";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { moreDetailsClass } from "@/client/features/dashboard/cardParts";
import { MetricsTable, percentChange } from "@/client/components/MetricsTable";
import { OnyxmetricConnectionCard } from "@/client/features/integrations/OnyxmetricConnectionCard";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getOnyxmetricDashboardReport } from "@/serverFunctions/onyxmetric";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/client/components/ui/chart";

const sessionsChartConfig = {
  sessions: { label: "Sessions", color: "var(--color-primary)" },
} satisfies ChartConfig;

function formatTrendDay(date: string): string {
  // Construct in local time: Date.parse("2026-08-01") is UTC midnight, which
  // toLocaleDateString would render as the previous day west of Greenwich.
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function statValue(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? "N/A" : format(value);
}

// OnyxMetric reports bounce rate as 0-100 and duration in seconds.
function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

function changeLabel(change: number | null) {
  if (change === null) return undefined;
  return (
    <span
      className={
        change > 0
          ? "text-success"
          : change < 0
            ? "text-destructive"
            : "text-muted-foreground"
      }
    >
      {change > 0 ? "+" : ""}
      {change}%
    </span>
  );
}

export function OnyxmetricCard({
  projectId,
  connected,
}: {
  projectId: string;
  connected: boolean;
}) {
  const reportQuery = useQuery({
    queryKey: ["dashboardOnyxmetricReport", projectId],
    queryFn: () => getOnyxmetricDashboardReport({ data: { projectId } }),
    enabled: connected,
  });
  const report = reportQuery.data;

  // Not connected (or a missing key, rejected key or lost site discovered by
  // the report call): the connection card explains and runs the whole flow.
  if (!connected || (report && !report.connected)) {
    return <OnyxmetricConnectionCard projectId={projectId} />;
  }

  return (
    <CardShell
      title="Organic traffic"
      action={
        <Link
          to="/p/$projectId/settings/integrations"
          params={{ projectId }}
          hash="onyxmetric"
          className={moreDetailsClass}
        >
          Manage
        </Link>
      }
    >
      <p className="mb-4 text-sm text-muted-foreground">
        OnyxMetric · Last 28 days
      </p>
      {reportQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn&rsquo;t load OnyxMetric data. Try again shortly.
        </p>
      ) : !report ? (
        <div className="space-y-3" aria-busy>
          <SkeletonTableRows rows={5} columns={3} />
          <Skeleton className="h-24" />
        </div>
      ) : !report.totals.sessions ? (
        <p className="text-sm text-muted-foreground">
          No organic search traffic recorded in the last 28 days yet.
        </p>
      ) : (
        <div className="space-y-4">
          <MetricsTable
            showChange
            rows={[
              {
                label: "Sessions",
                value: statValue(report.totals.sessions, formatCount),
                change: percentChange(
                  report.totals.sessions,
                  report.prevTotals.sessions,
                ),
              },
              {
                label: "Users",
                value: statValue(report.totals.users, formatCount),
                change: percentChange(
                  report.totals.users,
                  report.prevTotals.users,
                ),
              },
              {
                label: "Bounce rate",
                value: statValue(report.totals.bounceRate, formatPercent),
                change: null,
              },
              {
                label: "Avg. session",
                value: statValue(report.totals.sessionDuration, formatDuration),
                change: null,
              },
            ].map((metric) => ({
              label: metric.label,
              value: metric.value,
              change: changeLabel(metric.change),
            }))}
          />
          <ChartContainer config={sessionsChartConfig} className="h-24">
            <AreaChart
              data={report.trend}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <XAxis dataKey="date" hide />
              <YAxis hide domain={[0, "auto"]} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(label: unknown) =>
                      typeof label === "string" ? formatTrendDay(label) : ""
                    }
                    valueFormatter={(value) => formatCount(Number(value))}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="sessions"
                stroke="var(--color-sessions)"
                strokeWidth={2}
                fill="var(--color-sessions)"
                fillOpacity={0.08}
              />
            </AreaChart>
          </ChartContainer>
        </div>
      )}
    </CardShell>
  );
}
