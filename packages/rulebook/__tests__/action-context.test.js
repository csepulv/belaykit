import { expect, test } from 'vitest';
import { Rulebook } from '../index.js';

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
