import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OnyxmetricClientModule from "@/server/lib/onyxmetricClient";
import { OnyxmetricApiError } from "@/server/lib/onyxmetricErrors";
import { OnyxmetricOverviewService } from "./OnyxmetricOverviewService";
import { OnyxmetricReportService } from "./OnyxmetricReportService";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  client: {
    getOverview: vi.fn(),
    getTimeSeries: vi.fn(),
    getMetric: vi.fn<(input: { filters?: unknown[] }) => Promise<unknown>>(),
  },
}));

vi.mock(
  "@/server/features/onyxmetric/repositories/OnyxmetricConnectionRepository",
  () => ({
    OnyxmetricConnectionRepository: { getByProjectId: mocks.getConnection },
  }),
);
vi.mock("@/server/lib/onyxmetricClient", async (importOriginal) => ({
  ...(await importOriginal<typeof OnyxmetricClientModule>()),
  createOnyxmetricClient: async () => mocks.client,
}));

const NOW = new Date("2026-10-13T15:00:00Z");
const overview = (sessions: number | null) => ({
  sessions,
  pageviews: null,
  users: null,
  pagesPerSession: null,
  bounceRate: null,
  sessionDuration: null,
});

describe("OnyxmetricOverviewService", () => {
  beforeEach(() => {
    mocks.getConnection.mockResolvedValue({ siteId: "7", siteName: "Acme" });
    mocks.client.getTimeSeries.mockResolvedValue([]);
  });

  it("compares organic periods and reports the organic share of all traffic", async () => {
    mocks.client.getOverview.mockImplementation(
      async ({
        range,
        filters,
      }: {
        range: { endDate: string };
        filters?: unknown[];
      }) => {
        if (!filters) return overview(400);
        return range.endDate === "2026-10-12" ? overview(150) : overview(100);
      },
    );

    const result = await OnyxmetricOverviewService.getOrganicOverview(
      { projectId: "p1" },
      { now: NOW },
    );

    expect(result.request.resolvedDateRange).toEqual({
      startDate: "2026-09-15",
      endDate: "2026-10-12",
    });
    expect(result.request.previousDateRange).toEqual({
      startDate: "2026-08-18",
      endDate: "2026-09-14",
    });
    expect(result.comparison.sessions).toMatchObject({
      current: 150,
      previous: 100,
      absoluteChange: 50,
      percentChange: 0.5,
    });
    expect(result.allChannels.organicShareOfSessions).toBe(150 / 400);
  });

  it("returns null for periods with no sessions", async () => {
    mocks.client.getOverview.mockResolvedValue(overview(0));

    const result = await OnyxmetricOverviewService.getOrganicOverview(
      { projectId: "p1" },
      { now: NOW },
    );

    expect(result.current).toBeNull();
    expect(result.previous).toBeNull();
    expect(result.allChannels.organicShareOfSessions).toBeNull();
  });
});

describe("OnyxmetricReportService", () => {
  beforeEach(() => {
    mocks.getConnection.mockResolvedValue({ siteId: "7", siteName: "Acme" });
    mocks.client.getMetric.mockResolvedValue({
      rows: [
        {
          value: "/a",
          sessions: 5,
          percentage: 50,
          pageviews: 9,
          bounceRate: 20,
        },
        {
          value: null,
          sessions: 5,
          percentage: 50,
          pageviews: 6,
          bounceRate: 40,
        },
      ],
      totalCount: 7,
    });
  });

  it("filters landing pages to Organic Search and pages the rows", async () => {
    const result = await OnyxmetricReportService.runReport(
      { projectId: "p1", kind: "landing_pages", limit: 2, page: 1 },
      { now: NOW },
    );

    expect(mocks.client.getMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        parameter: "entry_page",
        filters: [
          { parameter: "channel", type: "equals", value: ["Organic Search"] },
        ],
      }),
    );
    expect(result.rows[1]).toMatchObject({ landingPage: "(not set)" });
    expect(result.pageInfo).toEqual({ limit: 2, page: 1, hasMore: true });
    expect(result.totalRowCount).toBe(7);
  });

  it("lets a breakdown span all channels, and the channel report always does", async () => {
    await OnyxmetricReportService.runReport(
      { projectId: "p1", kind: "devices", channel: "all" },
      { now: NOW },
    );
    await OnyxmetricReportService.runReport(
      { projectId: "p1", kind: "channels", channel: "organic_search" },
      { now: NOW },
    );

    expect(
      mocks.client.getMetric.mock.calls.map(([call]) => call.filters),
    ).toEqual([[], []]);
  });

  it("maps an upstream 429 to a retryable report error", async () => {
    mocks.client.getMetric.mockRejectedValue(
      new OnyxmetricApiError(429, "limit", 12),
    );

    await expect(
      OnyxmetricReportService.runReport(
        { projectId: "p1", kind: "channels" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "onyxmetric_rate_limited",
      retryAfterSeconds: 12,
    });
  });

  it("reports a project with no connection", async () => {
    mocks.getConnection.mockResolvedValue(null);

    await expect(
      OnyxmetricReportService.runReport(
        { projectId: "p1", kind: "channels" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "onyxmetric_not_connected" });
  });

  it("rejects a half-specified date range", async () => {
    await expect(
      OnyxmetricReportService.runReport(
        { projectId: "p1", kind: "channels", startDate: "2026-09-01" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});
