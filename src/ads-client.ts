import { AdsConfig, normalizeCustomerId } from "./auth.js";

/**
 * Google Ads API version. Google releases a new major version every few
 * months and sunsets each one about a year later; bump this when needed.
 * Release notes: https://developers.google.com/google-ads/api/docs/release-notes
 */
export const GOOGLE_ADS_API_VERSION = "v26";

const API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const REQUEST_TIMEOUT_MS = 120_000;

// The only endpoints this server may call. Both are read-only; anything
// else (e.g. a :mutate path) is refused before a request is sent.
const READ_ONLY_PATHS = [/^customers:listAccessibleCustomers$/, /^customers\/\d{10}\/googleAds:searchStream$/];

export type Row = Record<string, string | number | boolean | null | unknown[]>;

export interface QueryResult {
  rows: Row[];
  truncated: boolean;
}

/**
 * Error from the Google Ads API, carrying the structured error codes
 * (e.g. "authorizationError: USER_PERMISSION_DENIED") so they can be
 * turned into actionable messages.
 */
export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    public httpStatus: number,
    public status: string,
    public codes: string[],
    public requestId?: string
  ) {
    super(message);
  }
}

// Google Ads returns int64 values (metrics.clicks, costMicros, IDs) as
// strings in JSON. Convert them to numbers except for IDs, which can
// exceed Number.MAX_SAFE_INTEGER and are better kept exact.
function convertValue(key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && !/(^|\.)id$|Id$/.test(key)) {
    const n = Number(value);
    return Number.isSafeInteger(n) || value.includes(".") ? n : value;
  }
  return value;
}

/**
 * Flatten a nested REST result ({campaign:{name:..}, metrics:{clicks:..}})
 * into dotted keys ("campaign.name", "metrics.clicks"). Arrays stay as-is.
 */
export function flattenRow(obj: Record<string, unknown>, prefix = "", out: Row = {}): Row {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenRow(value as Record<string, unknown>, path, out);
    } else {
      out[path] = convertValue(path, value) as Row[string];
    }
  }
  return out;
}

interface ApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: {
      "@type"?: string;
      errors?: { errorCode?: Record<string, string>; message?: string }[];
      requestId?: string;
      reason?: string;
    }[];
  };
}

function parseApiError(httpStatus: number, text: string): GoogleAdsApiError {
  let body: ApiErrorBody | undefined;
  try {
    const parsed = JSON.parse(text);
    // searchStream wraps errors in an array
    body = Array.isArray(parsed) ? parsed.find((p) => p?.error) : parsed;
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy)
  }
  const err = body?.error;
  const codes: string[] = [];
  const messages: string[] = [];
  let requestId: string | undefined;
  for (const detail of err?.details || []) {
    requestId ||= detail.requestId;
    if (detail.reason) codes.push(detail.reason);
    for (const e of detail.errors || []) {
      for (const [category, value] of Object.entries(e.errorCode || {})) {
        codes.push(`${category}: ${value}`);
      }
      if (e.message) messages.push(e.message);
    }
  }
  const message = messages.length
    ? messages.join(" | ")
    : err?.message || text.slice(0, 500) || `HTTP ${httpStatus}`;
  return new GoogleAdsApiError(message, httpStatus, err?.status || "", codes, requestId);
}

export class AdsClient {
  constructor(private config: AdsConfig) {}

  get loginCustomerId(): string {
    return this.config.loginCustomerId;
  }

