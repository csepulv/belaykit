import { expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

// An agent may derive an id from an action's params as JSON text, so their key order is part of
// the contract: the order the rule wrote them in, at every level, except that integer-like keys
// come first in ascending order, as in any JavaScript object. The same on every run either way.
async function paramsTextReceived(then) {
  const seen = [];
  const registry = {
    producers: {},
    actions: { record: { writes: ['recorded'], params: { type: 'object', additionalProperties: true }, run: async (ws, { params }) => { seen.push(JSON.stringify(params)); ws.recorded = true; } } },
    initialKeys: ['recorded'],
  };
  const rulebook = Rulebook.fromText(`
version: 1
sections:
  - name: record
    when: ws.recorded == null
    rules:
      - when: "true"
        then: ${then}
`, registry);

  const outcome = await new Agent({
    initializer: () => rulebook.initialize({ recorded: null }),
    choiceProvider: rulebook.provider(),
    finishChecker: (ws) => ws.recorded === true,
  }).run({});
  expect(outcome.status).toBe('completed');
  return seen;
}

test('an action receives its params in the order its rule wrote them, nested objects included', async () => {
  expect(await paramsTextReceived('{ action: record, zeta: 1, alpha: { omega: 2, beta: 3 }, mid: x }'))
    .toEqual(['{"zeta":1,"alpha":{"omega":2,"beta":3},"mid":"x"}']);
});

test('integer-like param keys come first, in ascending order, at every level', async () => {
  expect(await paramsTextReceived('{ action: record, b: 1, "2": x, a: 3, "1": y, m: { z: 1, "10": 2, "9": 3 } }'))
    .toEqual(['{"1":"y","2":"x","b":1,"a":3,"m":{"9":3,"10":2,"z":1}}']);
});

// An action takes the working set and one context object, so it names only what it
// uses: the row's literal params, the agent's deps, and (with selectFirst) the item.
const RULEBOOK = `
version: 1
sections:
  - name: settle
    when: ws.status == null
    rules:
      - when: "true"
        then: { action: close, outcome: hold }
`;

test('an action receives its params and deps in one context object', async () => {
  const calls = [];
  const registry = {
    producers: {},
    actions: { close: { writes: ['status'], params: { type: 'object', properties: { outcome: { type: 'string' } }, additionalProperties: false }, run: async (...args) => { calls.push(args); } } },
    initialKeys: ['status'],
  };
  const rulebook = Rulebook.fromText(RULEBOOK, registry);
  const deps = { log: [] };
  const ws = rulebook.initialize({ status: null });
  const choiceSet = await rulebook.provider(deps)(ws);

  await choiceSet.choices[0].actions[0](ws, { matched: true });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(2);
  expect(calls[0][0]).toBe(ws);
  expect(calls[0][1]).toEqual({ params: { outcome: 'hold' }, deps });
  expect(calls[0][1].deps).toBe(deps);
});
