import { z } from 'zod';
import { describe, expect, test } from 'vitest';
import { askJson } from '../src/llm.js';

const schema = z.object({ answer: z.string() });
const clientReturning = (response) => {
  const requests = [];
  return { requests, anthropic: { messages: { parse: async (request) => { requests.push(request); return response; } } } };
};

describe('askJson', () => {
  test('one structured call: a cached system block, the user prompt, the parsed answer', async () => {
    const { requests, anthropic } = clientReturning({ parsed_output: { answer: 'yes' }, stop_reason: 'end_turn', usage: {} });

    expect(await askJson({ system: 'SYSTEM', prompt: 'Q?', schema }, { anthropic })).toEqual({ answer: 'yes' });
    expect(requests[0].system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'Q?' }]);
    expect(requests[0].model).toBe('claude-sonnet-5-5');
  });

  test('a refusal or an answer outside the schema throws, saying which', async () => {
    const refused = clientReturning({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: {} });
    const missed = clientReturning({ parsed_output: null, stop_reason: 'max_tokens', usage: {} });

    await expect(askJson({ system: 'S', prompt: 'P', schema }, { anthropic: refused.anthropic })).rejects.toThrow('the model refused (cyber)');
    await expect(askJson({ system: 'S', prompt: 'P', schema }, { anthropic: missed.anthropic })).rejects.toThrow("the model's answer didn't match the schema (stop_reason: max_tokens)");
  });

  test('without a client or ANTHROPIC_API_KEY, it says what to set', async () => {
    await expect(askJson({ system: 'S', prompt: 'P', schema }, { env: {} })).rejects.toThrow('ANTHROPIC_API_KEY is required for a live run');
  });
});