  private async headers(): Promise<Record<string, string>> {
    const { token } = await this.config.auth.getAccessToken();
    if (!token) {
      throw new Error("Could not get a Google access token from the refresh token.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "login-customer-id": this.config.loginCustomerId,
      "Content-Type": "application/json",
    };
    // Since 2026-09-09 access is granted per Google Cloud project and the API
    // ignores this header; it's still sent when configured
    if (this.config.developerToken) {
      headers["developer-token"] = this.config.developerToken;
    }
    return headers;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    if (!READ_ONLY_PATHS.some((re) => re.test(path))) {
      throw new Error(`Refusing to call ${path}: this server is read-only.`);
    }
    const res = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: await this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw parseApiError(res.status, text);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * Customer IDs the authenticated Google user can access directly.
   */
  async listAccessibleCustomers(): Promise<string[]> {
    const data = (await this.request("GET", "customers:listAccessibleCustomers")) as {
      resourceNames?: string[];
    };
    return (data.resourceNames || []).map((r) => r.replace(/^customers\//, ""));
  }

  /**
   * Run a GAQL query with googleAds:searchStream (read-only) and return
   * flattened rows. The caller is responsible for adding a LIMIT clause;
   * at most maxRows rows are returned, with truncated=true if more came back.
   */
  async search(customerId: string, query: string, maxRows: number): Promise<QueryResult> {
    const id = normalizeCustomerId(customerId);
    const batches = (await this.request("POST", `customers/${id}/googleAds:searchStream`, {
      query,
    })) as { results?: Record<string, unknown>[] }[];

    const rows: Row[] = [];
    let total = 0;
    for (const batch of Array.isArray(batches) ? batches : [batches]) {
      for (const result of batch.results || []) {
        total++;
        if (rows.length < maxRows) {
          rows.push(flattenRow(result));
        }
      }
    }
    return { rows, truncated: total > maxRows };
  }
}

/**
 * Turn Google Ads API and OAuth errors into messages a non-developer can act on.
 */
export function friendlyAdsError(error: unknown): string {
  if (error instanceof GoogleAdsApiError) {
    const has = (code: string) => error.codes.some((c) => c.includes(code));
    const ref = error.requestId ? ` (request ID ${error.requestId})` : "";
    const details = `Details: ${error.message}${error.codes.length ? ` [${error.codes.join(", ")}]` : ""}${ref}`;

    // API access is granted per Google Cloud project: the one that owns the
    // OAuth client in GOOGLE_ADS_CLIENT_ID
    if (has("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION") || has("DEVELOPER_TOKEN_NOT_APPROVED")) {
      return `The Google Cloud project that owns this OAuth client only has Test access to the Google Ads API, so it can't read real accounts. In Google Cloud Console, open that project's Google Ads API Overview page and apply for Explorer access (enough for read-only reporting) or Basic access. ${details}`;
    }
    if (has("DEVELOPER_TOKEN")) {
      return `Google rejected the developer token. Developer tokens are optional since September 9, 2026; remove GOOGLE_ADS_DEVELOPER_TOKEN from the server's variables and retry. ${details}`;
    }
    if (has("authorizationError: AUTHORIZATION_ERROR")) {
      return `Google Ads returned a generic authorization error. If the Cloud project's API access level was upgraded after September 9, 2026, this is a known Google issue with a fix rolling out; retry later. Otherwise check that the Google user behind the refresh token can access the MCC and this account. ${details}`;
    }
    if (has("USER_PERMISSION_DENIED")) {
      return `This customer isn't accessible through the MCC in GOOGLE_ADS_LOGIN_CUSTOMER_ID. Check that the account is linked under that manager account (list_accounts shows the ones that are) and that the Google user who created the refresh token has access to the MCC. ${details}`;
    }
    if (has("CUSTOMER_NOT_ENABLED")) {
      return `This Google Ads account is not enabled (it may be cancelled, suspended or never finished setup), so it can't be queried. ${details}`;
    }
    if (has("INVALID_CUSTOMER_ID") || has("CUSTOMER_NOT_FOUND")) {
      return `Google Ads doesn't recognise that customer ID. Use list_accounts to get valid IDs. ${details}`;
    }
    if (has("queryError") || has("QUERY_ERROR")) {
      return `Invalid GAQL query. Check field names (they use snake_case, e.g. metrics.cost_micros), that every field is compatible with the FROM resource, and that string values in WHERE are in single quotes. ${details}`;
    }
    if (has("NOT_ADS_USER")) {
      return `The Google account behind the refresh token isn't a Google Ads user. Re-run \`npm run setup-auth\` signed in as a user with access to the MCC. ${details}`;
    }
    if (has("OAUTH_TOKEN") || error.httpStatus === 401) {
      return `Google authentication failed. Re-run \`npm run setup-auth\` and update GOOGLE_ADS_REFRESH_TOKEN. ${details}`;
    }
    if (has("SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(error.message)) {
      return `The Google Ads API is not enabled for the Google Cloud project behind your OAuth client. Enable "Google Ads API" in Google Cloud Console (APIs & Services > Library), wait a few minutes, then retry. ${details}`;
    }
    if (has("quotaError") || has("RESOURCE_EXHAUSTED") || error.httpStatus === 429) {
      return `Google Ads API quota or rate limit reached. Wait a minute and retry, or narrow the query. ${details}`;
    }
    if (error.httpStatus === 404) {
      return `Not found (404). The API version ${GOOGLE_ADS_API_VERSION} may have been sunset; update GOOGLE_ADS_API_VERSION in src/ads-client.ts. ${details}`;
    }
    if (error.httpStatus === 403) {
      return `Permission denied (403). ${details}`;
    }
    return `Google Ads API error (HTTP ${error.httpStatus}). ${details}`;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("invalid_grant")) {
    return "Google rejected the refresh token (invalid_grant). It may have been revoked, expired (tokens from OAuth apps in 'Testing' status expire after 7 days), or created with a different OAuth client. Run `npm run setup-auth` again and update GOOGLE_ADS_REFRESH_TOKEN.";
  }
  if (lower.includes("invalid_client") || lower.includes("unauthorized_client")) {
    return "Google rejected the OAuth client. Check that GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET match the client the refresh token was created with.";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `The Google Ads API didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s. Try a shorter date range or a lower limit.`;
  }
  return message;
}
