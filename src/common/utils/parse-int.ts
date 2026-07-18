/** Parse a positive-integer query param; anything absent, non-numeric, or < 1 becomes undefined. */
export function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
