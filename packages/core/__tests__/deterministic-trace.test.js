import { describe, expect, test } from 'vitest';
import { Agent } from '../decider.js';

// The default trace holds only what the run decided, so two runs of the same subject give
// the same trace. What is measured (time) reaches the tracer beside the entry, not in it.
const nodes = ['a', 'b', 'c'];

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const agentWith = ({ failOn = null, tracer, delayMs = 0 } = {}) => new Agent({
  initializer: () => ({ settled: [] }),
  finishChecker: async (ws) => ws.settled.length === nodes.length,
  choiceProvider: async () => ({
    name: 'nodes',
    mode: 'first',
    choices: [{
      name: 'settle',
      criteria: async (ws) => ({ matched: true, data: { node: nodes[ws.settled.length] } }),
      actions: [async (ws, match) => {
        await pause(delayMs);
        if (match.data.node === failOn) throw new Error(`cannot settle ${failOn}`);
        ws.settled = [...ws.settled, match.data.node];
      }],
    }],
  }),
}, tracer === undefined ? {} : { tracer });

describe('the default trace', () => {
  test('is the same for two runs of the same subject, completed or failed, however long each took', async () => {
    for (const failOn of [null, 'b']) {
      const slow = await agentWith({ failOn, delayMs: 5 }).run();
      const fast = await agentWith({ failOn }).run();

      expect(slow.status).toBe(failOn ? 'failed' : 'completed');
      expect(fast.trace).toEqual(slow.trace);
      expect(JSON.stringify(fast.trace)).toBe(JSON.stringify(slow.trace));
    }
  });

  test('has no durationMs on any entry, the failed iteration\'s included', async () => {
    const completed = await agentWith().run();
    const failed = await agentWith({ failOn: 'b' }).run();

    expect(completed.trace).toHaveLength(3);
    expect(failed.trace.at(-1)).toMatchObject({ iteration: 2, failed: true });
    for (const entry of [...completed.trace, ...failed.trace]) expect(entry).not.toHaveProperty('durationMs');
  });
});

describe('a tracer', () => {
  const withDuration = (entry, { durationMs }) => ({ ...entry, durationMs });

  test('receives each iteration\'s duration beside the entry, as a non-negative integer', async () => {
    const outcome = await agentWith({ tracer: withDuration }).run();

    expect(outcome.status).toBe('completed');
    expect(outcome.trace).toHaveLength(3);
    for (const { durationMs } of outcome.trace) {
      expect(Number.isInteger(durationMs)).toBe(true);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('receives the duration of the iteration that failed too', async () => {
    const outcome = await agentWith({ failOn: 'b', tracer: withDuration }).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.trace.at(-1)).toMatchObject({ iteration: 2, failed: true, durationMs: expect.any(Number) });
  });

  test('that throws on a failed iteration leaves that entry as the loop built it, without durationMs', async () => {
    const outcome = await agentWith({
      failOn: 'b',
      tracer: (entry, { durationMs }) => { if (entry.failed) throw new Error('tracer broke too'); return { ...entry, durationMs }; },
    }).run();

    expect(outcome.error.message).toBe('nodes/settle action failed: cannot settle b');
    expect(outcome.trace[0]).toHaveProperty('durationMs');
    expect(outcome.trace[1]).toMatchObject({ iteration: 2, failed: true });
    expect(outcome.trace[1]).not.toHaveProperty('durationMs');
  });
});
