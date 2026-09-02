"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { PasswordField } from "@/components/password-field";
import { loginAction, type ActionState } from "@/server/auth/actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState<ActionState, FormData>(loginAction, {});

  return (
    <div className="space-y-4">
      {/* Elevated form card: white on the tinted ground, hairline + soft shadow. */}
      <div
        className="rounded-xl border border-border bg-card p-8"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Continue to your marketplace account.
          </p>
        </div>

        {state.error ? (
          <div className="mb-4">
            <Alert tone="danger">
              {state.error}
              {state.fieldErrors?.email ? (
                <Link href="/register" className="mt-1 block font-medium underline">
                  Create an account
                </Link>
              ) : null}
            </Alert>
          </div>
        ) : null}

        <form action={action} className="space-y-4">
          <Field label="Email">
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </Field>

          <PasswordField
            autoComplete="current-password"
            showRequirements={false}
            serverError={state.fieldErrors?.password}
          />

          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          No account?{" "}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </p>
      </div>

      <div
        className="rounded-xl border border-border bg-card px-5 py-4"
        style={{ boxShadow: "var(--shadow-sm)" }}
      >
        <p className="text-xs font-medium">Demo accounts</p>
        <dl className="tabular mt-2 space-y-1 text-xs text-muted-foreground">
          <div className="flex justify-between gap-3">
            <dt>Shopper</dt>
            <dd className="font-mono">demo@shopper.test</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Merchant</dt>
            <dd className="font-mono">care@stride.test</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Password</dt>
            <dd className="font-mono">demo1234</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
