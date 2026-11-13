# Google Ads MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude query Google Ads accounts under a manager (MCC) account. Deploy it once (for example on Railway), add it to your Claude Team plan as a custom connector, and anyone on the team can ask things like:

- "Which campaigns spent the most last month, and what was their cost per conversion?"
- "Show search terms in account 123-456-7890 that cost over $20 in the last 30 days with zero conversions"
- "Which keywords have a quality score below 5 and still get clicks?"
- "Compare ad group CTR this month vs last month for the Brand campaign"
- "What changed in this account in the last two weeks, and could it explain the drop in calls?"
- "What's our cost per lead for phone calls vs form fills by campaign last month?"

It is **read-only**. Google offers no read-only Ads scope, so the token uses `https://www.googleapis.com/auth/adwords`, but the server only calls the read-only `googleAds:searchStream` and `customers:listAccessibleCustomers` endpoints, refuses to call any other endpoint, has no mutate code at all, and `run_gaql` rejects anything that isn't a `SELECT`. For a guarantee enforced by Google, create the refresh token with a Google user that has **Read only** access to the MCC (step 2).

> Based on [ccsmatt/ga-mcp-server](https://github.com/ccsmatt/ga-mcp-server), itself derived from [sofianbettayeb/gsc-mcp-server](https://github.com/sofianbettayeb/gsc-mcp-server) by Sofian Bettayeb (MIT). The HTTP transport, auth and deployment setup come from those projects; the tools are new.

## Tools

| Tool | What it does |
| --- | --- |
| `list_accounts` | Client accounts under the MCC: customer ID, name, currency, time zone, status |
| `run_gaql` | Any read-only GAQL `SELECT` query against one account; rows returned as JSON |
| `campaign_performance` | Per campaign: status, impressions, clicks, cost, conversions, conversion value, CTR, avg CPC, cost/conv |
| `ad_group_performance` | Same metrics per ad group (optionally one campaign) |
| `search_terms` | Search terms with matched keyword, campaign, ad group, clicks, cost, conversions; filters for min cost, min clicks, zero conversions |
| `keyword_performance` | Keywords with quality score (and its components) plus performance metrics |
| `ad_performance` | Ads with type, status, approval status, ad strength, final URL, headlines/descriptions, plus performance metrics |
| `conversion_breakdown` | Conversions per conversion action (calls, forms, ...) per campaign, with cost per conversion for each: true cost per lead |
| `change_history` | Who changed what and when (last 30 days max), with old and new values for each changed field |

Details:

- **Dates:** the report tools take either `date_range` (a GAQL preset such as `LAST_7_DAYS`, `LAST_30_DAYS`, `THIS_MONTH`, `LAST_MONTH`; default `LAST_30_DAYS`) or `start_date` + `end_date` (`YYYY-MM-DD`).
- **Money:** the report tools return costs in the account's currency (cost_micros / 1,000,000). The currency is shown at the top of each result. `run_gaql` returns raw API values, so `_micros` fields stay in micros.
- **Row cap:** results are capped at `limit` rows (default 100, max 1000). Output includes `truncated: true` and a note when there were more.
- **API version:** the server uses Google Ads API **v26**, set by `GOOGLE_ADS_API_VERSION` in [src/ads-client.ts](src/ads-client.ts). Google sunsets each version about a year after release ([release notes](https://developers.google.com/google-ads/api/docs/release-notes)), so bump it when needed.

## How it works

- One HTTP endpoint, `POST /mcp` (stateless streamable HTTP), plus `GET /healthz` for health checks.
- Every `/mcp` request must carry `Authorization: Bearer <MCP_AUTH_TOKEN>`. The server **refuses to start** if `MCP_AUTH_TOKEN` is not set.
- The server reads Google Ads as **one Google user** (whoever created the refresh token), through **one MCC**. Every API request sends `login-customer-id` set to the MCC ID, plus the `developer-token` header if you set one. Everyone who uses the connector sees every account under that MCC.
- API access (Test, Explorer, Basic or Standard) belongs to the **Google Cloud project that owns the OAuth client**, not to a developer token. Google [sunset developer tokens on September 9, 2026](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).
- All credentials come from environment variables. Nothing is written to disk.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | yes | OAuth client ID (Desktop app type) |
| `GOOGLE_ADS_CLIENT_SECRET` | yes | OAuth client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | yes | From `npm run setup-auth` (step 3) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | yes | Your MCC customer ID, e.g. `123-456-7890` (dashes are stripped) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | no | Optional. Sent if set, but ignored by Google since September 9, 2026 |
| `MCP_AUTH_TOKEN` | yes | Long random string Claude must send as a Bearer token |
| `PORT` | no | Listen port (default 8080; Railway sets this for you) |

## 1. Google Cloud project and API access

Google Ads API access levels are granted to a **Google Cloud project**: the one that owns the OAuth client you create in step 2. See [Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels).

| Level | Real (production) accounts | Daily limit | How you get it |
| --- | --- | --- | --- |
| Test | No, test accounts only | 15,000 ops | Automatic when you enable the API |
| Explorer | Yes | 2,880 ops (production) | Apply; often approved automatically |
| Basic | Yes | 15,000 ops | Apply; brand verification required |
| Standard | Yes | Unlimited | Detailed manual review |

**Explorer** is enough for this server: it is read-only reporting, and each tool call is one search request.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and pick the project:
   - **If you used the Google Ads API before September 9, 2026**, Google moved your old developer token's access level to the Cloud project(s) used with it in the previous 90 days. Use that project, so you keep the level.
   - Otherwise **create a new project** just for this server, inside your Google Workspace organization if you have one. Don't add the Ads scope to another server's project: `adwords` is a sensitive scope, so it changes that project's verification status and can trigger Google's "This app is blocked" screen.
2. **Enable the API** (APIs & Services > Library): search for **Google Ads API** and click **Enable**. The project now has **Test** access.
3. **Apply for production access**: open the project's **Google Ads API** page (APIs & Services > Enabled APIs & services > Google Ads API) and apply for **Explorer** (or **Basic**) access from its **Overview**. Until this is granted, calls to real accounts fail with `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`.
4. **Configure the OAuth consent screen** (Google Auth Platform):
   - **Branding**: app name (e.g. "Google Ads MCP") and your support email.
   - **Audience**:
     - If your Google account is part of a **Google Workspace** organization, choose **Internal**. Tokens don't expire and no verification is needed.
     - Otherwise choose **External**, add yourself as a test user, then **Publish app** (set it to *In production*). Apps left in *Testing* issue refresh tokens that **expire after 7 days**. An unverified production app shows an "unverified app" warning during consent; as the owner you can click *Advanced > Go to ... (unsafe)* to continue.
   - **Data Access**: add the scope `https://www.googleapis.com/auth/adwords` (shown as ".../auth/adwords").

## 2. Create the OAuth client

1. Google Auth Platform > **Clients** > **Create client**.
2. Application type: **Desktop app**. Give it a name and click **Create**.
3. Copy the **Client ID** and **Client secret**. Create the client **in the project from step 1**, since that project's access level is the one that counts. Don't download the JSON into this repo. It's git-ignored, but you don't need it.

Make sure the Google account you'll sign in with has access to the MCC (Google Ads > Admin > Access and security).

**Recommended: use a Read only Google Ads user.** The `adwords` scope can't be narrowed, but the token can never do more than its Google user can. In the MCC go to **Admin > Access and security > + (add user)**, invite a Google account with access level **Read only**, and sign in as that account in step 3. Google Ads itself then rejects any change, whatever the software does.

## 3. Get a refresh token

You need [Node.js 22+](https://nodejs.org/) and a copy of this repo.

```bash
git clone https://github.com/ccsmatt/google-ads-mcp-server.git
cd google-ads-mcp-server
npm install
```

Then run the helper with your client ID and secret as environment variables.

PowerShell (Windows):

```powershell
$env:GOOGLE_ADS_CLIENT_ID = "your-client-id.apps.googleusercontent.com"
$env:GOOGLE_ADS_CLIENT_SECRET = "your-client-secret"
npm run setup-auth
```

macOS / Linux:

```bash
GOOGLE_ADS_CLIENT_ID="your-client-id.apps.googleusercontent.com" GOOGLE_ADS_CLIENT_SECRET="your-client-secret" npm run setup-auth
```

The script:

1. Prints a Google consent URL. Open it in an **incognito/private window** and sign in with the Google account that has access to your MCC.
2. Approve access. Google describes it as "See, edit, create and delete your Google Ads accounts and data", because that's the only Ads scope; this server only reads.
3. Your browser then goes to `http://localhost/?code=...` and shows a **"can't connect"** page. That's expected. Copy the full address from the address bar (or just the `code` value) and paste it into the terminal.
4. The script prints **only the refresh token**. Copy it somewhere safe (e.g. your password manager).

Nothing is written to disk. Close the terminal afterwards so the client secret isn't left in its environment.

If you get `invalid_grant`, the code expired or was already used. Run it again and paste promptly.

## 4. Choose an MCP auth token

`MCP_AUTH_TOKEN` is the password Claude uses to call your server. Generate a long random one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Deploy to Railway

1. In [Railway](https://railway.com/), click **New Project** > **Deploy from GitHub repo** and pick `google-ads-mcp-server`. Railway finds the `Dockerfile` and builds with it.
2. Open the service > **Variables** and add `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` and `MCP_AUTH_TOKEN`. Don't set `PORT`; Railway provides it.
3. **Settings > Networking > Generate Domain** to get a public URL like `https://google-ads-mcp-server-production.up.railway.app`.
4. Optional: **Settings > Deploy > Healthcheck Path** = `/healthz`.
5. Check it: opening `https://<your-domain>/healthz` should show `{"status":"ok"}`, and the deploy logs should say `google-ads-mcp-server listening on port ...`. If the logs say a variable is missing, fix it under **Variables**; Railway redeploys automatically.

Your MCP endpoint is `https://<your-domain>/mcp`.

## 6. Add it to Claude (Team plan)

An **Owner** of the Claude Team organization does this once:

1. Go to [**Organization settings > Connectors**](https://claude.ai/admin-settings/connectors), select **Add**, then **Custom** (choose **Web** if asked).
2. **Name**: e.g. "Google Ads". **MCP server URL**: `https://<your-domain>/mcp`.
3. **Authentication**: **No sign-in**.
4. **Request headers**: header name `authorization`, value `Bearer <your MCP_AUTH_TOKEN>`. Type the word `Bearer`, a space, then the token; Claude sends the value exactly as entered. Mark it **Required**.
5. Click **Add**.

Team members then go to **Customize > Connectors**, find the connector with the **Custom** label and click **Connect**. In a chat, turn it on from the **+** menu > **Connectors**.

To change the token later, update `MCP_AUTH_TOKEN` in Railway, then remove and re-add the connector with the new header (headers can't be edited after saving).

### Claude Code (CLI)

```bash
claude mcp add --transport http google-ads https://<your-domain>/mcp --header "Authorization: Bearer <your MCP_AUTH_TOKEN>"
```

## Local development

```bash
cp .env.example .env    # fill in real values; .env is git-ignored
npm run build
npm start               # or: npm run dev
```

`npm start` doesn't load `.env` by itself, so export the variables in your shell first (or use your editor's env support). Then check `http://localhost:8080/healthz`.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `only has Test access` (`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`) | The Cloud project that owns the OAuth client needs Explorer or Basic access (step 1.3). |
| `generic authorization error` (`AUTHORIZATION_ERROR`) | Known Google issue for projects upgraded after September 9, 2026; Google says a fix is rolling out. Otherwise check MCC access. |
| `Google rejected the developer token` | Remove `GOOGLE_ADS_DEVELOPER_TOKEN`; it's optional now. |
| `customer isn't accessible through the MCC` | The account isn't linked under `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, or the token's Google user can't access the MCC. |
| `Invalid GAQL query` | Check field names (snake_case), field/resource compatibility, and quoting. The [Query Builder](https://developers.google.com/google-ads/api/fields/v26/overview_query_builder) helps. |
| `Google Ads API is not enabled` | Enable **Google Ads API** in the same Cloud project as the OAuth client. |
| "This app is blocked" during `setup-auth` | The consent screen is External and unverified, and `adwords` is a sensitive scope. Use a project in your Workspace organization with Audience = **Internal**. If it's still blocked, a Workspace admin must mark the OAuth client as **Trusted** (Admin console > Security > Access and data control > API controls > Manage Third-Party App Access). |
| `invalid_grant` | Refresh token revoked or expired (7-day expiry if the consent screen is External + Testing). Re-run `npm run setup-auth` and update `GOOGLE_ADS_REFRESH_TOKEN`. |
| `Not found (404)` on every call | The API version may be sunset. Bump `GOOGLE_ADS_API_VERSION` in `src/ads-client.ts`. |
| `401 Unauthorized` from `/mcp` | The connector isn't sending `Authorization: Bearer <MCP_AUTH_TOKEN>`, or the value doesn't match exactly (check for a missing `Bearer `). |
| Server exits at startup | Read the deploy log: it names the missing variable. |

## Security notes

- Never commit `.env`, OAuth client JSON or tokens. `.gitignore` and `.dockerignore` block the usual file names.
- The refresh token carries all of its Google user's Google Ads permissions, even though this server only reads. Create it with a **Read only** user (step 2) so a leaked token can't change anything. Store it only in Railway variables, and revoke it any time at [Google Account permissions](https://myaccount.google.com/permissions).
- Anyone with `MCP_AUTH_TOKEN` and the URL can read every account under the MCC. Rotate the token if it leaks.

## Privacy

See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md).

## License

MIT. See [LICENSE](LICENSE). Originally derived from [gsc-mcp-server](https://github.com/sofianbettayeb/gsc-mcp-server) by Sofian Bettayeb.
