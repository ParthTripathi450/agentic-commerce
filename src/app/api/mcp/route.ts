import { NextResponse } from "next/server";
import { z } from "zod";
import { TOOLS } from "@/server/protocols/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP over Streamable HTTP.
 *
 * Implemented as a stateless JSON-RPC handler rather than via the SDK's
 * transport: the SDK expects Node's req/res objects, which App Router handlers
 * do not expose. MCP permits a plain JSON response per request, and statelessness
 * is what lets this run on serverless hosting at all.
 */

const PROTOCOL_VERSION = "2024-11-05";

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

function result(id: string | number | undefined, value: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result: value });
}

function error(id: string | number | undefined, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status: 200 });
}

/**
 * Minimal Zod → JSON Schema for tool advertisement.
 *
 * Probes the schema by parsing sample values rather than reading Zod internals:
 * `_def.typeName` moved in Zod 4, and reading it silently marked every optional
 * argument as required.
 */
function toJsonSchema(schema: z.ZodObject<z.ZodRawShape>) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(schema.shape)) {
    const node = field as z.ZodTypeAny;

    // Optional or defaulted fields accept undefined; required ones do not.
    const isOptional = node.safeParse(undefined).success;

    const jsonType =
      node.safeParse([]).success ? "array"
      : node.safeParse(true).success ? "boolean"
      : node.safeParse(1).success ? "number"
      : "string";

    const description = (node as { description?: string }).description;

    properties[key] = {
      type: jsonType,
      ...(description ? { description } : {}),
      ...(jsonType === "array" ? { items: { type: "string" } } : {}),
    };
    if (!isOptional) required.push(key);
  }

  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(undefined, -32700, "Parse error");
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return error(undefined, -32600, "Invalid Request");

  const { id, method, params } = parsed.data;

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agentic-commerce-platform", version: "0.1.0" },
        instructions:
          "Call get_catalog_vocabulary before filtering. search_products returns a published " +
          "score breakdown — explain recommendations from it. No tool can charge money.",
      });

    // Notifications carry no id and expect no response body.
    case "notifications/initialized":
      return new NextResponse(null, { status: 202 });

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toJsonSchema(tool.schema as z.ZodObject<z.ZodRawShape>),
        })),
      });

    case "tools/call": {
      const name = params?.name as string | undefined;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `Unknown tool: ${name}`);

      const args = tool.schema.safeParse(params?.arguments ?? {});
      if (!args.success) {
        return error(id, -32602, `Invalid arguments: ${args.error.issues[0]?.message}`);
      }

      try {
        return result(id, await tool.handler(args.data as never));
      } catch (cause) {
        // Tool failures are returned as results, per MCP, not transport errors.
        return result(id, {
          content: [{ type: "text", text: JSON.stringify({ error: (cause as Error).message }) }],
          isError: true,
        });
      }
    }

    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

export async function GET() {
  return NextResponse.json({
    name: "agentic-commerce-platform",
    transport: "streamable-http",
    protocolVersion: PROTOCOL_VERSION,
    tools: TOOLS.map((t) => t.name),
    usage: "POST JSON-RPC 2.0 to this endpoint.",
  });
}
