import { relations } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_shared";

export const userRole = pgEnum("user_role", ["customer", "merchant", "admin"]);

export const users = pgTable("users", {
  id: pk(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash"),
  name: varchar("name", { length: 160 }).notNull(),
  role: userRole("role").notNull().default("customer"),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Auth.js session storage (database strategy). */
export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const keyOwnerType = pgEnum("key_owner_type", ["user", "merchant", "platform"]);

/**
 * ES256 keypairs used to sign AP2 mandates.
 *
 * DEMO SIMPLIFICATION: in a production AP2 deployment the user's private key
 * lives on their device and never reaches the server. Here it is held
 * server-side so the flow is demonstrable without a wallet or hardware key.
 * This is documented in the README rather than hidden.
 */
export const signingKeys = pgTable("signing_keys", {
  id: pk(),
  ownerType: keyOwnerType("owner_type").notNull(),
  ownerId: varchar("owner_id", { length: 36 }).notNull(),
  kid: varchar("kid", { length: 64 }).notNull().unique(),
  publicJwk: jsonb("public_jwk").notNull(),
  privateJwk: jsonb("private_jwk").notNull(),
  createdAt: createdAt(),
});

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
}));
