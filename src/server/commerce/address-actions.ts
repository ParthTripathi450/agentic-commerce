"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCustomer } from "@/lib/session";
import { addAddress, removeAddress, setDefaultAddress } from "./addresses";

/**
 * Mutations only — the reads live in `addresses.ts`, because every export of a
 * `"use server"` module becomes a POST endpoint.
 */
const addSchema = z.object({
  label: z.string().max(40).optional(),
  recipient: z.string().min(2, "Who is it for?").max(120),
  phone: z.string().max(24).optional(),
  line1: z.string().min(3, "Add the street address").max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(2, "Add the city").max(80),
  state: z.string().min(2, "Add the state").max(80),
  postcode: z.string().min(3, "Add the postcode").max(16),
});

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
};

export async function addAddressAction(
  formData: FormData,
): Promise<{ addressId: string } | { error: string }> {
  const user = await requireCustomer();
  const parsed = addSchema.safeParse({
    label: field(formData, "label"),
    recipient: field(formData, "recipient"),
    phone: field(formData, "phone"),
    line1: field(formData, "line1"),
    line2: field(formData, "line2"),
    city: field(formData, "city"),
    state: field(formData, "state"),
    postcode: field(formData, "postcode"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the address and try again." };
  }

  const address = await addAddress(user.id, parsed.data);
  revalidatePath("/checkout");
  revalidatePath("/settings/addresses");
  return { addressId: address.id };
}

export async function setDefaultAddressAction(addressId: string) {
  const user = await requireCustomer();
  const ok = await setDefaultAddress(user.id, addressId);
  revalidatePath("/settings/addresses");
  return ok ? { ok: true, message: "Default address updated." } : { error: "Address not found." };
}

export async function removeAddressAction(addressId: string) {
  const user = await requireCustomer();
  const ok = await removeAddress(user.id, addressId);
  revalidatePath("/settings/addresses");
  return ok ? { ok: true, message: "Address removed." } : { error: "Address not found." };
}
