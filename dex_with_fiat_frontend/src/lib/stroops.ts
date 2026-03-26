const DECIMALS = 7;
const DIVISOR = BigInt(10 ** DECIMALS);

/**
 * Convert a decimal XLM value to stroops (1 XLM = 10,000,000 stroops).
 * Uses string-based arithmetic to avoid floating-point rounding errors.
 * Returns `null` when the input is empty or not a valid XLM amount.
 */
export function xlmToStroops(xlm: string | number): bigint | null {
  const normalized = String(xlm).trim();

  if (!normalized) {
    return null;
  }

  if (!/^\d*(?:\.\d{0,7})?$/.test(normalized)) {
    return null;
  }

  const [wholePart = '0', fractionalPart = ''] = normalized.split('.');

  if (!wholePart && !fractionalPart) {
    return null;
  }

  const whole = wholePart || '0';
  const fraction = (fractionalPart || '').padEnd(DECIMALS, '0');
  return BigInt(whole) * DIVISOR + BigInt(fraction || '0');
}

/**
 * Format a raw stroop value as a human-readable XLM string.
 * Trailing zeros are trimmed (e.g. 50_000_000n → "5").
 */
export function stroopsToXlm(stroops: bigint | string): string {
  const value = typeof stroops === 'string' ? BigInt(stroops) : stroops;
  const whole = value / DIVISOR;
  const frac = value % DIVISOR;
  const fracStr = frac.toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

/** @deprecated Use {@link stroopsToXlm} instead. */
export const stroopsToDisplay = stroopsToXlm;
