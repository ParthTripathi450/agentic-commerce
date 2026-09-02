import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { NewProductForm } from "@/components/merchant/new-product-form";
import { ListingWizard } from "@/components/merchant/listing-wizard";
import { Card, CardBody } from "@/components/ui";
import { requireMerchant } from "@/lib/session";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { providerStatus } from "@/server/ai/llm";

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  await requireMerchant();
  const { mode } = await searchParams;
  const manual = mode === "manual";
  const [vocabulary, status] = [await getVocabulary(), providerStatus()];

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Add a product"
        description="It joins the AI-readable catalog the moment you save — embedded for semantic search and published to your ACP feed."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link
          href="/merchant/products/new"
          aria-current={!manual ? "page" : undefined}
          className={
            !manual
              ? "rounded-lg border border-primary bg-primary-soft px-3 py-1.5 text-sm font-medium text-accent-foreground"
              : "rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          }
        >
          Let the agent help
        </Link>
        <Link
          href="/merchant/products/new?mode=manual"
          aria-current={manual ? "page" : undefined}
          className={
            manual
              ? "rounded-lg border border-primary bg-primary-soft px-3 py-1.5 text-sm font-medium text-accent-foreground"
              : "rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          }
        >
          Enter it myself
        </Link>
      </div>

      {manual ? (
        <NewProductForm />
      ) : (
        <>
          {status.degradedMode ? (
            <Card data-static="true" className="mb-4">
              <CardBody className="text-sm text-muted-foreground">
                No AI provider is configured, so suggestions will be limited to brands already on
                this marketplace. Everything remains editable, and{" "}
                <Link href="/merchant/products/new?mode=manual" className="text-primary hover:underline">
                  the manual form
                </Link>{" "}
                works exactly as before.
              </CardBody>
            </Card>
          ) : null}
          <ListingWizard categories={vocabulary.categories} />
        </>
      )}
    </div>
  );
}
