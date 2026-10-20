import { expect, test } from 'vitest';
import { Agent } from '../decider.js';

// A criterion may return a small `detail` for the trace, beside the `data` it hands to
// its actions. The trace records `detail`, never `data`.
const runChoices = (choices) => new Agent({
  initializer: () => ({ done: false }),
  finishChecker: async (ws) => ws.done,
  choiceProvider: async () => ({ name: 'probe', mode: 'all', choices }),
}, { maxIterations: 1 }).run({});

const node = { id: 'b', status: 'open', notes: 'a long transcript…' };

test('a criterion\'s detail is recorded in its evaluated entry, and its data is not', async () => {
  let received;
  const outcome = await runChoices([
    {
      name: 'probe_unknown',
      criteria: async () => ({ matched: true, data: { selected: node }, detail: { node: 1 } }),
      actions: [async (ws, match) => { received = match.data; ws.done = true; }],
    },
    { name: 'skip', criteria: async () => ({ matched: false, detail: { node: null } }), actions: [] },
    { name: 'plain', criteria: async () => ({ matched: false }), actions: [] },
  ]);

  expect(outcome.trace[0].evaluated).toEqual([
    { choice: 'probe_unknown', matched: true, detail: { node: 1 } },
    { choice: 'skip', matched: false, detail: { node: null } },
    { choice: 'plain', matched: false },
  ]);
  expect(JSON.stringify(outcome.trace)).not.toContain('a long transcript');
  expect(received).toEqual({ selected: node });
});

test('a malformed criterion result is described without its data, which may be large, private or unserializable', async () => {
  const outcome = await runChoices([
    { name: 'probe', criteria: async () => ({ matched: 'yes', data: { transcript: 'a long transcript…', count: 2n } }), actions: [] },
  ]);

  expect(outcome.status).toBe('failed');
  expect(outcome.error.message).toBe('probe/probe criteria returned { matched: "yes", data }, expected { matched }');
  expect(outcome.trace[0].evaluated).toEqual([{ choice: 'probe', error: 'returned { matched: "yes", data }, expected { matched }' }]);
});
