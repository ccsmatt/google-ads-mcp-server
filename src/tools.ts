import { z } from "zod";
import { AdsClient, GoogleAdsApiError, Row, friendlyAdsError } from "./ads-client.js";
import { normalizeCustomerId } from "./auth.js";

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 1000;

// GAQL date presets accepted by "segments.date DURING <preset>"
const DATE_PRESETS = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "LAST_BUSINESS_WEEK",
  "THIS_WEEK_SUN_TODAY",
  "THIS_WEEK_MON_TODAY",
  "LAST_WEEK_SUN_SAT",
  "LAST_WEEK_MON_SUN",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;

const STATUSES = ["ENABLED", "PAUSED", "REMOVED"] as const;

// change_event.change_resource_type values most useful for auditing
const CHANGE_RESOURCE_TYPES = [
  "CAMPAIGN",
  "CAMPAIGN_BUDGET",
  "CAMPAIGN_CRITERION",
  "AD_GROUP",
  "AD_GROUP_AD",
  "AD_GROUP_CRITERION",
  "AD_GROUP_BID_MODIFIER",
  "AD",
  "ASSET",
  "CAMPAIGN_ASSET",
  "AD_GROUP_ASSET",
  "ASSET_GROUP",
] as const;

const CUSTOMER_ID_DESCRIPTION =
  "Google Ads customer ID of the client account, e.g. '123-456-7890' (dashes optional). Get IDs from list_accounts.";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

// Zod schemas for tool parameters
const customerIdSchema = z.string().transform((v) => normalizeCustomerId(v));
const limitSchema = z.number().int().min(1).max(MAX_ROW_LIMIT).optional().default(DEFAULT_ROW_LIMIT);

const dateRangeFields = {
  date_range: z.enum(DATE_PRESETS).optional(),
  start_date: isoDate.optional(),
  end_date: isoDate.optional(),
};

const campaignIdSchema = z
  .string()
  .regex(/^\d+$/, "must be a numeric campaign ID")
  .optional();

export const listAccountsSchema = z.object({
  name_filter: z.string().trim().min(1).optional(),
  include_inactive: z.boolean().optional().default(false),
  limit: limitSchema,
});

export const runGaqlSchema = z.object({
  customer_id: customerIdSchema,
  query: z.string().min(1),
  limit: limitSchema,
});

export const campaignPerformanceSchema = z.object({
  customer_id: customerIdSchema,
  ...dateRangeFields,
  status: z.array(z.enum(STATUSES)).optional(),
  limit: limitSchema,
});

export const adGroupPerformanceSchema = z.object({
  customer_id: customerIdSchema,
  ...dateRangeFields,
  status: z.array(z.enum(STATUSES)).optional(),
  campaign_id: campaignIdSchema,
  limit: limitSchema,
});

export const searchTermsSchema = z.object({
  customer_id: customerIdSchema,
  ...dateRangeFields,
  campaign_id: campaignIdSchema,
  min_cost: z.number().min(0).optional(),
  min_clicks: z.number().int().min(0).optional(),
  zero_conversions_only: z.boolean().optional().default(false),
  limit: limitSchema,
});

export const keywordPerformanceSchema = z.object({
  customer_id: customerIdSchema,
  ...dateRangeFields,
  status: z.array(z.enum(STATUSES)).optional(),
  campaign_id: campaignIdSchema,
  min_clicks: z.number().int().min(0).optional(),
  limit: limitSchema,
});

export const changeHistorySchema = z.object({
  customer_id: customerIdSchema,
  days: z.number().int().min(1).max(30).optional().default(14),
  resource_type: z.array(z.enum(CHANGE_RESOURCE_TYPES)).optional(),
  campaign_id: campaignIdSchema,
  limit: limitSchema,
});

export const adPerformanceSchema = z.object({
  customer_id: customerIdSchema,
  ...dateRangeFields,
  status: z.array(z.enum(STATUSES)).optional(),
  campaign_id: campaignIdSchema,
  limit: limitSchema,
});

export const conversionBreakdownSchema = z.object({
  customer_id: customerIdSchema,
  ...dateRangeFields,
  campaign_id: campaignIdSchema,
  limit: limitSchema,
});

export const searchCampaignsSchema = z.object({
  name_pattern: z.string().min(1).max(500),
  start_date: isoDate,
  end_date: isoDate,
  min_cost: z.number().min(0).optional().default(0),
  status: z.array(z.enum(STATUSES)).optional(),
  customer_ids: z.array(customerIdSchema).max(500).optional(),
  limit: limitSchema,
});

const customerIdJsonSchema = { type: "string", description: CUSTOMER_ID_DESCRIPTION };

const limitJsonSchema = {
  type: "integer",
  description: `Maximum rows to return (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). The output says when results were truncated.`,
};

const dateRangeJsonSchema = {
  date_range: {
    type: "string",
    enum: [...DATE_PRESETS],
    description:
      "GAQL date preset (default LAST_30_DAYS). Ignored if start_date and end_date are given. Dates are in the account's time zone.",
  },
  start_date: { type: "string", description: "Explicit start date, YYYY-MM-DD (use with end_date)" },
  end_date: { type: "string", description: "Explicit end date, YYYY-MM-DD, inclusive (use with start_date)" },
};

const statusJsonSchema = (entity: string) => ({
  type: "array",
  items: { type: "string", enum: [...STATUSES] },
  description: `Only include ${entity} with these statuses, e.g. ["ENABLED"]. Default: ENABLED and PAUSED (REMOVED excluded).`,
});

