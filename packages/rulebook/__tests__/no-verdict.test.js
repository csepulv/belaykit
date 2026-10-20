import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

// BelayKit assumes no terminal field. An agent ends by its own status, and names any
// field it finishes on as it names every other key.
const RULEBOOK = `
version: 1
sections:
  - name: gather
    when: '!("evidence" in ws.gathered)'
    needs:
      evidence: collect
  - name: decide
    when: ws.status == null
    rules:
      - when: ws.evidence == "confirmed"
        then: { action: settle, status: closed }
      - when: "true"
        then: { action: settle, status: held }
`;

const registryWith = (evidence) => ({
  producers: { collect: { writes: ['evidence'], run: async () => evidence } },
  actions: { settle: { writes: ['status'], params: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.status = params.status; } } },
  initialKeys: ['case_id', 'status'],
});

describe('no assumed verdict', () => {
  test('the working set starts with the agent\'s keys, declared needs and gathered, and no verdict', () => {
    const rulebook = Rulebook.fromText(RULEBOOK, registryWith('confirmed'));

    expect(rulebook.initialize({ case_id: 'c-1', status: null })).toEqual({ case_id: 'c-1', status: null, evidence: null, gathered: [] });
  });

  test('a rulebook that ends by its own status runs to completed', async () => {
    const registry = registryWith('confirmed');
    const rulebook = Rulebook.fromText(RULEBOOK, registry);
    const outcome = await new Agent({
      initializer: (request) => rulebook.initialize({ ...request, status: null }),
      choiceProvider: rulebook.provider(),
      finishChecker: async (ws) => ws.status !== null,
    }).run({ case_id: 'c-1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.workingSet).toEqual({ case_id: 'c-1', status: 'closed', evidence: 'confirmed', gathered: ['evidence'] });
  });

  test('ws.verdict and ws.trace are unknown fields unless the agent declares them', () => {
    const registry = registryWith('confirmed');

    expect(Rulebook.check(RULEBOOK.replace('ws.status == null', 'ws.verdict == null'), registry)).toEqual([
      'section "decide" when: unknown ws field "verdict"',
    ]);
    expect(Rulebook.check(RULEBOOK.replace('ws.status == null', 'ws.trace == null'), registry)).toEqual([
      'section "decide" when: unknown ws field "trace"',
    ]);
    expect(Rulebook.check(RULEBOOK.replace('ws.status == null', 'ws.verdict == null'), { ...registry, initialKeys: ['case_id', 'status', 'verdict'] })).toEqual([]);
  });
});
