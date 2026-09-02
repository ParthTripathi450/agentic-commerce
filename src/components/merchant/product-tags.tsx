"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { TagEditor } from "./tag-editor";
import {
  regenerateTagsAction,
  updateProductTagsAction,
} from "@/server/agents/merchant/listing-actions";

type State = { ok?: boolean; message?: string; error?: string } | null;

export function ProductTags({
  productId,
  initialTags,
}: {
  productId: string;
  initialTags: string[];
}) {
  const [tags, setTags] = useState(initialTags);
  const [proposed, setProposed] = useState<string[]>([]);
  const [regenerating, startRegenerating] = useTransition();
  const [state, action, saving] = useActionState<State, FormData>(updateProductTagsAction, null);

  return (
    <Card data-static="true">
      <CardHeader>
        <CardTitle>Search tags</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="tagsJson" value={JSON.stringify(tags)} />

          <p className="text-sm text-muted-foreground">
            Ranked above the description when agents search, so these are the highest-leverage
            words on the listing. Whatever the agent proposed is yours to change.
          </p>

          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

          <TagEditor
            tags={tags}
            aiProposed={proposed}
            regenerating={regenerating}
            onChange={setTags}
            onRegenerate={() =>
              startRegenerating(async () => {
                const result = await regenerateTagsAction(productId);
                if (result?.tags) {
                  const fresh = result.tags.filter((t) => !tags.includes(t));
                  setProposed(result.tags);
                  setTags([...tags, ...fresh].slice(0, 14));
                }
              })
            }
          />

          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving and re-indexing…" : "Save tags"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