const campaignIdJsonSchema = {
  type: "string",
  description: "Optional numeric campaign ID to restrict results to one campaign",
};

export const TOOL_DEFINITIONS = [
  {
    name: "list_accounts",
    description:
      "List the Google Ads client accounts under the manager (MCC) account, with customer ID, name, currency, time zone and status. Call this first when you don't know the customer ID. The MCC has hundreds of accounts, so pass name_filter (part of the client's name) to find a specific one instead of listing them all.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name_filter: {
          type: "string",
          description:
            'Case-insensitive text to look for in the account name or customer ID, e.g. "smith plumbing" or "4267". Words are matched separately, so "smith plumb" finds "Smith & Sons Plumbing".',
        },
        include_inactive: {
          type: "boolean",
          description: "Also include cancelled, suspended and closed accounts (default false)",
        },
        limit: {
          type: "integer",
          description: `Maximum accounts to return (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). account_count always gives the full number of matches.`,
        },
      },
      required: [],
    },
  },
  {
    name: "run_gaql",
    description: `Run a read-only Google Ads Query Language (GAQL) SELECT query against one account and return the rows as JSON. Use this for anything the other tools don't cover.
- Only SELECT queries are accepted.
- Field names in the query are snake_case (metrics.cost_micros); keys in the returned rows are camelCase (metrics.costMicros).
- Monetary fields ending in _micros are in millionths of the account currency (divide by 1,000,000).
- If the query has no LIMIT, one is added from the limit parameter.
Example: SELECT campaign.name, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.cost_micros DESC`,
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        query: { type: "string", description: "A GAQL SELECT query" },
        limit: limitJsonSchema,
      },
      required: ["customer_id", "query"],
    },
  },
  {
    name: "campaign_performance",
    description:
      "Campaign performance for a date range: name, status, channel type, impressions, clicks, cost, conversions, conversion value, CTR, average CPC and cost per conversion. Costs are in the account currency (not micros). Sorted by cost, highest first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        ...dateRangeJsonSchema,
        status: statusJsonSchema("campaigns"),
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "ad_group_performance",
    description:
      "Ad group performance for a date range: campaign, ad group, status, impressions, clicks, cost, conversions, conversion value, CTR, average CPC and cost per conversion. Costs are in the account currency. Sorted by cost, highest first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        ...dateRangeJsonSchema,
        status: statusJsonSchema("ad groups"),
        campaign_id: campaignIdJsonSchema,
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "search_terms",
    description:
      "Search terms report: the actual searches that triggered ads, with the matched keyword and match type, campaign, ad group, impressions, clicks, cost, conversions and conversion value. Sorted by cost, highest first. Useful for finding wasted spend (set zero_conversions_only and min_cost) and negative keyword candidates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        ...dateRangeJsonSchema,
        campaign_id: campaignIdJsonSchema,
        min_cost: { type: "number", description: "Only search terms that cost at least this much (account currency)" },
        min_clicks: { type: "integer", description: "Only search terms with at least this many clicks" },
        zero_conversions_only: {
          type: "boolean",
          description: "Only search terms with zero conversions (default false)",
        },
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "keyword_performance",
    description:
      "Keyword performance for a date range: keyword text, match type, status, quality score (with expected CTR, ad relevance and landing page experience), campaign, ad group, impressions, clicks, cost, conversions, CTR, average CPC and cost per conversion. Costs are in the account currency. Sorted by cost, highest first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        ...dateRangeJsonSchema,
        status: statusJsonSchema("keywords"),
        campaign_id: campaignIdJsonSchema,
        min_clicks: { type: "integer", description: "Only keywords with at least this many clicks" },
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "change_history",
    description:
      "Change history (Google Ads change events) for the last N days, newest first: when, who (user email or tool), what kind of resource, the operation (CREATE/UPDATE/REMOVE), which campaign/ad group, and each changed field with its old and new value. Use it to explain sudden performance shifts (budget, bid strategy, status, keyword or ad changes). Google only keeps the last 30 days.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        days: { type: "integer", description: "How many days back to look (default 14, max 30)" },
        resource_type: {
          type: "array",
          items: { type: "string", enum: [...CHANGE_RESOURCE_TYPES] },
          description: 'Only these resource types, e.g. ["CAMPAIGN","CAMPAIGN_BUDGET"]. Default: all.',
        },
        campaign_id: campaignIdJsonSchema,
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "ad_performance",
    description:
      "Ad performance for a date range: ad ID, type, status, approval status, ad strength, final URL, headlines and descriptions (responsive search ads), campaign, ad group, impressions, clicks, cost, conversions, CTR, average CPC and cost per conversion. Costs are in the account currency. Sorted by cost, highest first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        ...dateRangeJsonSchema,
        status: statusJsonSchema("ads"),
        campaign_id: campaignIdJsonSchema,
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "conversion_breakdown",
    description:
      "Conversions split by conversion action (e.g. calls, form submits, purchases) per campaign, with the campaign's cost and the cost per conversion for each action. Use this for true cost per lead (CPL): the blended cost_per_conversion in other tools mixes every primary conversion action together. Also returns account-wide totals per action. 'conversions' counts only actions set as primary ('Include in Conversions'); 'all_conversions' includes secondary ones.",
    inputSchema: {
      type: "object" as const,
      properties: {
        customer_id: customerIdJsonSchema,
        ...dateRangeJsonSchema,
        campaign_id: campaignIdJsonSchema,
        limit: limitJsonSchema,
      },
      required: ["customer_id"],
    },
  },
  {
    name: "search_campaigns",
    description:
      "Find campaigns by name across many client accounts at once, e.g. every Christmas/holiday campaign in the MCC and what each spent. Matches a case-insensitive regex against campaign names in every enabled, non-manager account under the MCC (or only the given customer_ids), and returns one list sorted by cost with account, campaign, status, cost, clicks, conversions and cost per conversion. Only campaigns that spent more than min_cost in the date range are returned. Accounts that fail are reported in the summary without failing the whole search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name_pattern: {
          type: "string",
          description:
            'Case-insensitive regular expression (RE2 syntax) matched anywhere in the campaign name, e.g. "christmas|holiday" or "black ?friday". Lookarounds and backreferences are not supported.',
        },
        start_date: { type: "string", description: "Start date, YYYY-MM-DD" },
        end_date: { type: "string", description: "End date, YYYY-MM-DD, inclusive" },
        min_cost: {
          type: "number",
          description: "Only campaigns whose cost in the date range is greater than this (account currency, default 0)",
        },
        status: statusJsonSchema("campaigns"),
        customer_ids: {
          type: "array",
          items: { type: "string" },
          description: "Only search these customer IDs. Default: every ENABLED, non-manager client account under the MCC.",
        },
        limit: limitJsonSchema,
      },
      required: ["name_pattern", "start_date", "end_date"],
    },
  },
];

