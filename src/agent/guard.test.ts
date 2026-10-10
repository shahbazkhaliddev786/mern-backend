import { describe, expect, it } from 'vitest';
import { chunkKnowledge, readKnowledgeFiles } from './rag/chunk';
import { findSensitive, passesLuhn, redact, StreamRedactor } from './guard';

describe('findSensitive: cards', () => {
  it('finds Luhn-valid card numbers in common formats', () => {
    for (const text of [
      'my card is 4242424242424242',
      'card 4242 4242 4242 4242 exp 12/30',
      '4242-4242-4242-4242',
      'amex 3782 822463 10005',
      'mastercard 5555555555554444.',
    ]) {
      expect(findSensitive(text), text).toEqual(['card']);
    }
  });

  it('leaves ordinary numbers alone', () => {
    for (const text of [
      'order #1A2B3C4D',
      'two of the blue ones under $50',
      'total $142.50 for 3 items',
      'call +1 (555) 234-5678',
      'postal code 54000, phone 03001234567',
      'product 64b0000000000000000000c1',
      '4242424242424241', // fails the checksum
      '1234 5678 9012 3456 7', // doesn't start like a card
      'tracking 12345678901234567890123', // too long
    ]) {
      expect(findSensitive(text), text).toEqual([]);
    }
  });

  it('checks the Luhn sum', () => {
    expect(passesLuhn('4242424242424242')).toBe(true);
    expect(passesLuhn('4242424242424241')).toBe(false);
  });
});

describe('findSensitive: credentials', () => {
  it('finds tokens, Stripe secret keys and passwords given as values', () => {
    for (const text of [
      'token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjMifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'key sk_live_51HxAbCdEfGhIjKl',
      'rk_test_abcdef1234567890',
      'my password is Summer2024!',
      'password: Abc123$xyz',
      'pwd=hunter22',
    ]) {
      expect(findSensitive(text), text).toEqual(['credential']);
    }
  });

  it('leaves questions about passwords alone', () => {
    for (const text of [
      'how do I change my password?',
      'the password is required',
      'I forgot my password, what now',
      'password: please help',
      'sk_ is a prefix',
    ]) {
      expect(findSensitive(text), text).toEqual([]);
    }
  });
});

describe('no false positives on store content', () => {
  it('finds nothing in the live knowledge chunks', async () => {
    const { chunks } = chunkKnowledge(await readKnowledgeFiles());
    for (const chunk of chunks) expect(findSensitive(`${chunk.question}\n${chunk.text}`), chunk.id).toEqual([]);
  });
});

describe('redact', () => {
  it('replaces each match and keeps the rest', () => {
    expect(redact('pay with 4242 4242 4242 4242, password is Summer2024! thanks')).toBe(
      'pay with [card number removed], [credential removed] thanks',
    );
    expect(redact('nothing to see')).toBe('nothing to see');
  });
});

describe('StreamRedactor', () => {
  const run = (chunks: string[]) => {
    const redactor = new StreamRedactor();
    const out = chunks.map((chunk) => redactor.push(chunk));
    return out.join('') + redactor.flush();
  };

  it('passes ordinary text through unchanged and in order', () => {
    const text = 'Here are two running shoes under $50: Trail Runner ($45) and Road Lite ($39). Want details?';
    expect(run(text.match(/.{1,7}/g)!)).toBe(text);
  });

  it('catches a card number split across chunks', () => {
    expect(run(['Your card ', '4242 42', '42 4242 ', '4242 is on file.'])).toBe('Your card [card number removed] is on file.');
  });

  it('never emits a digit of a split number before it is redacted', () => {
    const redactor = new StreamRedactor();
    const emitted = ['Card: 4242 4242', ' 4242 4242', ' ok'].map((chunk) => redactor.push(chunk)).join('') + redactor.flush();
    expect(emitted).not.toMatch(/4242/);
  });
});
