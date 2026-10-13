export class OnyxmetricNotConfiguredError extends Error {
  constructor() {
    super("ONYXMETRIC_API_KEY is not configured on this server.");
    this.name = "OnyxmetricNotConfiguredError";
  }
}

export class OnyxmetricApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "OnyxmetricApiError";
  }
}

export class OnyxmetricMalformedResponseError extends Error {
  constructor() {
    super("OnyxMetric returned an invalid response.");
    this.name = "OnyxmetricMalformedResponseError";
  }
}

type OnyxmetricReportErrorCode =
  | "validation_error"
  | "onyxmetric_not_configured"
  | "onyxmetric_not_connected"
  | "onyxmetric_auth_failed"
  | "onyxmetric_site_inaccessible"
  | "onyxmetric_rate_limited"
  | "onyxmetric_upstream_unavailable"
  | "onyxmetric_malformed_response";

export class OnyxmetricReportError extends Error {
  constructor(
    public readonly code: OnyxmetricReportErrorCode,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "OnyxmetricReportError";
  }
}
