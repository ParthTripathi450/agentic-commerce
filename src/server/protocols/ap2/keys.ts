import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { db } from "@/db";
import { signingKeys } from "@/db/schema";

export type KeyOwnerType = "user" | "merchant" | "platform";

export const MANDATE_ALG = "ES256";

/**
 * ES256 keypair management for AP2 mandates.
 *
 * DEMO SIMPLIFICATION: private keys are stored server-side. A production AP2
 * deployment keeps the user's key on their device (or in a wallet) so the
 * platform provably cannot sign on their behalf. Everything else about the
 * mandate chain — canonicalisation, signing, chain verification — is real.
 */
export async function getOrCreateSigningKey(ownerType: KeyOwnerType, ownerId: string) {
  const [existing] = await db
    .select()
    .from(signingKeys)
    .where(and(eq(signingKeys.ownerType, ownerType), eq(signingKeys.ownerId, ownerId)))
    .limit(1);

  if (existing) return existing;

  const { publicKey, privateKey } = await generateKeyPair(MANDATE_ALG, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = `${ownerType}-${randomUUID().slice(0, 8)}`;

  publicJwk.kid = kid;
  publicJwk.alg = MANDATE_ALG;
  privateJwk.kid = kid;
  privateJwk.alg = MANDATE_ALG;

  const [created] = await db
    .insert(signingKeys)
    .values({ ownerType, ownerId, kid, publicJwk, privateJwk })
    .returning();

  return created;
}

export async function loadPrivateKey(jwk: unknown): Promise<CryptoKey | Uint8Array> {
  return importJWK(jwk as JWK, MANDATE_ALG);
}

export async function loadPublicKey(jwk: unknown): Promise<CryptoKey | Uint8Array> {
  return importJWK(jwk as JWK, MANDATE_ALG);
}

export async function findKeyByKid(kid: string) {
  const [key] = await db.select().from(signingKeys).where(eq(signingKeys.kid, kid)).limit(1);
  return key ?? null;
}

/**
 * Deterministic JSON canonicalisation (RFC 8785 style: sorted keys, no
 * whitespace). Both signer and verifier must hash the identical byte string,
 * so key ordering cannot be left to chance.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}
