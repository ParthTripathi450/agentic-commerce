import Link from "next/link";
import { Logo } from "@/components/brand/logo";

/**
 * Auth shell.
 *
 * A tinted ground rather than plain white, so the form card has something to
 * lift off — a shadow on a white page reads as a smudge.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center px-4 py-12"
      style={{ background: "var(--auth-bg)" }}
    >
      <Link href="/" className="mb-8">
        <Logo />
      </Link>

      <div className="w-full max-w-[400px]">{children}</div>

      <p className="mt-8 text-xs text-subtle">
        Razorpay test mode — no real money is ever processed.
      </p>
    </div>
  );
}
