import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "customer" | "merchant" | "admin";
    } & DefaultSession["user"];
  }
  interface User {
    role?: "customer" | "merchant" | "admin";
  }
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * Credentials auth with a JWT session strategy.
 *
 * JWT (not database sessions) because Auth.js does not support database
 * sessions with the Credentials provider. Route protection is enforced in
 * server layouts via `auth()` rather than in middleware, which keeps bcrypt and
 * the Postgres driver off the edge runtime entirely.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, parsed.data.email.toLowerCase()))
          .limit(1);

        if (!user?.passwordHash) return null;
        if (!(await compare(parsed.data.password, user.passwordHash))) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (token.id) session.user.id = token.id as string;
      if (token.role) session.user.role = token.role as "customer" | "merchant" | "admin";
      return session;
    },
  },
});
