import Link from "next/link";
import { NewProductForm } from "@/components/merchant/new-product-form";
import { requireMerchant } from "@/lib/session";

export default async function NewProductPage() {
  await requireMerchant();

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/merchant/products" className="text-xs text-muted-foreground hover:text-foreground">
          ← Products
        </Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">Add a product</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          It becomes part of the AI-readable catalog the moment you save — embedded for semantic
          search and published to your ACP feed automatically.
        </p>
      </div>
      <NewProductForm />
    </div>
  );
}
