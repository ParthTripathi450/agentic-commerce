"use client";

import { useState } from "react";
import { Check, Eye, EyeOff, X } from "lucide-react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Password input with live requirement feedback.
 *
 * The rule is checked as you type rather than only on submit: a signup that
 * bounces off a server-side length check tells you what went wrong one round
 * trip too late, which is exactly how someone ends up with no account and no
 * idea why.
 */
export function PasswordField({
  name = "password",
  label = "Password",
  serverError,
  autoComplete = "new-password",
  showRequirements = true,
}: {
  name?: string;
  label?: string;
  serverError?: string;
  autoComplete?: string;
  showRequirements?: boolean;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [visible, setVisible] = useState(false);

  const tooShort = value.length > 0 && value.length < MIN_PASSWORD_LENGTH;
  const valid = value.length >= MIN_PASSWORD_LENGTH;
  // Only complain once they have actually typed something.
  const showError = tooShort && touched;

  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>

      <div className="relative">
        <Input
          id={name}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={showRequirements ? MIN_PASSWORD_LENGTH : undefined}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showError || Boolean(serverError)}
          aria-describedby={`${name}-hint`}
          className={cn("pr-10", (showError || serverError) && "border-danger focus-visible:ring-danger/40")}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>

      <div id={`${name}-hint`} aria-live="polite">
        {serverError ? (
          <p className="text-xs font-medium text-danger">{serverError}</p>
        ) : showRequirements ? (
          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              showError ? "font-medium text-danger" : valid ? "text-success" : "text-subtle",
            )}
          >
            {value.length === 0 ? null : valid ? (
              <Check className="size-3.5 shrink-0" strokeWidth={2.5} />
            ) : (
              <X className="size-3.5 shrink-0" strokeWidth={2.5} />
            )}
            {value.length === 0
              ? `Use at least ${MIN_PASSWORD_LENGTH} characters`
              : valid
                ? "Long enough"
                : `Too short — ${MIN_PASSWORD_LENGTH - value.length} more character${
                    MIN_PASSWORD_LENGTH - value.length === 1 ? "" : "s"
                  } needed`}
          </p>
        ) : null}
      </div>
    </div>
  );
}
