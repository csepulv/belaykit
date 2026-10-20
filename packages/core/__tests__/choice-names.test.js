import { expect, test } from 'vitest';
import { Agent } from '../decider.js';

// Choice names are the trace's only identity, so a set must not repeat one.
const run = (choiceSet, checked = []) => new Agent({
  initializer: () => ({ done: false }),
  finishChecker: async (ws) => ws.done,
  choiceProvider: async () => choiceSet,
}).run({}).then((outcome) => ({ outcome, checked }));

const choice = (name, checked) => ({
  name,
  criteria: async () => { checked.push(name); return { matched: true }; },
  actions: [async (ws) => { ws.done = true; }],
});

test('a set that repeats a choice name fails the run before any criterion runs, naming the set and the name', async () => {
  const checked = [];
  const { outcome } = await run({ name: 'judge', mode: 'first', choices: [choice('accept', checked), choice('accept', checked)] }, checked);

  expect(outcome.status).toBe('failed');
  expect(outcome.error.message).toMatch(/choice set "judge" has duplicate choice name "accept"/);
  expect(checked).toEqual([]);
});

test('a name repeated across the two groups of a combined set fails the run, even though first would win', async () => {
  const checked = [];
  const { outcome } = await run({ name: 'review', mode: 'first_else_all', first: [choice('accept', checked)], all: [choice('accept', checked)] }, checked);

  expect(outcome.status).toBe('failed');
  expect(outcome.error.message).toMatch(/choice set "review" has duplicate choice name "accept"/);
  expect(checked).toEqual([]);
});

test('a choice without a name fails the run before any criterion runs, naming its place', async () => {
  const checked = [];
  const nameless = (label) => ({ criteria: async () => { checked.push(label); return { matched: true }; }, actions: [] });
  const { outcome } = await run({ name: 'judge', mode: 'first', choices: [choice('accept', checked), nameless('b')] }, checked);

  expect(outcome.status).toBe('failed');
  expect(outcome.error.message).toBe('choice set "judge": choice 2 in "choices" needs a string "name"');
  expect(checked).toEqual([]);
});

test('the failed entry for a duplicate-name set lists each never-evaluated name once', async () => {
  const { outcome } = await run({ name: 'judge', mode: 'first', choices: [choice('accept', []), choice('accept', []), choice('note', [])] });

  expect(outcome.trace).toEqual([expect.objectContaining({ set: 'judge', failed: true, evaluated: [], unevaluated: ['accept', 'note'] })]);
  expect(outcome.error.trace).toBe(outcome.trace);
});

test('unique names across both groups run as before', async () => {
  const checked = [];
  const { outcome } = await run({ name: 'review', mode: 'first_then_all', first: [choice('accept', checked)], all: [choice('note', checked)] }, checked);

  expect(outcome.status).toBe('completed');
  expect(checked).toEqual(['accept', 'note']);
});
