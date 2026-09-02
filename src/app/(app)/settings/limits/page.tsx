import { LimitsForm } from "@/components/limits-form";
import { PaymentMethodCard } from "@/components/payment-method-card";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody } from "@/components/ui";
import { formatMoney, toMajor } from "@/lib/money";
import { requireUser } from "@/lib/session";
import { PLATFORM_DEFAULTS, resolveLimits, spentTodayMinor } from "@/server/policy/engine";
import { describeMethod, getDefaultPaymentMethod } from "@/server/payments/queries";

export default async function LimitsPage() {
  const user = await requireUser();
  const [effective, spentToday, method] = await Promise.all([
    resolveLimits({ userId: user.id }),
    spentTodayMinor(user.id),
    getDefaultPaymentMethod(user.id),
  ]);

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader
        title="Spending limits"
        description="Bounds the agent must respect before any money moves. A refused action is recorded in your activity log alongside the limit that stopped it."
      />

      <Card>
        <CardBody className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Committed today</span>
            <span className="tabular font-medium">{formatMoney(spentToday)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Remaining today</span>
            <span className="tabular font-medium">
              {formatMoney(Math.max((effective.maxDailySpendMinor ?? 0) - spentToday, 0))}
            </span>
          </div>
          <p className="pt-1 text-xs text-subtle">
            The platform ceiling is {formatMoney(PLATFORM_DEFAULTS.maxOrderValueMinor ?? 0)} per
            order. Your own limit can be stricter but never higher.
          </p>
        </CardBody>
      </Card>

      <PaymentMethodCard
        method={method ? { id: method.id, description: describeMethod(method) } : null}
      />

      <LimitsForm
        defaults={{
          maxOrderValue: toMajor(effective.maxOrderValueMinor ?? 0),
          maxDailySpend: toMajor(effective.maxDailySpendMinor ?? 0),
          maxItemsPerOrder: effective.maxItemsPerOrder ?? 10,
          requireApprovalAbove: toMajor(effective.requireApprovalAboveMinor ?? 0),
        }}
      />
    </div>
  );
}