type DateRangeArgs = { date_range?: string; start_date?: string; end_date?: string };

function dateCondition(args: DateRangeArgs): { condition: string; description: string } {
  if (args.start_date || args.end_date) {
    if (!args.start_date || !args.end_date) {
      throw new Error("Give both start_date and end_date (YYYY-MM-DD), or use date_range instead.");
    }
    if (args.start_date > args.end_date) {
      throw new Error(`start_date (${args.start_date}) is after end_date (${args.end_date}).`);
    }
    return {
      condition: `segments.date BETWEEN '${args.start_date}' AND '${args.end_date}'`,
      description: `${args.start_date} to ${args.end_date}`,
    };
  }
  const preset = args.date_range || "LAST_30_DAYS";
  return { condition: `segments.date DURING ${preset}`, description: preset };
}

function statusCondition(field: string, statuses: readonly string[] | undefined): string {
  if (!statuses?.length) {
    return `${field} != 'REMOVED'`;
  }
  return `${field} IN (${statuses.map((s) => `'${s}'`).join(", ")})`;
}

const micros = (value: unknown) => (typeof value === "number" ? Math.round(value) / 1_000_000 : null);
const round = (value: unknown, digits = 2) =>
  typeof value === "number" ? Number(value.toFixed(digits)) : null;

const METRIC_FIELDS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.ctr",
  "metrics.average_cpc",
  "metrics.cost_per_conversion",
];

function metricColumns(r: Row) {
  return {
    impressions: r["metrics.impressions"] ?? 0,
    clicks: r["metrics.clicks"] ?? 0,
    cost: micros(r["metrics.costMicros"] ?? 0),
    conversions: round(r["metrics.conversions"] ?? 0),
    conversion_value: round(r["metrics.conversionsValue"] ?? 0),
    ctr_percent: round(typeof r["metrics.ctr"] === "number" ? (r["metrics.ctr"] as number) * 100 : null),
    avg_cpc: micros(r["metrics.averageCpc"]),
    cost_per_conversion: micros(r["metrics.costPerConversion"]),
  };
}

interface ReportOptions {
  customerId: string;
  select: string[];
  from: string;
  where: string[];
  dateDescription: string;
  limit: number;
  mapRow: (r: Row) => Record<string, unknown>;
}

/**
 * Shared runner for the wrapper tools: builds the GAQL, fetches one row
 * more than the limit to detect truncation, and reports the currency once
 * at the top instead of on every row.
 */
async function runReport(client: AdsClient, opts: ReportOptions) {
  const query = [
    `SELECT ${["customer.currency_code", ...opts.select].join(", ")}`,
    `FROM ${opts.from}`,
    `WHERE ${opts.where.join(" AND ")}`,
    "ORDER BY metrics.cost_micros DESC",
    `LIMIT ${opts.limit + 1}`,
  ].join(" ");
  const { rows } = await client.search(opts.customerId, query, opts.limit + 1);
  const truncated = rows.length > opts.limit;
  const kept = rows.slice(0, opts.limit);

  return {
    customer_id: opts.customerId,
    date_range: opts.dateDescription,
    currency: kept[0]?.["customer.currencyCode"] ?? undefined,
    returned_rows: kept.length,
    truncated,
    note: truncated
      ? `Results truncated to the top ${opts.limit} rows by cost. Raise limit (max ${MAX_ROW_LIMIT}) or add filters to see more.`
      : kept.length === 0
        ? "No rows with activity matched these filters in this date range."
        : undefined,
    rows: kept.map(opts.mapRow),
  };
}

/**
 * Accept only a single SELECT statement. The searchStream endpoint is
 * read-only regardless, but this keeps intent explicit and errors clear.
 */
