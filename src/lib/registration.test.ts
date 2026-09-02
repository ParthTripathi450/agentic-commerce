import { describe, expect, it } from "vitest";
import { validateRegistration } from "@/lib/registration";

/**
 * Regression: a customer signup silently did nothing.
 *
 * The store-name input is not rendered for customers, so FormData had no such
 * key and `.get()` returned null. Zod's `.optional()` accepts undefined but not
 * null, so validation failed on a field the user could not see, and the account
 * was never created.
 */
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("registration validation", () => {
  it("accepts a customer signup with no store-name field at all", async () => {
    const result = await validateRegistration(
      form({
        name: "Parth Tripathi",
        email: "Parth@Example.com",
        password: "supersecret",
        role: "customer",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a customer signup where store name is present but empty", async () => {
    // A hidden or cleared input submits "" rather than being absent.
    const result = await validateRegistration(
      form({
        name: "Parth Tripathi",
        email: "parth@example.com",
        password: "supersecret",
        role: "customer",
        storeName: "",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("still requires a store name for a merchant", async () => {
    const result = await validateRegistration(
      form({ name: "Owner", email: "owner@shop.test", password: "supersecret", role: "merchant" }),
    );
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0].path).toContain("storeName");
  });

  it("accepts a merchant signup with a store name", async () => {
    const result = await validateRegistration(
      form({
        name: "Owner",
        email: "owner@shop.test",
        password: "supersecret",
        role: "merchant",
        storeName: "Stride Athletics",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a password under 8 characters", async () => {
    const result = await validateRegistration(
      form({ name: "Parth", email: "p@example.com", password: "short", role: "customer" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a malformed email", async () => {
    const result = await validateRegistration(
      form({ name: "Parth", email: "not-an-email", password: "supersecret", role: "customer" }),
    );
    expect(result.success).toBe(false);
  });
});
