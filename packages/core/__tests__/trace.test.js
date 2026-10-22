import { describe, expect, test } from 'vitest';
import { Agent } from '../decider.js';

// Each trace entry records what the iteration evaluated, what it never evaluated,
// and which actions completed. An iteration that fails still leaves its entry,
// marked failed, in both the outcome's trace and the error's.
const matches = async () => ({ matched: true });
const misses = async () => ({ matched: false });
const throws = (message) => async () => { throw new Error(message); };
const noop = async () => {};
const finish = async (ws) => { ws.done = true; };

const runSet = (choiceSet) => new Agent({
  initializer: () => ({ done: false }),
  finishChecker: async (ws) => ws.done,
  choiceProvider: async () => choiceSet,
}, { maxIterations: 1 }).run({});

describe('a completed iteration', () => {
  test('first mode records the criteria that ran, the choices never evaluated, and the actions that completed', async () => {
    const outcome = await runSet({
      name: 'judge',
      mode: 'first',
      choices: [
        { name: 'skip', why: 'not this one', criteria: misses, actions: [noop] },
        { name: 'take', criteria: matches, actions: [noop, finish] },
        { name: 'later', criteria: matches, actions: [noop] },
      ],
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.trace).toEqual([{
      iteration: 1,
      set: 'judge',
      mode: 'first',
      fired: ['take'],
      evaluated: [{ choice: 'skip', matched: false, why: 'not this one' }, { choice: 'take', matched: true }],
      unevaluated: ['later'],
      executed: [{ choice: 'take', action: 0 }, { choice: 'take', action: 1 }],
    }]);
  });

  test('first_else_all with a first-group match leaves the whole fallback group unevaluated', async () => {
    const outcome = await runSet({
      name: 'review', mode: 'first_else_all',
      first: [{ name: 'fast', criteria: matches, actions: [finish] }],
      all: [{ name: 'slow', criteria: matches, actions: [noop] }, { name: 'slower', criteria: matches, actions: [noop] }],
    });

    expect(outcome.trace[0]).toMatchObject({ mode: 'first_else_all', evaluated: [{ choice: 'fast', matched: true }], unevaluated: ['slow', 'slower'] });
  });

  test('first_else_all with no first-group match evaluates the fallback group, in order', async () => {
    const outcome = await runSet({
      name: 'review', mode: 'first_else_all',
      first: [{ name: 'a', criteria: misses, actions: [] }, { name: 'b', criteria: misses, actions: [] }],
      all: [{ name: 'c', criteria: matches, actions: [finish] }, { name: 'd', criteria: misses, actions: [] }],
    });

    expect(outcome.trace[0]).toMatchObject({
      evaluated: [{ choice: 'a', matched: false }, { choice: 'b', matched: false }, { choice: 'c', matched: true }, { choice: 'd', matched: false }],
      unevaluated: [],
      fired: ['c'],
    });
  });

  test('first_then_all evaluates both groups in order', async () => {
    const outcome = await runSet({
      name: 'review', mode: 'first_then_all',
      first: [{ name: 'a', criteria: misses, actions: [] }, { name: 'b', criteria: matches, actions: [finish] }],
      all: [{ name: 'c', criteria: matches, actions: [noop] }],
    });

    expect(outcome.trace[0]).toMatchObject({
      evaluated: [{ choice: 'a', matched: false }, { choice: 'b', matched: true }, { choice: 'c', matched: true }],
      unevaluated: [],
      executed: [{ choice: 'b', action: 0 }, { choice: 'c', action: 0 }],
      fired: ['b', 'c'],
    });
  });

  test('a no_match iteration keeps its entry, with everything evaluated and nothing executed', async () => {
    const outcome = await runSet({ name: 'judge', mode: 'all', choices: [{ name: 'x', criteria: misses, actions: [finish] }] });

    expect(outcome.status).toBe('no_match');
    expect(outcome.trace[0]).toMatchObject({ fired: [], evaluated: [{ choice: 'x', matched: false }], unevaluated: [], executed: [] });
    expect(outcome.trace[0]).not.toHaveProperty('failed');
  });
});

describe('an iteration that fails leaves a partial entry', () => {
  test('a criterion that throws is recorded as evaluated with its error; the rest are unevaluated', async () => {
    const outcome = await runSet({
      name: 'review', mode: 'first_then_all',
      first: [{ name: 'fast', criteria: matches, actions: [finish] }],
      all: [{ name: 'lookup', why: 'needs the index', criteria: throws('search unavailable'), actions: [] }, { name: 'after', criteria: matches, actions: [] }],
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.trace).toEqual([{
      iteration: 1,
      set: 'review',
      mode: 'first_then_all',
      fired: [],
      evaluated: [{ choice: 'fast', matched: true }, { choice: 'lookup', error: 'search unavailable', why: 'needs the index' }],
      unevaluated: ['after'],
      executed: [],
      failed: true,
    }]);
    expect(outcome.error.trace).toBe(outcome.trace);
  });

  test('a criterion that returns a bad result is recorded as an error', async () => {
    const outcome = await runSet({ name: 'judge', mode: 'first', choices: [{ name: 'quick', criteria: async () => true, actions: [] }] });

    expect(outcome.trace[0]).toMatchObject({ failed: true, evaluated: [{ choice: 'quick', error: 'returned true, expected { matched }' }] });
  });

  test('an action that throws keeps the actions that completed before it', async () => {
    const outcome = await runSet({
      name: 'write', mode: 'all',
      choices: [
        { name: 'first', criteria: matches, actions: [noop] },
        { name: 'second', criteria: matches, actions: [noop, throws('store 503')] },
      ],
    });

    expect(outcome.trace[0]).toMatchObject({
      failed: true,
      fired: ['first'],
      executed: [{ choice: 'first', action: 0 }, { choice: 'second', action: 0 }],
    });
    expect(outcome.error.trace).toBe(outcome.trace);
  });

  test('a set with an unknown mode leaves an entry with no mode and nothing evaluated', async () => {
    const outcome = await runSet({ name: 'judge', choices: [{ name: 'x', criteria: matches, actions: [] }] });

    expect(outcome.status).toBe('failed');
    expect(outcome.trace[0]).toMatchObject({ set: 'judge', failed: true, evaluated: [], unevaluated: [] });
    expect(outcome.trace[0]).not.toHaveProperty('mode');
  });

  test('a provider that throws leaves an entry labelled by its iteration, with nothing evaluated', async () => {
    const outcome = await new Agent({
      initializer: () => ({ done: false }),
      finishChecker: async (ws) => ws.done,
      choiceProvider: throws('section when failed'),
    }).run({});

    expect(outcome.trace).toEqual([{
      iteration: 1, set: 'set 1', fired: [], evaluated: [], unevaluated: [], executed: [], failed: true,
    }]);
    expect(outcome.trace[0]).not.toHaveProperty('mode');
    expect(outcome.error.trace).toBe(outcome.trace);
  });

  test('earlier completed entries stay unmarked', async () => {
    let call = 0;
    const outcome = await new Agent({
      initializer: () => ({ done: false }),
      finishChecker: async (ws) => ws.done,
      choiceProvider: async () => {
        call += 1;
        if (call === 1) return { name: 'gather', mode: 'all', choices: [{ name: 'a', criteria: matches, actions: [noop] }] };
        return { name: 'write', mode: 'first', choices: [{ name: 'create', criteria: matches, actions: [throws('store 503')] }] };
      },
    }).run({});

    expect(outcome.trace.map(({ set, failed }) => ({ set, failed }))).toEqual([{ set: 'gather', failed: undefined }, { set: 'write', failed: true }]);
  });
});
