import { expect, test } from 'vitest';
import * as core from '@belaykit/core';

// Imported by package name, so this goes through the exports map a consumer uses.
const { Agent, always } = core;

test('the package entry exports the public API', () => {
  expect(Object.keys(core).sort()).toEqual(['Agent', 'IterationLimitError', 'always', 'chain']);
});

test('the README usage example runs to completed', async () => {
  const agent = new Agent({
    initializer: (subject) => ({ subject, approved: null }),
    choiceProvider: async () => ({
      name: 'decide',
      mode: 'first_else_all',
      first: [{ name: 'fast-track', criteria: async (w) => ({ matched: w.subject.score > 90 }), actions: [async (w) => { w.approved = true; }] }],
      all: [{ name: 'review', criteria: always, actions: [async (w) => { w.approved = false; }] }],
    }),
    finishChecker: (ws) => ws.approved !== null,
  });

  const outcome = await agent.run({ score: 95 });

  expect(outcome.status).toBe('completed');
  expect(outcome.result.approved).toBe(true);
  expect(outcome.trace.map(({ set, fired }) => ({ set, fired }))).toEqual([{ set: 'decide', fired: ['fast-track'] }]);
});

// A small agent written the way the docs teach, end to end: what it's given and what it returns.
test('a small agent written as the docs teach produces the outcome they describe', async () => {
  const agent = new Agent({
    initializer: (subject) => ({ text: subject.text, labels: [] }),
    choiceProvider: async (ws) => ({
      name: 'label',
      mode: 'first',
      choices: [
        { name: 'urgent', criteria: async (ws) => ({ matched: ws.text.includes('down') }), actions: [async (ws) => { ws.labels.push('urgent'); }] },
        { name: 'routine', criteria: always, actions: [async (ws) => { ws.labels.push('routine'); }] },
      ],
    }),
    finishChecker: (ws) => ws.labels.length > 0,
    finalizer: (ws) => ws.labels,
  }, {
    tracer: (entry) => ({ set: entry.set, fired: entry.fired }),   // keep only what fired
    maxIterations: 5,
  });

  const outcome = await agent.run({ text: 'server down' });

  expect(outcome).toEqual({
    status: 'completed', result: ['urgent'], workingSet: { text: 'server down', labels: ['urgent'] },
    trace: [{ set: 'label', fired: ['urgent'] }],
  });
});
