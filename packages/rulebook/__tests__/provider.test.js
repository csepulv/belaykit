import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

const RULEBOOK = `
version: 1
hitPolicyDefault: FIRST
sections:
  - name: lookup
    when: ws.write == null
    needs:
      existing_row: find_row
    rules:
      - when: ws.existing_row != null
        then: { action: finalize, write: updated }
      - when: "true"
        then: { action: finalize, write: created }
`;

function makeRegistry(rowFound) {
  return {
    producers: { find_row: { writes: ['existing_row'], run: async () => (rowFound ? 'row-1' : null) } },
    actions: { finalize: { writes: ['write'], params: { type: 'object', properties: { write: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.write = params.write; } } },
    initialKeys: ['item'],
  };
}

async function runRulebook(rowFound) {
  const registry = makeRegistry(rowFound);
  const rulebook = Rulebook.fromText(RULEBOOK, registry);
  return new Agent({
    initializer: (request) => rulebook.initialize({ ...request, write: null }),
    choiceProvider: rulebook.provider(),
    finishChecker: async (ws) => ws.write !== null,
  }).run({ item: 'x' });
}

describe('rulebook.initialize', () => {
  test('declared keys start null beside the agent\'s own; nothing is gathered yet', () => {
    const rulebook = Rulebook.fromText(RULEBOOK, makeRegistry(false));

    expect(rulebook.initialize({ item: 'x', write: null })).toEqual({ item: 'x', existing_row: null, write: null, gathered: [] });
  });
});

describe('rulebook.provider', () => {
  test('gathers a missing need first, then judges with the section rules', async () => {
    const outcome = await runRulebook(true);

    expect(outcome.workingSet.write).toBe('updated');
    expect(outcome.trace.map(({ set, fired }) => `${set}:${fired.join(',')}`)).toEqual([
      'lookup:gather existing_row',
      'lookup:lookup#1',
    ]);
  });

  test('a producer that finds nothing is gathered with a null value, not treated as a stall', async () => {
    const outcome = await runRulebook(false);

    expect(outcome.workingSet.gathered).toEqual(['existing_row']);
    expect(outcome.workingSet.existing_row).toBeNull();
    expect(outcome.workingSet.write).toBe('created');
  });

  test('returns null when no section claims the working set', async () => {
    const registry = makeRegistry(false);
    const provider = Rulebook.fromText(RULEBOOK, registry).provider();

    expect(await provider({ write: 'done', existing_row: null, gathered: [] })).toBeNull();
  });

  test('a gather-only section stops claiming the working set once its needs are met', async () => {
    const text = 'version: 1\nsections:\n  - name: read\n    when: "true"\n    needs:\n      existing_row: find_row\n';
    const registry = makeRegistry(true);
    const provider = Rulebook.fromText(text, registry).provider();

    expect(await provider({ existing_row: 'row-1', write: null, gathered: ['existing_row'] })).toBeNull();
  });
});
