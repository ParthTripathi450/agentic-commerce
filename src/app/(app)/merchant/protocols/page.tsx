import { Badge, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ReindexButton } from "@/components/merchant/reindex-button";
import { env } from "@/lib/env";
import { requireMerchant } from "@/lib/session";

export default async function ProtocolsPage() {
  const { merchant } = await requireMerchant();
  const base = env().PLATFORM_URL.replace(/\/$/, "");

  const endpoints = [
    {
      protocol: "UCP",
      label: "Capability manifest",
      url: `${base}/api/ucp/${merchant.slug}/manifest`,
      description:
        "What your store supports: services, capabilities, payment handlers, and the public key your Cart Mandates are signed with.",
    },
    {
      protocol: "UCP",
      label: "Platform discovery",
      url: `${base}/.well-known/ucp`,
      description: "Directory of every merchant on this platform, for agents arriving at the domain.",
    },
    {
      protocol: "ACP",
      label: "Product feed (JSON)",
      url: `${base}/api/acp/${merchant.slug}/feed.json`,
      description: "Your full catalog in ACP Product Feed format. Generated from your products — nothing to maintain.",
    },
    {
      protocol: "ACP",
      label: "Product feed (CSV)",
      url: `${base}/api/acp/${merchant.slug}/feed.json?format=csv`,
      description: "The same feed for agents that ingest tabular data.",
    },
    {
      protocol: "MCP",
      label: "Tool endpoint",
      url: `${base}/api/mcp`,
      description: "Model Context Protocol over HTTP: search, product detail, availability, and purchase preparation.",
    },
  ];

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        "agentic-commerce": {
          command: "npm",
          args: ["run", "mcp:stdio"],
          cwd: process.cwd(),
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Protocol endpoints"
        description="Your store is machine-readable by default. These endpoints are what let an AI agent discover your catalog, check availability and transact without a bespoke integration."
      />

      <div className="grid gap-3">
        {endpoints.map((endpoint) => (
          <Card key={endpoint.url}>
            <CardBody className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{endpoint.protocol}</Badge>
                <span className="text-sm font-medium">{endpoint.label}</span>
              </div>
              <a
                href={endpoint.url}
                target="_blank"
                rel="noreferrer"
                className="block break-all font-mono text-xs text-primary hover:underline"
              >
                {endpoint.url}
              </a>
              <p className="text-sm text-muted-foreground">{endpoint.description}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connect an MCP desktop client</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Add this to <span className="font-mono text-xs">mcp_client_config.json</span> to let the client shop this marketplace directly. No tool can charge money — purchases return an
            authorization link you approve here.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{mcpConfig}</pre>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI catalog index</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Products are re-indexed automatically when you save them. Use this if you have edited
            data directly or want to force a rebuild.
          </p>
          <ReindexButton />
        </CardBody>
      </Card>
    </div>
  );
}
