import Link from "next/link";
import { ArrowRight, Bot, ReceiptText, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Badge, Card, CardBody, LinkButton } from "@/components/ui";

const PILLARS = [
  {
    icon: Bot,
    title: "Explainable",
    body: "Ranking is deterministic and published. The agent narrates the actual score vector, so it cannot claim a reason it did not use.",
  },
  {
    icon: ShieldCheck,
    title: "Bounded",
    body: "Every money-moving action passes a policy engine with configurable limits. A refusal is recorded as visibly as a completion.",
  },
  {
    icon: ReceiptText,
    title: "Audited",
    body: "An append-only trail records what the agent observed, decided and executed — replayable end to end.",
  },
];

const PROTOCOLS = [
  { name: "MCP", detail: "Catalog, search and commerce exposed as agent tools" },
  { name: "UCP", detail: "Capability manifest and checkout sessions" },
  { name: "ACP", detail: "Machine-readable product feed" },
  { name: "AP2", detail: "Signed Intent → Cart → Payment mandate chain" },
  { name: "x402", detail: "HTTP-native machine-to-machine payments" },
];

export default function Home() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Logo />
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
            <LinkButton href="/register">Get started</LinkButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
        <div className="max-w-3xl space-y-5">
          <Badge tone="accent">Built for the AI era of commerce</Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            A marketplace where AI agents search, compare, explain and buy.
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            Merchants publish once and become discoverable to AI buyers. Shoppers describe what they
            want in plain language, and an agent searches every merchant&rsquo;s machine-readable
            catalog, ranks the options, explains its choice, and asks permission before it ever
            spends money.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <LinkButton href="/register" size="lg">
              Create an account
              <ArrowRight className="size-4" />
            </LinkButton>
            <LinkButton href="/login" variant="secondary" size="lg">
              Sign in
            </LinkButton>
          </div>
        </div>

        <section className="mt-16 grid gap-3 sm:grid-cols-3">
          {PILLARS.map((pillar) => (
            <Card key={pillar.title}>
              <CardBody className="pt-6">
                <pillar.icon className="size-5 text-primary" strokeWidth={2} />
                <h2 className="mt-3 text-sm font-semibold">{pillar.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{pillar.body}</p>
              </CardBody>
            </Card>
          ))}
        </section>

        <section className="mt-12">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Protocol-aware by design
          </h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {PROTOCOLS.map((protocol) => (
              <div
                key={protocol.name}
                className="flex items-baseline gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <span className="font-mono text-xs font-semibold text-primary">{protocol.name}</span>
                <span className="text-sm text-muted-foreground">{protocol.detail}</span>
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-16 border-t border-border pt-6 text-xs text-subtle">
          Payments run against Razorpay test mode — realistic order, payment and transaction flows
          without processing real money.
        </footer>
      </main>
    </div>
  );
}
