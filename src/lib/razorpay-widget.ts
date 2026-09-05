/**
 * Loading the hosted payment widget, in ONE place.
 *
 * Four surfaces open Razorpay's checkout window, and each had its own copy of
 * "append a script tag in an effect, then read `window.Razorpay` when the
 * shopper clicks". `GroupCheckoutFlow` — the component `/checkout` actually
 * renders — was written later and never got the script tag at all, so paying
 * by card there failed for everyone with "Payment widget unavailable". That is
 * §8.13 in a new dress: a path was rebuilt and one behaviour of the original
 * was not carried across, and the only durable fix is that there is nothing
 * left to carry.
 *
 * **Load state is a promise, not a sample of `window`.** Reading
 * `window.Razorpay` at click time cannot tell "still loading" from "blocked by
 * an extension" from "never asked for", so a shopper on a slow connection got
 * the same dead end as one with an ad blocker. Awaiting this answers honestly.
 *
 * It resolves to the CONSTRUCTOR rather than a boolean, so the caller holds the
 * thing it is about to use — a boolean would leave every call site re-reading
 * `window.Razorpay` afterwards, which no longer narrows across the await and is
 * the same unchecked assumption in a smaller place.
 */

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * Long enough for a slow connection, short enough that a blocked script does
 * not leave the shopper watching a spinner. A content blocker usually fires
 * `error` immediately; a few silently drop the request instead, which is the
 * case this bound exists for.
 */
const LOAD_TIMEOUT_MS = 12_000;

export type RazorpayConstructor = NonNullable<Window["Razorpay"]>;

/** One load per page, shared by every surface that opens the widget. */
let pending: Promise<RazorpayConstructor | null> | null = null;

export function loadRazorpayWidget(): Promise<RazorpayConstructor | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (pending) return pending;

  pending = new Promise<RazorpayConstructor | null>((resolve) => {
    const settle = (widget: RazorpayConstructor | null) => {
      // A failed load must not be cached as a permanent verdict: the shopper
      // may well disable the blocker and try again without a reload.
      if (!widget) pending = null;
      resolve(widget);
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SRC}"]`);
    const script = existing ?? document.createElement("script");

    script.addEventListener("load", () => settle(window.Razorpay ?? null));
    script.addEventListener("error", () => settle(null));

    if (!existing) {
      script.src = RAZORPAY_SRC;
      script.async = true;
      document.body.appendChild(script);
    }

    // Covers both a request dropped without an error event and a tag that had
    // already finished loading before these listeners were attached.
    setTimeout(() => settle(window.Razorpay ?? null), LOAD_TIMEOUT_MS);
  });

  return pending;
}

/**
 * What to tell the shopper when it will not load.
 *
 * Names the likeliest cause, because "unavailable" sends someone to check
 * their card details when the actual problem is an extension blocking a
 * third-party script — and says plainly that no money moved.
 */
export const WIDGET_UNAVAILABLE =
  "The payment window could not load — an ad or script blocker is the usual cause. " +
  "Nothing was authorised and you have not been charged. Allow checkout.razorpay.com and try again, " +
  "or enable a saved payment method in Settings.";
