import { config as loadEnv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

loadEnv({ path: ".env.local", quiet: true });

/**
 * MCP over stdio, for desktop MCP clients.
 *
 * stdout is the protocol channel, so nothing may be logged there — diagnostics
 * go to stderr or the transport breaks.
 */
async function main() {
  const { createMcpServer } = await import("@/server/protocols/mcp/server");
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("[mcp] agentic-commerce-platform ready on stdio");
}

main().catch((error) => {
  console.error("[mcp] failed to start:", error);
  process.exit(1);
});
