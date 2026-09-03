import { PageHeader } from "@/components/page-header";
import { KnowledgePanel } from "@/components/shop/knowledge-panel";
import { requireCustomer } from "@/lib/session";
import { buildKnowledgeBase } from "@/server/shopper/knowledge";

/**
 * The shopper's own knowledge base, in full.
 *
 * Deliberately its own page rather than a line in settings. It is the one place
 * the agent's personalisation is legible, and a profile you can only infer from
 * changed search results is one nobody can check or correct.
 */
export default async function PreferencesPage() {
  const user = await requireCustomer();
  const knowledge = await buildKnowledgeBase(user.id);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="What the agent knows about you"
        description="Built from your orders, reviews, baskets and browsing — nothing declared, nothing guessed by a model. The agent uses it to ask fewer questions and to break ties between close options."
      />
      <KnowledgePanel knowledge={knowledge} />
    </div>
  );
}