function prepareGaql(raw: string, limit: number): { query: string; addedLimit: boolean } {
  // Drop trailing semicolons and whitespace
  const query = raw.trim().replace(/;+\s*$/, "").trim();
  if (!/^select\s/i.test(query)) {
    throw new Error("run_gaql only accepts read-only GAQL queries starting with SELECT.");
  }
  if (query.includes(";")) {
    throw new Error("run_gaql accepts a single SELECT query; remove the extra ';'.");
  }
  if (/\blimit\s+\d+/i.test(query)) {
    return { query, addedLimit: false };
  }
  // LIMIT must come before an optional PARAMETERS clause
  const paramsMatch = query.match(/\sPARAMETERS\s/i);
  if (paramsMatch?.index !== undefined) {
    return {
      query: `${query.slice(0, paramsMatch.index)} LIMIT ${limit + 1}${query.slice(paramsMatch.index)}`,
      addedLimit: true,
    };
  }
  return { query: `${query} LIMIT ${limit + 1}`, addedLimit: true };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function idFromResourceName(name: unknown): string | undefined {
  return typeof name === "string" ? name.split("/").pop() : undefined;
}

const snakeToCamel = (path: string) => path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function truncateValue(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text !== undefined && text.length > 300 ? `${text.slice(0, 300)}…` : value;
}

/**
 * Pull one changed field's value out of a flattened change_event row, where
 * old/new resources appear as "changeEvent.oldResource.<resource>.<field...>".
 */
function changedValue(row: Row, side: "oldResource" | "newResource", field: string): unknown {
  const prefix = `changeEvent.${side}.`;
  const matches: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith(prefix)) continue;
    // Drop the resource name segment, e.g. "campaign." in "campaign.status"
    const path = key.slice(prefix.length).split(".").slice(1).join(".");
    if (path === field) return truncateValue(value);
    if (path.startsWith(`${field}.`)) matches[path.slice(field.length + 1)] = truncateValue(value);
  }
  return Object.keys(matches).length ? matches : null;
}

function changedFieldList(row: Row): string[] {
  const raw = row["changeEvent.changedFields"] ?? row["changeEvent.changedFields.paths"];
  const paths = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : [];
  return paths.map((p) => snakeToCamel(p.trim())).filter(Boolean);
}

/**
 * Look up names for campaign/ad group IDs found in change events. Names are
 * a convenience, so a failed lookup just leaves them out.
 */
async function lookupNames(
  client: AdsClient,
  customerId: string,
  resource: "campaign" | "ad_group",
  ids: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids)].filter((id) => /^\d+$/.test(id)).slice(0, 1000);
  if (!unique.length) return names;
  const key = resource === "campaign" ? "campaign" : "adGroup";
  try {
    const { rows } = await client.search(
      customerId,
      `SELECT ${resource}.id, ${resource}.name FROM ${resource} WHERE ${resource}.id IN (${unique.join(", ")})`,
      unique.length
    );
    for (const r of rows) names.set(String(r[`${key}.id`]), String(r[`${key}.name`] ?? ""));
  } catch {
    // Leave names out
  }
  return names;
}

interface ClientAccount {
  customer_id: string;
  name: string;
  currency: string;
  time_zone: string;
  status: string;
  is_manager: boolean;
  level: number;
  test_account: boolean;
}

/**
 * Client accounts under the MCC (customer_client), excluding the MCC itself,
 * sorted by name.
 */
async function listClientAccounts(
  client: AdsClient,
  includeInactive: boolean
): Promise<{ accounts: ClientAccount[]; truncated: boolean }> {
  const mcc = client.loginCustomerId;
  const where = includeInactive ? "" : " WHERE customer_client.status = 'ENABLED'";
  const { rows, truncated } = await client.search(
    mcc,
    `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, customer_client.manager, customer_client.level, customer_client.test_account FROM customer_client${where}`,
    10_000
  );
  const accounts = rows
    .map((r) => ({
      customer_id: String(r["customerClient.id"] ?? ""),
      name: String(r["customerClient.descriptiveName"] ?? ""),
      currency: String(r["customerClient.currencyCode"] ?? ""),
      time_zone: String(r["customerClient.timeZone"] ?? ""),
      status: String(r["customerClient.status"] ?? ""),
      is_manager: Boolean(r["customerClient.manager"] ?? false),
      level: Number(r["customerClient.level"] ?? 0),
      test_account: Boolean(r["customerClient.testAccount"] ?? false),
    }))
    .filter((a) => a.customer_id !== mcc)
    // Unnamed accounts last, so they don't fill the first page
    .sort((a, b) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
  return { accounts, truncated };
}

const SEARCH_CONCURRENCY = 10;
const MAX_RETRIES = 4;

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof GoogleAdsApiError &&
    (error.httpStatus === 429 ||
      error.status === "RESOURCE_EXHAUSTED" ||
      error.codes.some((c) => c.startsWith("quotaError") || c.includes("RESOURCE_EXHAUSTED")))
  );
}

/**
 * Retry on rate-limit errors with exponential backoff and jitter
 * (about 1s, 2s, 4s, 8s); any other error is thrown straight away.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRateLimited(error)) throw error;
      const delay = 1000 * 2 ** attempt + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Run fn over items with at most `concurrency` calls in flight, keeping
 * results in input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Check a campaign-name pattern and turn it into a GAQL string literal.
 * GAQL uses RE2, which has no lookarounds or backreferences, so those are
 * rejected here with a clear message instead of failing in every account.
 */
