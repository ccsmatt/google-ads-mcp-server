import { OAuth2Client } from "google-auth-library";

/**
 * The only scope this server ever requests. Google Ads has no read-only
 * scope; read-only behaviour is enforced in code (no mutate calls exist).
 */
export const SCOPES = ["https://www.googleapis.com/auth/adwords"];

export interface AdsConfig {
  auth: OAuth2Client;
  developerToken?: string;
  loginCustomerId: string;
}

/**
 * Accept "123-456-7890", "1234567890" or "customers/1234567890" and return
 * the bare 10-digit ID.
 */
export function normalizeCustomerId(customerId: string): string {
  const id = String(customerId).trim().replace(/^customers\//, "").replace(/[-\s]/g, "");
  if (!/^\d{10}$/.test(id)) {
    throw new Error(
      `"${customerId}" is not a Google Ads customer ID. Use the 10-digit ID (e.g. "123-456-7890"); list_accounts shows the IDs you can access.`
    );
  }
  return id;
}

/**
 * Build the Google Ads config purely from environment variables:
 *   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID, and optionally GOOGLE_ADS_DEVELOPER_TOKEN
 *   (ignored by the API since developer tokens were sunset on 2026-09-09)
 *
 * The refresh token is exchanged for short-lived access tokens on demand,
 * so nothing is ever written to disk.
 *
 * Returns the names of any missing variables instead of a config.
 */
export function getAdsConfigFromEnv(): AdsConfig | { missing: string[] } {
  const required = [
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    return { missing };
  }

  const env = process.env as Record<string, string>;
  const auth = new OAuth2Client({
    clientId: env.GOOGLE_ADS_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET.trim(),
  });
  auth.setCredentials({ refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN.trim() });

  return {
    auth,
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined,
    loginCustomerId: normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  };
}
