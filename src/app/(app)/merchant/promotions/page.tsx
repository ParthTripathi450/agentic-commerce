import { Card, CardBody, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { CreatePromotionForm, PromotionRow } from "@/components/merchant/promotion-forms";
import { requireMerchant } from "@/lib/session";
import { listPromotions } from "@/server/merchant/promotion-actions";
import { merchantCategories } from "@/server/merchant/queries";

export default async function PromotionsPage() {
  const { merchant } = await requireMerchant();
  const [promotions, categories] = await Promise.all([
    listPromotions(merchant.id),
    merchantCategories(merchant.id),
  ]);

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Promotions"
        description="Discounts customers and agents can apply at checkout. Promotions your agent proposed and you approved appear here too, marked as such."
      />

      <CreatePromotionForm categories={categories} />

      <Card>
        <CardBody className="px-0 py-0">
          {promotions.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No promotions yet" />
            </div>
          ) : (
            promotions.map((promotion) => (
              <PromotionRow
                key={promotion.id}
                promotion={{
                  id: promotion.id,
                  title: promotion.title,
                  code: promotion.code,
                  type: promotion.type,
                  value: promotion.value,
                  active: promotion.active,
                  activeTo: promotion.activeTo?.toISOString() ?? null,
                  createdByAgent: promotion.createdByAgent,
                  minSubtotalMinor: promotion.conditions?.minSubtotalMinor ?? null,
                  categories: promotion.conditions?.categories ?? [],
                }}
              />
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
