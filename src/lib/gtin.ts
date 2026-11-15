const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * Validates a GTIN-8/12/13/14 check digit. Plain digit strings only, so leading
 * zeros are preserved end to end (the value is never parsed as a number).
 */
export function isValidGtin(value: string): boolean {
  if (!/^[0-9]+$/.test(value) || !GTIN_LENGTHS.has(value.length)) {
    return false;
  }

  const digits = value.split('').map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return false;

  // Weights alternate 3/1 starting from the rightmost data digit.
  let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += (digits[i] ?? 0) * weight;
  }

  return (10 - (sum % 10)) % 10 === checkDigit;
}
