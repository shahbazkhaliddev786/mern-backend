// The payment boundary (spec 016, security.md §8): card numbers and credentials never reach the
// model, its tools or the customer's screen through the agent. These functions report what kind
// of data they found and never return the data itself, so nothing sensitive reaches a log.
// The browser has a copy of the patterns (mern-frontend shopping-agent/services/sensitive.ts);
// keep the two in step.

export type SensitiveKind = 'card' | 'credential';

// 13–19 digits, single spaces or dashes allowed between them, not part of a longer word or
// number. Card numbers start with 2–6 (Mastercard, Amex, Visa, Discover and friends), which
// also rules out runs of zeros inside ids.
const CARD = /(?<![\w-])[2-6](?:[ -]?\d){12,18}(?![\w-])/g;

const CREDENTIALS = [
  // JSON Web Tokens: header.payload.signature, the header always starting {" → eyJ
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  // Stripe secret and restricted keys
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  // A password given as a value. The store's password rules require a digit, so the value must
  // have one: "my password is Summer2024!" matches, "the password is required" doesn't.
  /\b(?:password|passwd|pwd)\s*(?:is|:|=)\s*(?=\S*\d)\S{6,}/gi,
];

/** The Luhn checksum every card number carries. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

interface Match {
  kind: SensitiveKind;
  start: number;
  end: number;
}

function matches(text: string): Match[] {
  const found: Match[] = [];
  for (const match of text.matchAll(CARD)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      found.push({ kind: 'card', start: match.index, end: match.index + match[0].length });
    }
  }
  for (const pattern of CREDENTIALS) {
    for (const match of text.matchAll(pattern)) found.push({ kind: 'credential', start: match.index, end: match.index + match[0].length });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The kinds of sensitive data in the text, if any. Never the data. */
export function findSensitive(text: string): SensitiveKind[] {
  return [...new Set(matches(text).map((match) => match.kind))];
}

const REPLACEMENT: Record<SensitiveKind, string> = { card: '[card number removed]', credential: '[credential removed]' };

/** The text with every match replaced by a placeholder. */
export function redact(text: string): string {
  let out = '';
  let at = 0;
  for (const match of matches(text)) {
    if (match.start < at) continue; // overlapping matches: the first one wins
    out += text.slice(at, match.start) + REPLACEMENT[match.kind];
    at = match.end;
  }
  return out + text.slice(at);
}

/**
 * Redacts streamed text. The last HOLD characters are held back until more arrives, so a card
 * number split across chunks is still caught; `flush()` releases the rest at the end of the stream.
 */
export class StreamRedactor {
  // A grouped 19-digit card number is 37 characters.
  private static readonly HOLD = 40;
  private buffer = '';

  push(text: string): string {
    this.buffer += text;
    let cut = Math.max(0, this.buffer.length - StreamRedactor.HOLD);
    // Never split a match: if one straddles the cut, hold it back whole.
    for (const match of matches(this.buffer)) if (match.start < cut && match.end > cut) cut = match.start;
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return redact(ready);
  }

  flush(): string {
    const rest = redact(this.buffer);
    this.buffer = '';
    return rest;
  }
}

/**
 * A file name as one plain line for the model (spec 022): no control characters or line breaks,
 * no quotes or brackets that could close the server's note, spaces collapsed, at most 80 characters.
 */
export const cleanFileName = (name: string): string =>
  name
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/["[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'image';
