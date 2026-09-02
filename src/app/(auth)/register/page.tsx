"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { PasswordField } from "@/components/password-field";
import { cn } from "@/lib/utils";
import { registerAction, type ActionState } from "@/server/auth/actions";

const ROLES = [
  { value: "customer", label: "Shop", hint: "Buy with an AI agent" },
  { value: "merchant", label: "Sell", hint: "List for AI buyers" },
] as const;

export default function RegisterPage() {
  const [state, action, pending] = useActionState<ActionState, FormData>(registerAction, {});
  const [role, setRole] = useState<"customer" | "merchant">("customer");

  return (
    <div
      className="rounded-xl border border-border bg-card p-8"
      style={{ boxShadow: "var(--shadow-lg)" }}
    >
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Create an account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how you want to use the marketplace.
        </p>
      </div>

      {state.error ? (
        <div className="mb-4">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}
      {/* storeName only renders for merchants, so surface its error either way. */}
      {state.fieldErrors?.storeName && role !== "merchant" ? (
        <div className="mb-4">
          <Alert tone="danger">{state.fieldErrors.storeName}</Alert>
        </div>
      ) : null}

      <form action={action} className="space-y-4">
        <input type="hidden" name="role" value={role} />

        <div className="grid grid-cols-2 gap-2">
          {ROLES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRole(option.value)}
              aria-pressed={role === option.value}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left transition-colors",
                role === option.value
                  ? "border-primary bg-primary-soft ring-1 ring-primary"
                  : "border-input hover:bg-muted",
              )}
            >
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>
            </button>
          ))}
        </div>

        <Field label="Name" hint={state.fieldErrors?.name}>
          <Input name="name" required placeholder="Riya Sharma" />
        </Field>

        {role === "merchant" ? (
          <Field label="Store name" hint={state.fieldErrors?.storeName}>
            <Input name="storeName" placeholder="Stride Athletics" />
          </Field>
        ) : null}

        <Field label="Email" hint={state.fieldErrors?.email}>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
          />
        </Field>

        <PasswordField serverError={state.fieldErrors?.password} />

        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already registered?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
