import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { expiresAfter, snapshotTurn } from './online-evals';

const CARD = '4242 4242 4242 4242';
const conversation = [
  new HumanMessage('hello'),
  new AIMessage({ content: 'Hi! How can I help?', id: 'r1' }),
  new HumanMessage(`find blue mugs, my card is ${CARD}`),
  new AIMessage({ content: '', id: 'c1', tool_calls: [{ id: 't1', name: 'search_products', args: { query: 'blue mug' }, type: 'tool_call' }] }),
  new ToolMessage({ tool_call_id: 't1', name: 'search_products', content: JSON.stringify({ results: [{ name: 'Blue Glazed Mug' }], note: 'x'.repeat(3000) }) }),
  new AIMessage({ content: [{ type: 'text', text: 'The Blue Glazed Mug is $24.' }], id: 'r2' }),
];

describe('snapshotTurn (spec 021)', () => {
  it('takes the turn from the customer message through the reply, with each call and its result', () => {
    const snapshot = snapshotTurn(conversation)!;
    expect(snapshot.reply).toBe('The Blue Glazed Mug is $24.');
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.name).toBe('search_products');
    expect(JSON.parse(snapshot.calls[0]!.args)).toEqual({ query: 'blue mug' });
    expect(snapshot.calls[0]!.result).toContain('Blue Glazed Mug');
  });

  it('redacts card numbers and truncates long tool results', () => {
    const snapshot = snapshotTurn(conversation)!;
    expect(snapshot.message).toContain('find blue mugs');
    expect(snapshot.message).not.toContain(CARD);
    expect(snapshot.calls[0]!.result.length).toBe(2000);
  });

  it('snapshots an earlier reply by its index, and nothing that is not a reply', () => {
    expect(snapshotTurn(conversation, 1)).toEqual({ message: 'hello', calls: [], reply: 'Hi! How can I help?' });
    expect(snapshotTurn(conversation, 2)).toBeNull();
    expect(snapshotTurn([new AIMessage('no customer message before me')])).toBeNull();
  });

  it('sets expiry a number of days ahead', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    expect(expiresAfter(30, from).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});
