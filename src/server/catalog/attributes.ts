/**
 * Parses the simple `key: value` lines merchants type into structured
 * attributes. Comma-separated values become arrays, and "true"/"false"/numbers
 * are coerced — agents filter on these, so types matter.
 *
 * Plain and synchronous. It used to be an exported `async` function inside a
 * `"use server"` module, which made a pure string parser a POST endpoint
 * (NOTES.md §7) and left it untestable (§8.14).
 */
export function parseAttributeLines(input: string): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const line of input.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key || !raw) continue;

    const camel = key
      .toLowerCase()
      .replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
      .replace(/[^a-zA-Z0-9]/g, "");

    if (raw.includes(",")) {
      attributes[camel] = raw.split(",").map((v) => v.trim()).filter(Boolean);
    } else if (/^(true|false)$/i.test(raw)) {
      attributes[camel] = raw.toLowerCase() === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      attributes[camel] = Number(raw);
    } else {
      attributes[camel] = raw;
    }
  }
  return attributes;
}

/** Attribute maps for variants are always string→string. */
export function toStringMap(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)]));
}
