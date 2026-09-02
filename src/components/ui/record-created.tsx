"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Full-screen confirmation after a record is written.
 *
 * Shown on the DESTINATION page rather than by the form, because the server
 * action ends in `redirect()` — by the time this renders the write has already
 * committed, so the tick can never claim a success that did not happen.
 *
 * It then routes on to the list view. The delay is deliberately short: long
 * enough to register, not long enough to feel like a wait.
 */
export function RecordCreated({
  title,
  detail,
  continueTo,
  continueLabel,
  delayMs = 1900,
}: {
  title: string;
  detail?: string;
  /** Where to send the user next. */
  continueTo: string;
  continueLabel: string;
  delayMs?: number;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const go = () => {
      setLeaving(true);
      router.replace(continueTo);
    };
    timers.current.push(setTimeout(go, delayMs));
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, [continueTo, delayMs, router]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background/95 backdrop-blur-sm transition-opacity duration-300 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      <svg viewBox="0 0 72 72" className="size-24" aria-hidden="true">
        <circle
          cx="36" cy="36" r="32" fill="none" strokeWidth="4"
          className="stroke-success/25"
        />
        <circle
          cx="36" cy="36" r="32" fill="none" strokeWidth="4" strokeLinecap="round"
          className="origin-center -rotate-90 stroke-success [stroke-dasharray:201] [animation:record-ring_620ms_ease-out_both]"
        />
        <path
          d="M22 37.5 32 47 51 27" fill="none" strokeWidth="5"
          strokeLinecap="round" strokeLinejoin="round"
          className="stroke-success [stroke-dasharray:46] [animation:record-tick_420ms_260ms_ease-out_both]"
        />
      </svg>

      <div className="space-y-1 px-6 text-center">
        <p className="text-lg font-semibold">{title}</p>
        {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      </div>

      <button
        type="button"
        onClick={() => {
          setLeaving(true);
          router.replace(continueTo);
        }}
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {continueLabel}
      </button>
    </div>
  );
}
