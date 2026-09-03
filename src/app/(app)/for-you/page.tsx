import { PageHeader } from "@/components/page-header";
import { ForYouShelves } from "@/components/shop/for-you-shelves";
import { requireCustomer } from "@/lib/session";
import { buildForYou } from "@/server/shopper/for-you";

/**
 * Suggestions derived from the shopper's knowledge base.
 *
 * Kept beside `/preferences` rather than folded into it: one page is the
 * evidence, this one is what the evidence produces. Seeing both makes the
 * personalisation arguable, which is the only reason it is allowed to steer
 * anything.
 */
export default async function ForYouPage() {
  const user = await requireCustomer();
  const forYou = await buildForYou(user.id);

  return (
    <div>
      <PageHeader
        title="For you"
        description="Picked from what you have bought, reviewed and looked at — never from what is simply selling well. Each card says why it is here."
      />
      <ForYouShelves forYou={forYou} />
    </div>
  );
}
