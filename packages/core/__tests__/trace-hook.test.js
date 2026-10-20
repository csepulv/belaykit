import { describe, expect, test } from 'vitest';
import { Agent, IterationLimitError } from '../decider.js';

// An agent decides how much to trace: a tracer maps each iteration's entry to what it
// keeps (or null to keep nothing), and `tracer: false` keeps no trace at all.
const nodes = ['a', 'b', 'c'];

// Each iteration settles the next open node; the run finishes when all are settled.
const settleNext = {
  name: 'settle',
  criteria: async (ws) => {
    const index = ws.settled.length;
    return index < nodes.length ? { matched: true, data: { node: nodes[index] }, detail: { node: index } } : { matched: false };
  },
  actions: [async (ws, match) => { ws.settled = [...ws.settled, match.data.node]; }],
};

const agentWith = ({ tracer, actions = settleNext.actions, maxIterations = 10 } = {}) => new Agent({
  initializer: () => ({ settled: [] }),
  finishChecker: async (ws) => ws.settled.length === nodes.length,
  choiceProvider: async () => ({ name: 'nodes', mode: 'first', choices: [{ ...settleNext, actions }] }),
}, {
  maxIterations,
  ...(tracer !== undefined && { tracer }),
});

const failOn = (node) => [async (ws, match) => {
  if (match.data.node === node) throw new Error(`cannot settle ${node}`);
  ws.settled = [...ws.settled, match.data.node];
}];

describe('the default trace', () => {
  test('keeps each iteration\'s entry, with the criterion\'s detail', async () => {
    const outcome = await agentWith().run();

    expect(outcome.trace.map(({ iteration, fired, evaluated }) => ({ iteration, fired, evaluated }))).toEqual([
      { iteration: 1, fired: ['settle'], evaluated: [{ choice: 'settle', matched: true, detail: { node: 0 } }] },
      { iteration: 2, fired: ['settle'], evaluated: [{ choice: 'settle', matched: true, detail: { node: 1 } }] },
      { iteration: 3, fired: ['settle'], evaluated: [{ choice: 'settle', matched: true, detail: { node: 2 } }] },
    ]);
  });
});

describe('a tracer', () => {
  test('keeps what it returns for each iteration, built from the entry and the criteria\'s data', async () => {
    const compact = (entry, { matches }) => ({ step: entry.iteration, node: matches.find(({ result }) => result.matched)?.result.data.node });
    const outcome = await agentWith({ tracer: compact }).run();

    expect(outcome.status).toBe('completed');
    expect(outcome.trace).toEqual([{ step: 1, node: 'a' }, { step: 2, node: 'b' }, { step: 3, node: 'c' }]);
  });

  test('sees each criterion that returned, by choice name, with its full result', async () => {
    const seen = [];
    await agentWith({ tracer: (entry, { matches }) => { seen.push(matches); return entry; } }).run();

    expect(seen[0]).toEqual([{ choice: 'settle', result: { matched: true, data: { node: 'a' }, detail: { node: 0 } } }]);
  });

  test('keeps nothing for an iteration when it returns null', async () => {
    const outcome = await agentWith({ tracer: (entry) => (entry.iteration === 2 ? null : { step: entry.iteration }) }).run();

    expect(outcome.trace).toEqual([{ step: 1 }, { step: 3 }]);
  });

  test('also maps the failed iteration, so a failed run shows where it stopped in the agent\'s own shape', async () => {
    const outcome = await agentWith({ tracer: (entry) => ({ step: entry.iteration, failed: entry.failed ?? false }), actions: failOn('b') }).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('nodes/settle action failed: cannot settle b');
    expect(outcome.trace).toEqual([{ step: 1, failed: false }, { step: 2, failed: true }]);
    expect(outcome.error.trace).toEqual(outcome.trace);
  });

  test('its values are the trace an IterationLimitError carries', async () => {
    const outcome = await agentWith({ tracer: (entry) => entry.iteration, maxIterations: 2 }).run();

    expect(outcome.error).toBeInstanceOf(IterationLimitError);
    expect(outcome.error.trace).toEqual([1, 2]);
    expect(outcome.trace).toEqual([1, 2]);
  });

  test('that throws ends the run failed, naming the tracer', async () => {
    const outcome = await agentWith({ tracer: (entry) => { if (entry.iteration === 2) throw new Error('no node id'); return entry.iteration; } }).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('tracer failed: no node id');
    expect(outcome.trace).toEqual([1]);
  });

  test('that throws on an iteration that already failed can\'t mask the original error; that entry is kept unmapped', async () => {
    const outcome = await agentWith({
      tracer: (entry) => { if (entry.failed) throw new Error('tracer broke too'); return entry.iteration; },
      actions: failOn('b'),
    }).run();

    expect(outcome.error.message).toBe('nodes/settle action failed: cannot settle b');
    expect(outcome.trace[0]).toBe(1);
    expect(outcome.trace[1]).toMatchObject({ iteration: 2, failed: true, fired: [] });
  });
});

describe('tracer: false', () => {
  test('keeps no trace, for a completed run and a failed one', async () => {
    const completed = await agentWith({ tracer: false }).run();
    expect(completed.status).toBe('completed');
    expect(completed.trace).toEqual([]);

    const failed = await agentWith({ tracer: false, actions: failOn('b') }).run();
    expect(failed.error.message).toBe('nodes/settle action failed: cannot settle b');
    expect(failed.trace).toEqual([]);
    expect(failed.error.trace).toEqual([]);
  });
});
