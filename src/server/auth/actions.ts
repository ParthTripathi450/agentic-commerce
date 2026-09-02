"use server";

import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agentPolicies, merchantPolicies, merchants, users } from "@/db/schema";
import { signIn } from "@/lib/auth";
import { validateRegistration } from "@/lib/registration";
import { getOrCreateSigningKey } from "@/server/protocols/ap2/keys";

export type ActionState = { error?: string; fieldErrors?: Record<string, string> };


function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Ensures the merchant slug is unique, since it is a public protocol identifier. */
async function uniqueSlug(base: string): Promise<string> {
  const root = base || "store";
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const [existing] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export async function registerAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = validateRegistration(formData);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0] ?? "form")] = issue.message;
    }
    // A validation failure must never be invisible: if it lands on a field this
    // form does not render, promote it to the top-level error banner.
    const visible = new Set(["name", "email", "password", "storeName"]);
    const orphaned = Object.entries(fieldErrors).find(([key]) => !visible.has(key));
    return {
      fieldErrors,
      error: orphaned ? `${orphaned[0]}: ${orphaned[1]}` : undefined,
    };
  }

  const { name, email, password, role, storeName } = parsed.data;
  const normalisedEmail = email.toLowerCase();

  try {

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalisedEmail))
    .limit(1);
  if (existing) return { fieldErrors: { email: "That email is already registered" } };

  const [user] = await db
    .insert(users)
    .values({ name, email: normalisedEmail, passwordHash: await hash(password, 10), role })
    .returning();

  if (role === "merchant") {
    const [merchant] = await db
      .insert(merchants)
      .values({
        userId: user.id,
        slug: await uniqueSlug(slugify(storeName!)),
        name: storeName!.trim(),
        supportEmail: normalisedEmail,
      })
      .returning();

    // Defaults so a new store is protocol-complete and agent-safe immediately.
    await db.insert(merchantPolicies).values({ merchantId: merchant.id });
    await db.insert(agentPolicies).values({
      scope: "merchant",
      scopeId: merchant.id,
      limits: {
        maxPriceChangeBp: 1000,
        maxDiscountBp: 2000,
        maxRestockUnits: 200,
        allowAutoPublish: false,
        requireApprovalForAll: true,
      },
    });
    // Merchant keypair: signs Cart Mandates so agents can verify quoted prices.
    await getOrCreateSigningKey("merchant", merchant.id);
  } else {
    await db.insert(agentPolicies).values({
      scope: "user",
      scopeId: user.id,
      limits: {
        maxOrderValueMinor: 25_000_00,
        maxDailySpendMinor: 50_000_00,
        maxItemsPerOrder: 10,
        requireApprovalAboveMinor: 0,
      },
    });
  }
  await getOrCreateSigningKey("user", user.id);

    await signIn("credentials", {
      email: normalisedEmail,
      password,
      redirectTo: role === "merchant" ? "/merchant" : "/shop",
    });
    return {};
  } catch (cause) {
    // A redirect is how a successful signIn reports itself — never swallow it.
    if (isRedirectError(cause)) throw cause;

    const error = cause as Error;
    console.error("[register] failed:", error);

    // The account may already exist at this point: the insert runs before
    // signIn. Say so, rather than leaving the shopper unable to explain why
    // "create account" did nothing.
    const [created] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalisedEmail))
      .limit(1);

    return {
      error: created
        ? "Your account was created, but signing you in failed. Please sign in from the login page."
        : `Could not create your account: ${error.message}`,
    };
  }
}

/**
 * Next signals a successful redirect by throwing. Catching that and treating it
 * as a failure is the classic way to break a working sign-in, so it is detected
 * explicitly rather than by instanceof.
 */
function isRedirectError(error: unknown): boolean {
  const digest = (error as { digest?: unknown })?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

export async function loginAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password" };

  // Role decides the landing surface, so resolve it before redirecting.
  const [user] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Distinguish "no such account" from "wrong password". Vague credential
  // errors are what leave someone retrying an account that was never created.
  if (!user) {
    return {
      error: "No account exists with that email address. Create one below.",
      fieldErrors: { email: "Not registered" },
    };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: user.role === "merchant" ? "/merchant" : "/shop",
    });
    return {};
  } catch (error) {
    if (isRedirectError(error)) throw error; // a successful sign-in
    if (error instanceof AuthError) {
      return { error: "That password is not right for this account." };
    }
    console.error("[login] failed:", error);
    throw error;
  }
}

export async function signOutAction() {
  const { signOut } = await import("@/lib/auth");
  await signOut({ redirect: false });
  redirect("/");
}
