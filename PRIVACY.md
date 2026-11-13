# Privacy Policy

**Google Ads MCP Server**

Last updated: October 29, 2026

## Overview

Google Ads MCP Server is an open-source, self-hosted tool that connects Claude (and other MCP clients) to Google Ads data. Each deployment is run by whoever hosts it; this document describes how the software handles data.

## What data is accessed

Using the scope `https://www.googleapis.com/auth/adwords` (Google offers no narrower Google Ads scope), the server reads:

- The client accounts under the configured manager (MCC) account, with their name, currency, time zone and status
- Campaign, ad group, keyword and search term data and metrics requested by the MCP client
- Any other data returned by read-only Google Ads Query Language (GAQL) SELECT queries

The software contains no code that changes Google Ads accounts, campaigns or settings: it only calls the read-only `googleAds:searchStream` and `customers:listAccessibleCustomers` endpoints, and it rejects queries that are not SELECT statements.

## Where data goes

- Credentials (OAuth client, refresh token, MCP auth token) are supplied as environment variables on the host. The software does not write them to disk.
- Google Ads data is fetched from Google on request and returned directly to the MCP client that asked for it (for example Claude). The software does not store, cache or log Google Ads data.
- Your host (e.g. Railway) and your MCP client (e.g. Claude) handle data under their own privacy policies.

## Third-party services

- **Google Ads API** to read advertising data
- **Google OAuth 2.0** for authentication

Use of these services is subject to [Google's Privacy Policy](https://policies.google.com/privacy).

## Data sharing

The software itself does not collect personal information, send data to the authors, track usage, or share data with third parties.

## Revoking access

- Revoke the refresh token at [Google Account permissions](https://myaccount.google.com/permissions)
- Remove the credentials from your host's environment variables
- Remove the connector from your MCP client

## Open source

Source code: https://github.com/ccsmatt/google-ads-mcp-server

## Contact

GitHub Issues: https://github.com/ccsmatt/google-ads-mcp-server/issues

## Changes

Updates to this policy will be reflected in this document with a new date.
