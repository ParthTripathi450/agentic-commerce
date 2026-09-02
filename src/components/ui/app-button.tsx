"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { Button as ShadcnButton } from "./button";

/**
 * Thin adapter over shadcn's Button.
 *
 * Keeps this app's semantic names (primary / danger, md) so pages read in the
 * app's own vocabulary, while the styling, focus rings and disabled states all
 * come from shadcn.
 */
const VARIANTS = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
  link: "link",
} as const;

const SIZES = { sm: "sm", md: "default", lg: "lg", icon: "icon" } as const;

export type AppButtonProps = Omit<ComponentProps<typeof ShadcnButton>, "variant" | "size"> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
};

export function Button({ variant = "primary", size = "md", ...props }: AppButtonProps) {
  return <ShadcnButton variant={VARIANTS[variant]} size={SIZES[size]} {...props} />;
}

/**
 * A link that looks like a button.
 *
 * This shadcn build is Base UI-backed, so composition uses `render` rather than
 * Radix's `asChild`. Two details matter and are easy to miss:
 *
 *  - `nativeButton={false}` is required. Base UI assumes a real <button> and
 *    warns that rendering anything else strips native button semantics; saying
 *    so explicitly tells it this is intentionally an anchor.
 *  - The element is a next/link, so navigation stays client-side rather than
 *    triggering a full page load.
 */
export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  children,
  ...props
}: Omit<AppButtonProps, "render" | "nativeButton"> & { href: string }) {
  return (
    <Button
      variant={variant}
      size={size}
      nativeButton={false}
      render={<Link href={href} />}
      {...props}
    >
      {children}
    </Button>
  );
}
