import type { DatePrecision } from '../db/schema.js';

/**
 * Deterministic date handling.
 *
 * The AI is only trusted to copy the manufacturer's date wording. Precision
 * and normalisation are derived here so a month-only or year-only commitment
 * can never become an invented exact date.
 */

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_PATTERN =
  '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';

export interface ParsedDate {
  precision: DatePrecision;
  /** Only set for day precision with a real calendar date. */
  normalizedDate: string | null;
  /** Canonical precision-aware key used to compare date wordings. */
  key: string;
}

export interface DateAnalysis {
  dateText: string | null;
  precision: DatePrecision | null;
  normalizedDate: string | null;
}

function cleanDateText(value: string): string {
  return value
    .trim()
    .replace(/\u00a0/g, ' ')
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./gi, '$1')
    .replace(/[.,;:]+$/g, '')
    .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function validDay(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2199) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function dayResult(year: number, month: number, day: number): ParsedDate | null {
  if (!validDay(year, month, day)) return null;
  const normalizedDate = `${year}-${pad2(month)}-${pad2(day)}`;
  return { precision: 'day', normalizedDate, key: `day:${normalizedDate}` };
}

function monthResult(year: number, month: number): ParsedDate | null {
  if (year < 1900 || year > 2199 || month < 1 || month > 12) return null;
  return { precision: 'month', normalizedDate: null, key: `month:${year}-${pad2(month)}` };
}

function yearResult(year: number): ParsedDate | null {
  if (year < 1900 || year > 2199) return null;
  return { precision: 'year', normalizedDate: null, key: `year:${year}` };
}

/**
 * Parses a single date expression. Only unambiguous formats are accepted;
 * anything else keeps its original text and gains no precision.
 */
export function parseDateText(value: string): ParsedDate | null {
  const text = cleanDateText(value);
  if (!text) return null;

  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const result = dayResult(Number(match[1]), Number(match[2]), Number(match[3]));
    if (result) return result;
  }

  match = new RegExp(`^(\\d{1,2})\\s+${MONTH_PATTERN}\\s+(\\d{4})$`, 'i').exec(text);
  if (match) {
    const month = MONTHS[match[2]?.toLowerCase() ?? ''];
    if (month) {
      const result = dayResult(Number(match[3]), month, Number(match[1]));
      if (result) return result;
    }
  }

  match = new RegExp(`^${MONTH_PATTERN}\\s+(\\d{1,2})\\s+(\\d{4})$`, 'i').exec(text);
  if (match) {
    const month = MONTHS[match[1]?.toLowerCase() ?? ''];
    if (month) {
      const result = dayResult(Number(match[3]), month, Number(match[2]));
      if (result) return result;
    }
  }

  match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (match) {
    const result = dayResult(Number(match[3]), Number(match[2]), Number(match[1]));
    if (result) return result;
  }

  match = new RegExp(`^${MONTH_PATTERN}\\s+(\\d{4})$`, 'i').exec(text);
  if (match) {
    const month = MONTHS[match[1]?.toLowerCase() ?? ''];
    if (month) {
      const result = monthResult(Number(match[2]), month);
      if (result) return result;
    }
  }

  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match) {
    const result = monthResult(Number(match[1]), Number(match[2]));
    if (result) return result;
  }

  match = /^(\d{4})$/.exec(text);
  if (match) {
    return yearResult(Number(match[1]));
  }

  return null;
}

/**
 * Analyses the model-reported date text. When no date text is present the
 * claim is date-less (for example a policy expressed as a duration), which is
 * valid and leaves both date precision and normalised date empty.
 */
export function analyzeDateText(dateText: string | null | undefined): DateAnalysis {
  if (!dateText || dateText.trim() === '') {
    return { dateText: null, precision: null, normalizedDate: null };
  }

  const trimmed = dateText.trim();
  const parsed = parseDateText(trimmed);

  return {
    dateText: trimmed,
    precision: parsed?.precision ?? null,
    normalizedDate: parsed?.normalizedDate ?? null,
  };
}

const CANDIDATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_PATTERN}\\s*,?\\s*\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH_PATTERN}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g,
  new RegExp(`\\b${MONTH_PATTERN}\\s*,?\\s*\\d{4}\\b`, 'gi'),
  /\b\d{4}-\d{2}\b/g,
  /\b(?:19|20|21)\d{2}\b/g,
];

/**
 * Finds date-like expressions in a larger passage, longest/most precise forms
 * first. Used to verify that the model's date text is genuinely present in the
 * supporting quotation, even when punctuation differs.
 */
export function findDateExpressions(text: string): ParsedDate[] {
  const found: ParsedDate[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  // "Dec. 2030" and "15 Dec. 2030" are common on manufacturer pages.
  const prepared = text.replace(
    /\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./gi,
    '$1',
  );

  for (const pattern of CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prepared)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some((range) => start < range.end && end > range.start)) continue;

      const parsed = parseDateText(match[0]);
      if (!parsed) continue;

      occupied.push({ start, end });
      found.push(parsed);
    }
  }

  return found;
}

/**
 * True when the date wording supplied by the model is present in the quotation
 * at the same precision. A year inferred from a full date (or vice versa) is
 * rejected so precision cannot silently change between runs.
 */
export function dateTextSupportedByQuotation(
  dateText: string,
  quotation: string,
): boolean {
  const parsedDate = parseDateText(dateText);
  if (!parsedDate) {
    const compact = cleanDateText(dateText).toLowerCase();
    return compact.length > 0 && cleanDateText(quotation).toLowerCase().includes(compact);
  }

  return findDateExpressions(quotation).some((candidate) => candidate.key === parsedDate.key);
}
