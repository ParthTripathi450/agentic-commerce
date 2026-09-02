"use client";

import { useActionState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { createProductAction } from "@/server/catalog/actions";

type State = { error?: string } | null;

export function NewProductForm() {
  const [state, action, pending] = useActionState<State, FormData>(createProductAction, null);

  return (
    <form action={action} className="space-y-4">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>Product</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Title">
            <Input name="title" required placeholder="Velocity Run 3 Road Running Shoes" />
          </Field>

          <Field
            label="Description"
            hint="This is what AI agents read. Concrete, factual detail makes the product easier to match — vague marketing copy makes it invisible."
          >
            <Textarea
              name="description"
              rows={5}
              placeholder="Lightweight neutral road running shoe with a responsive EVA midsole, breathable engineered mesh upper and an 8mm heel-to-toe drop."
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Category">
              <Input name="category" required placeholder="Running Shoes" />
            </Field>
            <Field label="Brand">
              <Input name="brand" placeholder="Stride" />
            </Field>
            <Field label="Status">
              <Select name="status" defaultValue="active">
                <option value="active">Active — discoverable now</option>
                <option value="draft">Draft — hidden from agents</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Specifications"
            hint="One per line, as key: value. Agents filter on these, so they matter more than prose. Use commas for lists."
          >
            <Textarea
              name="attributes"
              rows={4}
              className="font-mono text-xs"
              placeholder={"gender: unisex\nuse: road running\ndrop mm: 8\nwaterproof: false\nfeatures: breathable, reflective heel"}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>First variant</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Price and stock live on the variant. You can add more sizes or colours once the product
            exists.
          </p>

          <Field
            label="Options"
            hint="One per line, as key: value — for example size: 10 and color: black. Leave blank if this product has no variations."
          >
            <Textarea
              name="variantAttributes"
              rows={2}
              className="font-mono text-xs"
              placeholder={"size: 10\ncolor: black"}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price (₹)">
              <Input name="price" type="number" step="0.01" min="1" required placeholder="4299" />
            </Field>
            <Field label="Stock on hand">
              <Input name="quantity" type="number" min="0" required defaultValue={0} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Button type="submit" disabled={pending}>
        {pending ? "Creating and indexing…" : "Create product"}
      </Button>
    </form>
  );
}
