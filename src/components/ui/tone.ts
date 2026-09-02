/**
 * Status tones.
 *
 * Kept separate from shadcn's `variant` prop because these carry meaning —
 * good / warning / danger / info — rather than visual emphasis. Every tone is
 * always paired with a word in the UI, so colour never carries the meaning
 * alone (see the accessibility notes in docs/PLAN.md).
 */
export const toneStyles = {
  neutral: "bg-muted text-muted-foreground border-border",
  accent: "bg-primary-soft text-accent-foreground border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
} as const;

export type Tone = keyof typeof toneStyles;
