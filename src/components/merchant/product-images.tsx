"use client";

import { useActionState, useTransition } from "react";
import Image from "next/image";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import {
  removeProductImageAction,
  uploadProductImageAction,
} from "@/server/catalog/image-actions";

type State = { ok?: boolean; message?: string; error?: string; url?: string } | null;

export function ProductImages({
  productId,
  imageUrls,
}: {
  productId: string;
  imageUrls: string[];
}) {
  const [state, action, pending] = useActionState<State, FormData>(uploadProductImageAction, null);
  const [removing, startRemoving] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Images</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Shown to shoppers and published as <span className="font-mono text-xs">image_link</span>{" "}
          in your ACP feed. Ranking is driven by your description and specifications, not by images.
        </p>

        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
        {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

        {imageUrls.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {imageUrls.map((url) => (
              <li key={url} className="relative">
                <Image
                  src={url}
                  alt=""
                  width={96}
                  height={96}
                  unoptimized
                  className="h-24 w-24 rounded-lg border border-border object-cover"
                />
                <button
                  type="button"
                  disabled={removing}
                  onClick={() => startRemoving(async () => void (await removeProductImageAction(productId, url)))}
                  aria-label="Remove image"
                  className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full border border-border bg-card text-xs leading-none text-muted-foreground hover:text-danger"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">No images yet.</p>
        )}

        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="productId" value={productId} />
          <input
            type="file"
            name="image"
            accept="image/jpeg,image/png,image/webp,image/gif"
            required
            className="text-xs file:mr-2 file:rounded-md file:border file:border-input file:bg-card file:px-2.5 file:py-1 file:text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={pending}>
            {pending ? "Uploading…" : "Upload"}
          </Button>
        </form>
        <p className="text-xs text-subtle">JPEG, PNG, WebP or GIF, up to 5MB.</p>
      </CardBody>
    </Card>
  );
}
