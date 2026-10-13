import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOnyxmetricClient } from "./onyxmetricClient";
import {
  OnyxmetricApiError,
  OnyxmetricMalformedResponseError,
  OnyxmetricNotConfiguredError,
} from "./onyxmetricErrors";

const mocks = vi.hoisted(() => ({
  env: vi.fn<(name: string) => Promise<string | undefined>>(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: mocks.env,
}));

const range = { startDate: "2026-09-01", endDate: "2026-09-28" };

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

describe("onyxmetricClient", () => {
  beforeEach(() => {
    mocks.env.mockImplementation(async (name) =>
      name === "ONYXMETRIC_API_KEY" ? "rb_org_secret" : undefined,
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer key and JSON filters, and coerces string counters", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        data: {
          data: [
            {
              value: "/pricing",
              count: "12",
              percentage: 40,
              pageviews: "30",
              bounce_rate: 55.5,
            },
          ],
          totalCount: "1",
        },
      }),
    );
    const client = await createOnyxmetricClient();

    const result = await client.getMetric({
      siteId: "7",
      parameter: "entry_page",
      range,
      filters: [
        { parameter: "channel", type: "equals", value: ["Organic Search"] },
      ],
      limit: 50,
      page: 2,
    });

    const [input, init] = mocks.fetch.mock.calls[0];
    const url = requestUrl(input);
    expect(url.origin + url.pathname).toBe(
      "https://app.onyxmetric.com/api/sites/7/metric",
    );
    expect(url.searchParams.get("parameter")).toBe("entry_page");
    expect(url.searchParams.get("time_zone")).toBe("UTC");
    expect(url.searchParams.get("page")).toBe("2");
    expect(JSON.parse(url.searchParams.get("filters") ?? "")).toEqual([
      { parameter: "channel", type: "equals", value: ["Organic Search"] },
    ]);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer rb_org_secret",
    );
    expect(result).toEqual({
      totalCount: 1,
      rows: [
        {
          value: "/pricing",
          sessions: 12,
          percentage: 40,
          pageviews: 30,
          bounceRate: 55.5,
        },
      ],
    });
  });

  it("omits the filters param when there are none", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: null }));
    const client = await createOnyxmetricClient();

    await expect(
      client.getOverview({ siteId: "7", range }),
    ).resolves.toBeNull();

    expect(
      requestUrl(mocks.fetch.mock.calls[0][0]).searchParams.has("filters"),
    ).toBe(false);
  });

  it.each([
    [401, null],
    [403, null],
    [429, 30],
    [503, null],
  ])(
    "maps HTTP %i to a typed error without leaking the key",
    async (status, retryAfter) => {
      mocks.fetch.mockResolvedValueOnce(
        new Response("rb_org_secret", {
          status,
          headers: retryAfter ? { "retry-after": String(retryAfter) } : {},
        }),
      );
      const client = await createOnyxmetricClient();

      const error = await client
        .getSite("7")
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OnyxmetricApiError);
      expect(error).toMatchObject({ status, retryAfterSeconds: retryAfter });
      expect(String(error)).not.toContain("rb_org_secret");
    },
  );

  it("treats a network failure as an upstream error", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = await createOnyxmetricClient();

    await expect(client.getSite("7")).rejects.toMatchObject({ status: 0 });
  });

  it("rejects a response that fails validation", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ siteId: "nope" }));
    const client = await createOnyxmetricClient();

    await expect(client.getSite("7")).rejects.toBeInstanceOf(
      OnyxmetricMalformedResponseError,
    );
  });

  it("throws not-configured without a key", async () => {
    mocks.env.mockResolvedValue(undefined);

    await expect(createOnyxmetricClient()).rejects.toBeInstanceOf(
      OnyxmetricNotConfiguredError,
    );
  });

  it("refuses a non-https base URL for the bearer key", async () => {
    mocks.env.mockImplementation(async (name) =>
      name === "ONYXMETRIC_API_KEY"
        ? "rb_org_secret"
        : "http://metrics.example.com",
    );

    await expect(createOnyxmetricClient()).rejects.toThrow(/https/);
  });
});
