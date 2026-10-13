/** Normalizes a Search Console page URL or analytics landing page to
 *  `host/path` (lowercased host, no trailing slash) for joining the two. */
export function normalizePageKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "(not set)") return null;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    let host = url.hostname.toLowerCase();
    const defaultPort =
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443");
    if (url.port && !defaultPort) host += `:${url.port}`;
    let path = url.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function percentileRanks(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [1];
  return values.map((value) => {
    const lower = values.filter((candidate) => candidate < value).length;
    return lower / (values.length - 1);
  });
}

function roundComponent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const SEARCH_OPPORTUNITY_SCORE_FORMULA =
  "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))";

/** Scores matched Search Console pages by demand (impressions), business value
 *  (caller-chosen outcome rate), and reachability (closeness to page one). */
export function scoreOpportunities(
  items: Array<{
    impressions: number;
    position: number;
    businessValue: number;
  }>,
) {
  const demand = percentileRanks(
    items.map((item) => Math.log1p(item.impressions)),
  );
  const businessValue = percentileRanks(
    items.map((item) => item.businessValue),
  );
  const reachability = percentileRanks(items.map((item) => 20 - item.position));
  return items.map((_, index) => {
    const components = {
      demand: roundComponent(demand[index] ?? 0),
      businessValue: roundComponent(businessValue[index] ?? 0),
      reachability: roundComponent(reachability[index] ?? 0),
    };
    return {
      components,
      score: Math.round(
        100 *
          (0.5 * components.demand +
            0.3 * components.businessValue +
            0.2 * components.reachability),
      ),
    };
  });
}
