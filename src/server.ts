import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { AdsClient } from "./ads-client.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools.js";

/**
 * Build an MCP Server wired to the read-only Google Ads tool handlers.
 */
export function createMcpServer(adsClient: AdsClient): Server {
  const server = new Server(
    {
      name: "google-ads-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(adsClient, name, args || {});
  });

  return server;
}
