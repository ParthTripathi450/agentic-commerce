import { z } from "zod";

/**
 * Registration input contract.
 *
 * Deliberately free of any auth or database import so it can be tested on its
 * own — the bug that made customer signup fail silently lived entirely here.
 */

export const registerSchema = z
  .object({
    name: z.string().min(2, "Please enter your name").max(160),
    email: z.string().email("Enter a valid email address"),
    password: z.string().min(8, "Use at least 8 characters"),
    role: z.enum(["customer", "merchant"]),
    storeName: z.string().max(160).optional(),
  })
  .refine((v) => v.role !== "merchant" || (v.storeName?.trim().length ?? 0) >= 2, {
    message: "Store name is required for a merchant account",
    path: ["storeName"],
  });

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * FormData.get() returns null for an absent field, but Zod's .optional()
 * accepts undefined — not null. A field the form does not render (store name,
 * for a customer) therefore failed validation against an input the user could
 * not see, and the signup silently did nothing. Read every optional field
 * through this.
 */
export function optionalField(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateRegistration(formData: FormData) {
  return registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
    storeName: optionalField(formData, "storeName"),
  });
}
