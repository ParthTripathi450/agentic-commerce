import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "./tools";

/**
 * Builds the MCP server with every catalog and commerce tool registered.
 *
 * Shared by both transports so stdio and HTTP clients see an identical surface.
 */
export function createMcpServer() {
  const server = new McpServer(
    { name: "agentic-commerce-platform", version: "0.1.0" },
    {
      instructions:
        "A multi-merchant marketplace. Call get_catalog_vocabulary before filtering so your " +
        "filters use values that exist. search_products returns a published score breakdown — " +
        "use it to explain your recommendation rather than inventing reasons. No tool here can " +
        "charge money: prepare_purchase returns a URL where the human authorizes payment.",
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema.shape as never,
      },
      (async (args: unknown) => tool.handler(args as never)) as never,
    );
  }

  return server;
}
