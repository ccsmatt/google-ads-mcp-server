#!/usr/bin/env node

import { createHash, timingSafeEqual } from "crypto";
import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AdsClient, GOOGLE_ADS_API_VERSION } from "./ads-client.js";
import { getAdsConfigFromEnv } from "./auth.js";
import { createMcpServer } from "./server.js";

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Only the Authorization header is accepted; tokens in URLs leak into logs
function isAuthorized(req: Request): boolean {
  const header = req.headers.authorization;
  if (!AUTH_TOKEN || !header) {
    return false;
  }
  // Hash both sides so the comparison is constant-time regardless of length
  return timingSafeEqual(sha256(header), sha256(`Bearer ${AUTH_TOKEN}`));
}

function unauthorized(res: Response): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

async function main() {
  if (!AUTH_TOKEN) {
    console.error(`
Google Ads MCP Server - MCP_AUTH_TOKEN required

Refusing to start without MCP_AUTH_TOKEN: the server would otherwise let
anyone who can reach it read your Google Ads data.

Set MCP_AUTH_TOKEN to a long random string, and send it from MCP clients
as the header:  Authorization: Bearer <MCP_AUTH_TOKEN>
`);
    process.exit(1);
  }

  let config: ReturnType<typeof getAdsConfigFromEnv>;
  try {
    config = getAdsConfigFromEnv();
  } catch (err) {
    console.error(`Invalid GOOGLE_ADS_LOGIN_CUSTOMER_ID: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if ("missing" in config) {
    console.error(`
Google Ads MCP Server - Google Ads credentials required

Missing environment variables:
  ${config.missing.join("\n  ")}

Required:
  GOOGLE_ADS_CLIENT_ID
  GOOGLE_ADS_CLIENT_SECRET
  GOOGLE_ADS_REFRESH_TOKEN       (get one with: npm run setup-auth)
  GOOGLE_ADS_LOGIN_CUSTOMER_ID   (your MCC ID, dashes optional)

Optional:
  GOOGLE_ADS_DEVELOPER_TOKEN     (ignored by Google since 2026-09-09)

See the README for details.
`);
    process.exit(1);
  }

  const adsClient = new AdsClient(config);

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  const handleMcp = async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }

    // Stateless mode: a fresh Server + transport per request, all sharing
    // one authenticated Google Ads client
    const server = createMcpServer(adsClient);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  // Stateless streamable HTTP: sessions and server-initiated streams are
  // not supported, so GET/DELETE get 405 per the MCP spec
  const methodNotAllowed = (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };

  app.post("/mcp", handleMcp);
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(PORT, () => {
    console.log(`google-ads-mcp-server listening on port ${PORT} (Google Ads API ${GOOGLE_ADS_API_VERSION}, MCC ${adsClient.loginCustomerId})`);
    console.log("MCP endpoint: POST /mcp (Authorization: Bearer token required)");
  });
}

main();