function gaqlRegexLiteral(pattern: string): string {
  if (/\(\?[=!<]|\\[1-9]/.test(pattern)) {
    throw new Error("name_pattern can't use lookarounds or backreferences (Google Ads uses RE2 regex syntax).");
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    throw new Error(`name_pattern is not a valid regular expression: ${error instanceof Error ? error.message : error}`);
  }
  // Escape backslashes first, then single quotes, for the GAQL string literal
  const escaped = `(?i).*(${pattern}).*`.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function handleToolCall(
  client: AdsClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    switch (toolName) {
      case "list_accounts": {
        const params = listAccountsSchema.parse(args);
        const mcc = client.loginCustomerId;
        const { accounts: all } = await listClientAccounts(client, params.include_inactive);

        // Every word must appear in the name or ID, ignoring case, spaces,
        // dashes and punctuation ("smith plumb" matches "Smith & Sons Plumbing")
        const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
        const words = params.name_filter ? normalize(params.name_filter).split(" ").filter(Boolean) : [];
        const matches = words.length
          ? all.filter((a) => {
              const haystack = `${normalize(a.name)} ${a.customer_id}`;
              return words.every((w) => haystack.includes(w));
            })
          : all;
        const truncated = matches.length > params.limit;

        // Compact rows: flags only when they're true, to keep large MCCs small
        const accounts = matches.slice(0, params.limit).map((a) => ({
          customer_id: a.customer_id,
          name: a.name,
          currency: a.currency,
          time_zone: a.time_zone,
          status: a.status,
          ...(a.is_manager ? { is_manager: true } : {}),
          ...(a.test_account ? { test_account: true } : {}),
        }));

        let note: string | undefined;
        if (all.length === 0) {
          note = "No client accounts found under this MCC. Check GOOGLE_ADS_LOGIN_CUSTOMER_ID and that the accounts are linked to it.";
        } else if (matches.length === 0) {
          note = `No accounts match "${params.name_filter}". Try fewer or shorter words${params.include_inactive ? "" : ", or include_inactive: true"}.`;
        } else if (truncated) {
          note = `Showing ${params.limit} of ${matches.length} accounts (sorted by name). Use name_filter to find a specific client, or raise limit (max ${MAX_ROW_LIMIT}).`;
        } else if (accounts.some((a) => a.is_manager)) {
          note = "is_manager=true rows are sub-manager accounts; query their client accounts directly by customer_id.";
        }

        // One account per line: readable, and far smaller than indented JSON
        const lines = [
          JSON.stringify({ manager_customer_id: mcc, account_count: matches.length, returned: accounts.length, truncated, note }),
          ...accounts.map((a) => JSON.stringify(a)),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      case "run_gaql": {
        const params = runGaqlSchema.parse(args);
        const { query, addedLimit } = prepareGaql(params.query, params.limit);
        const { rows, truncated } = await client.search(params.customer_id, query, params.limit);
        return textResult({
          customer_id: params.customer_id,
          query,
          returned_rows: rows.length,
          truncated,
          note: truncated
            ? `Results truncated to ${params.limit} rows${addedLimit ? "" : " (the query's own LIMIT is higher)"}. Raise limit (max ${MAX_ROW_LIMIT}), add filters, or aggregate further.`
            : undefined,
          rows,
        });
      }

      case "campaign_performance": {
        const params = campaignPerformanceSchema.parse(args);
        const date = dateCondition(params);
        return textResult(
          await runReport(client, {
            customerId: params.customer_id,
            select: [
              "campaign.id",
              "campaign.name",
              "campaign.status",
              "campaign.advertising_channel_type",
              ...METRIC_FIELDS,
            ],
            from: "campaign",
            where: [date.condition, statusCondition("campaign.status", params.status)],
            dateDescription: date.description,
            limit: params.limit,
            mapRow: (r) => ({
              campaign_id: r["campaign.id"],
              campaign: r["campaign.name"],
              status: r["campaign.status"],
              channel: r["campaign.advertisingChannelType"],
              ...metricColumns(r),
            }),
          })
        );
      }

      case "ad_group_performance": {
        const params = adGroupPerformanceSchema.parse(args);
        const date = dateCondition(params);
        const where = [date.condition, statusCondition("ad_group.status", params.status)];
        if (params.campaign_id) where.push(`campaign.id = ${params.campaign_id}`);
        return textResult(
          await runReport(client, {
            customerId: params.customer_id,
            select: [
              "campaign.id",
              "campaign.name",
              "ad_group.id",
              "ad_group.name",
              "ad_group.status",
              ...METRIC_FIELDS,
            ],
            from: "ad_group",
            where,
            dateDescription: date.description,
            limit: params.limit,
            mapRow: (r) => ({
              campaign_id: r["campaign.id"],
              campaign: r["campaign.name"],
              ad_group_id: r["adGroup.id"],
              ad_group: r["adGroup.name"],
              status: r["adGroup.status"],
              ...metricColumns(r),
            }),
          })
        );
      }

      case "search_terms": {
        const params = searchTermsSchema.parse(args);
        const date = dateCondition(params);
        const where = [date.condition];
        if (params.campaign_id) where.push(`campaign.id = ${params.campaign_id}`);
        if (params.min_cost !== undefined) where.push(`metrics.cost_micros >= ${Math.round(params.min_cost * 1_000_000)}`);
        if (params.min_clicks !== undefined) where.push(`metrics.clicks >= ${params.min_clicks}`);
        if (params.zero_conversions_only) where.push("metrics.conversions = 0");
        return textResult(
          await runReport(client, {
            customerId: params.customer_id,
            select: [
              "search_term_view.search_term",
              "search_term_view.status",
              "segments.keyword.info.text",
              "segments.keyword.info.match_type",
              "campaign.name",
              "ad_group.name",
              "metrics.impressions",
              "metrics.clicks",
              "metrics.cost_micros",
              "metrics.conversions",
              "metrics.conversions_value",
            ],
            from: "search_term_view",
            where,
            dateDescription: date.description,
            limit: params.limit,
            mapRow: (r) => ({
              search_term: r["searchTermView.searchTerm"],
              matched_keyword: r["segments.keyword.info.text"] ?? null,
              match_type: r["segments.keyword.info.matchType"] ?? null,
              // ADDED/EXCLUDED/ADDED_EXCLUDED/NONE: whether the term is already a keyword or negative
              term_status: r["searchTermView.status"],
              campaign: r["campaign.name"],
              ad_group: r["adGroup.name"],
              impressions: r["metrics.impressions"] ?? 0,
              clicks: r["metrics.clicks"] ?? 0,
              cost: micros(r["metrics.costMicros"] ?? 0),
              conversions: round(r["metrics.conversions"] ?? 0),
              conversion_value: round(r["metrics.conversionsValue"] ?? 0),
            }),
          })
        );
      }

      case "keyword_performance": {
        const params = keywordPerformanceSchema.parse(args);
        const date = dateCondition(params);
        const where = [
          date.condition,
          statusCondition("ad_group_criterion.status", params.status),
          "ad_group_criterion.negative = FALSE",
        ];
        if (params.campaign_id) where.push(`campaign.id = ${params.campaign_id}`);
        if (params.min_clicks !== undefined) where.push(`metrics.clicks >= ${params.min_clicks}`);
        return textResult(
          await runReport(client, {
            customerId: params.customer_id,
            select: [
              "ad_group_criterion.criterion_id",
              "ad_group_criterion.keyword.text",
              "ad_group_criterion.keyword.match_type",
              "ad_group_criterion.status",
              "ad_group_criterion.quality_info.quality_score",
              "ad_group_criterion.quality_info.search_predicted_ctr",
              "ad_group_criterion.quality_info.creative_quality_score",
              "ad_group_criterion.quality_info.post_click_quality_score",
              "campaign.name",
              "ad_group.name",
              ...METRIC_FIELDS,
            ],
            from: "keyword_view",
            where,
            dateDescription: date.description,
            limit: params.limit,
            mapRow: (r) => ({
              keyword: r["adGroupCriterion.keyword.text"],
              match_type: r["adGroupCriterion.keyword.matchType"],
              status: r["adGroupCriterion.status"],
              quality_score: r["adGroupCriterion.qualityInfo.qualityScore"] ?? null,
              expected_ctr: r["adGroupCriterion.qualityInfo.searchPredictedCtr"] ?? null,
              ad_relevance: r["adGroupCriterion.qualityInfo.creativeQualityScore"] ?? null,
              landing_page_experience: r["adGroupCriterion.qualityInfo.postClickQualityScore"] ?? null,
              campaign: r["campaign.name"],
              ad_group: r["adGroup.name"],
              ...metricColumns(r),
            }),
          })
        );
      }

      case "change_history": {
        const params = changeHistorySchema.parse(args);
        // Google only serves the last 30 days and requires an explicit range
        // and LIMIT. The end is tomorrow (UTC) so time zones ahead of UTC
        // still get today's changes.
        const now = new Date();
        const start = new Date(now.getTime() - (params.days - 1) * 86_400_000);
        const end = new Date(now.getTime() + 86_400_000);
        const where = [
          `change_event.change_date_time >= '${isoDay(start)} 00:00:00'`,
          `change_event.change_date_time <= '${isoDay(end)} 23:59:59'`,
        ];
        if (params.resource_type?.length) {
          where.push(`change_event.change_resource_type IN (${params.resource_type.map((t) => `'${t}'`).join(", ")})`);
        }
        if (params.campaign_id) {
          where.push(`change_event.campaign = 'customers/${params.customer_id}/campaigns/${params.campaign_id}'`);
        }
        const query = [
          "SELECT change_event.change_date_time, change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields, change_event.user_email, change_event.client_type, change_event.campaign, change_event.ad_group, change_event.change_resource_name, change_event.old_resource, change_event.new_resource",
          "FROM change_event",
          `WHERE ${where.join(" AND ")}`,
          "ORDER BY change_event.change_date_time DESC",
          `LIMIT ${params.limit + 1}`,
        ].join(" ");
        const { rows } = await client.search(params.customer_id, query, params.limit + 1);
        const truncated = rows.length > params.limit;
        const kept = rows.slice(0, params.limit);

        const campaignIds = kept.map((r) => idFromResourceName(r["changeEvent.campaign"])).filter(Boolean) as string[];
        const adGroupIds = kept.map((r) => idFromResourceName(r["changeEvent.adGroup"])).filter(Boolean) as string[];
        const [campaignNames, adGroupNames] = await Promise.all([
          lookupNames(client, params.customer_id, "campaign", campaignIds),
          lookupNames(client, params.customer_id, "ad_group", adGroupIds),
        ]);

        return textResult({
          customer_id: params.customer_id,
          period: `last ${params.days} days (account time zone)`,
          returned_rows: kept.length,
          truncated,
          note: truncated
            ? `Showing the newest ${params.limit} changes. Raise limit (max ${MAX_ROW_LIMIT}), shorten days, or filter by resource_type or campaign_id.`
            : kept.length === 0
              ? "No changes found in this period."
              : undefined,
          changes: kept.map((r) => {
            const campaignId = idFromResourceName(r["changeEvent.campaign"]);
            const adGroupId = idFromResourceName(r["changeEvent.adGroup"]);
            return {
              changed_at: r["changeEvent.changeDateTime"],
              changed_by: r["changeEvent.userEmail"] ?? null,
              client: r["changeEvent.clientType"] ?? null,
              resource_type: r["changeEvent.changeResourceType"],
              operation: r["changeEvent.resourceChangeOperation"],
              campaign: campaignId ? campaignNames.get(campaignId) ?? campaignId : null,
              ad_group: adGroupId ? adGroupNames.get(adGroupId) ?? adGroupId : null,
              resource: r["changeEvent.changeResourceName"],
              changes: changedFieldList(r).map((field) => {
                const oldValue = changedValue(r, "oldResource", field);
                const newValue = changedValue(r, "newResource", field);
                // Show budgets, bids and targets in currency rather than micros
                if (field.endsWith("Micros")) {
                  return {
                    field: `${field.slice(0, -"Micros".length)} (currency)`,
                    old: typeof oldValue === "number" ? micros(oldValue) : oldValue,
                    new: typeof newValue === "number" ? micros(newValue) : newValue,
                  };
                }
                return { field, old: oldValue, new: newValue };
              }),
            };
          }),
        });
      }

      case "ad_performance": {
        const params = adPerformanceSchema.parse(args);
        const date = dateCondition(params);
        const where = [date.condition, statusCondition("ad_group_ad.status", params.status)];
        if (params.campaign_id) where.push(`campaign.id = ${params.campaign_id}`);
        const texts = (value: unknown) =>
          Array.isArray(value) ? value.map((a) => (a as { text?: string })?.text).filter(Boolean) : undefined;
        return textResult(
          await runReport(client, {
            customerId: params.customer_id,
            select: [
              "ad_group_ad.ad.id",
              "ad_group_ad.ad.type",
              "ad_group_ad.ad.name",
              "ad_group_ad.ad.final_urls",
              "ad_group_ad.ad.responsive_search_ad.headlines",
              "ad_group_ad.ad.responsive_search_ad.descriptions",
              "ad_group_ad.status",
              "ad_group_ad.policy_summary.approval_status",
              "ad_group_ad.ad_strength",
              "campaign.name",
              "ad_group.name",
              ...METRIC_FIELDS,
            ],
            from: "ad_group_ad",
            where,
            dateDescription: date.description,
            limit: params.limit,
            mapRow: (r) => ({
              ad_id: r["adGroupAd.ad.id"],
              type: r["adGroupAd.ad.type"],
              name: r["adGroupAd.ad.name"] ?? undefined,
              status: r["adGroupAd.status"],
              approval_status: r["adGroupAd.policySummary.approvalStatus"] ?? null,
              ad_strength: r["adGroupAd.adStrength"] ?? null,
              final_url: Array.isArray(r["adGroupAd.ad.finalUrls"]) ? r["adGroupAd.ad.finalUrls"][0] : null,
              headlines: texts(r["adGroupAd.ad.responsiveSearchAd.headlines"]),
              descriptions: texts(r["adGroupAd.ad.responsiveSearchAd.descriptions"]),
              campaign: r["campaign.name"],
              ad_group: r["adGroup.name"],
              ...metricColumns(r),
            }),
          })
        );
      }

      case "conversion_breakdown": {
        const params = conversionBreakdownSchema.parse(args);
        const date = dateCondition(params);
        const where = [date.condition];
        if (params.campaign_id) where.push(`campaign.id = ${params.campaign_id}`);

        // Cost can't be segmented by conversion action, so fetch campaign
        // cost and per-action conversions separately and join them
        const [costResult, convResult] = await Promise.all([
          client.search(
            params.customer_id,
            `SELECT customer.currency_code, campaign.id, campaign.name, campaign.status, metrics.cost_micros FROM campaign WHERE ${where.join(" AND ")} AND metrics.cost_micros > 0`,
            10_000
          ),
          client.search(
            params.customer_id,
            `SELECT campaign.id, campaign.name, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.all_conversions, metrics.conversions_value FROM campaign WHERE ${where.join(" AND ")} AND metrics.all_conversions > 0`,
            10_000
          ),
        ]);

        const campaigns = new Map<string, { name: unknown; status: unknown; cost: number }>();
        for (const r of costResult.rows) {
          campaigns.set(String(r["campaign.id"]), {
            name: r["campaign.name"],
            status: r["campaign.status"],
            cost: micros(r["metrics.costMicros"] ?? 0) ?? 0,
          });
        }
        const totalCost = [...campaigns.values()].reduce((sum, c) => sum + c.cost, 0);
        const perCost = (cost: number, conversions: number) => (conversions > 0 ? round(cost / conversions) : null);

        const totals = new Map<string, { category: unknown; conversions: number; all_conversions: number; value: number }>();
        const rows = convResult.rows.map((r) => {
          const campaign = campaigns.get(String(r["campaign.id"]));
          const action = String(r["segments.conversionActionName"] ?? "");
          const conversions = Number(r["metrics.conversions"] ?? 0);
          const allConversions = Number(r["metrics.allConversions"] ?? 0);
          const value = Number(r["metrics.conversionsValue"] ?? 0);
          const t = totals.get(action) ?? { category: r["segments.conversionActionCategory"], conversions: 0, all_conversions: 0, value: 0 };
          t.conversions += conversions;
          t.all_conversions += allConversions;
          t.value += value;
          totals.set(action, t);
          const cost = campaign?.cost ?? 0;
          return {
            campaign: campaign?.name ?? r["campaign.name"],
            campaign_status: campaign?.status ?? null,
            conversion_action: action,
            category: r["segments.conversionActionCategory"],
            conversions: round(conversions),
            all_conversions: round(allConversions),
            conversion_value: round(value),
            campaign_cost: round(cost),
            cost_per_conversion: perCost(cost, conversions),
            cost_per_all_conversion: perCost(cost, allConversions),
          };
        });
        rows.sort((a, b) => (b.campaign_cost ?? 0) - (a.campaign_cost ?? 0) || (b.all_conversions ?? 0) - (a.all_conversions ?? 0));
        const truncated = rows.length > params.limit;

        return textResult({
          customer_id: params.customer_id,
          date_range: date.description,
          currency: costResult.rows[0]?.["customer.currencyCode"] ?? undefined,
          total_cost: round(totalCost),
          note: [
            "cost_per_conversion divides the campaign's whole cost by that one action's conversions, so it is the true cost per lead only for the action you treat as a lead.",
            truncated ? `Campaign rows truncated to ${params.limit}; account_totals still cover everything.` : "",
            rows.length === 0 ? "No conversions recorded in this date range." : "",
          ]
            .filter(Boolean)
            .join(" "),
          account_totals: [...totals.entries()]
            .map(([action, t]) => ({
              conversion_action: action,
              category: t.category,
              conversions: round(t.conversions),
              all_conversions: round(t.all_conversions),
              conversion_value: round(t.value),
              cost_per_conversion: perCost(totalCost, t.conversions),
              cost_per_all_conversion: perCost(totalCost, t.all_conversions),
            }))
            .sort((a, b) => (b.all_conversions ?? 0) - (a.all_conversions ?? 0)),
          returned_rows: Math.min(rows.length, params.limit),
          truncated,
          rows: rows.slice(0, params.limit),
        });
      }

      case "search_campaigns": {
        const params = searchCampaignsSchema.parse(args);
        if (params.start_date > params.end_date) {
          throw new Error(`start_date (${params.start_date}) is after end_date (${params.end_date}).`);
        }
        const regex = gaqlRegexLiteral(params.name_pattern);

        // Account names and currencies come from the MCC's client list; with
        // explicit customer_ids, inactive accounts are looked up too
        const { accounts: allAccounts } = await withRetry(() =>
          listClientAccounts(client, Boolean(params.customer_ids?.length))
        );
        const byId = new Map(allAccounts.map((a) => [a.customer_id, a]));
        const targets: { customer_id: string; name: string; currency: string }[] = params.customer_ids?.length
          ? [...new Set(params.customer_ids)].map((id) => ({
              customer_id: id,
              name: byId.get(id)?.name ?? "",
              currency: byId.get(id)?.currency ?? "",
            }))
          : allAccounts.filter((a) => !a.is_manager && a.status === "ENABLED");

        const query = [
          "SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.conversions",
          "FROM campaign",
          `WHERE segments.date BETWEEN '${params.start_date}' AND '${params.end_date}'`,
          `AND metrics.cost_micros > ${Math.round(params.min_cost * 1_000_000)}`,
          `AND ${statusCondition("campaign.status", params.status)}`,
          `AND campaign.name REGEXP_MATCH ${regex}`,
          "ORDER BY metrics.cost_micros DESC",
          "LIMIT 10000",
        ].join(" ");

        const outcomes = await mapWithConcurrency(targets, SEARCH_CONCURRENCY, async (account) => {
          try {
            const { rows } = await withRetry(() => client.search(account.customer_id, query, 10_000));
            return { account, rows };
          } catch (error) {
            return { account, error: friendlyAdsError(error) };
          }
        });

        const matches = outcomes.flatMap((o) =>
          (o.rows || []).map((r) => {
            const cost = micros(r["metrics.costMicros"] ?? 0) ?? 0;
            const conversions = Number(r["metrics.conversions"] ?? 0);
            return {
              account_id: o.account.customer_id,
              account_name: o.account.name,
              currency: o.account.currency || null,
              campaign_id: r["campaign.id"],
              campaign: r["campaign.name"],
              status: r["campaign.status"],
              cost,
              clicks: r["metrics.clicks"] ?? 0,
              conversions: round(conversions),
              cost_per_conversion: conversions > 0 ? round(cost / conversions) : null,
            };
          })
        );
        matches.sort((a, b) => b.cost - a.cost);

        // Accounts can use different currencies, so spend is totalled per currency
        const spendByCurrency: Record<string, number> = {};
        for (const m of matches) {
          const key = m.currency || "unknown";
          spendByCurrency[key] = round((spendByCurrency[key] ?? 0) + m.cost) ?? 0;
        }
        const errored = outcomes
          .filter((o) => o.error)
          .map((o) => ({ account_id: o.account.customer_id, account_name: o.account.name, error: o.error }));
        const truncated = matches.length > params.limit;

        return textResult({
          summary: {
            pattern: params.name_pattern,
            date_range: `${params.start_date} to ${params.end_date}`,
            accounts_searched: targets.length,
            accounts_with_matches: new Set(matches.map((m) => m.account_id)).size,
            accounts_errored: errored.length,
            matching_campaigns: matches.length,
            total_spend: spendByCurrency,
            errors: errored.length ? errored : undefined,
          },
          returned_rows: Math.min(matches.length, params.limit),
          truncated,
          note: truncated
            ? `Showing the top ${params.limit} campaigns by cost; summary totals cover all ${matches.length}. Raise limit (max ${MAX_ROW_LIMIT}) or min_cost to see more.`
            : targets.length === 0
              ? "No accounts to search: no ENABLED, non-manager client accounts were found under the MCC."
              : matches.length === 0
                ? "No campaigns matched this pattern with spend above min_cost in the date range."
                : undefined,
          campaigns: matches.slice(0, params.limit),
        });
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${toolName}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Invalid arguments: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`
        : friendlyAdsError(error);
    return {
      content: [
        {
          type: "text",
          text: `Error executing ${toolName}: ${message}`,
        },
      ],
      isError: true,
    };
  }
}
