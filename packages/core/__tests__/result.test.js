import { describe, expect, test } from 'vitest';
import { Agent } from '../decider.js';

// An agent returns a result: by default its final working set, or whatever its
// finalizer derives from it. A failed run has no result.
const finish = async (ws) => { ws.status = 'closed'; };

const agentWith = ({ finalizer, criteria = async () => ({ matched: true }), actions = [finish] } = {}) => new Agent({
  initializer: (subject) => ({ subject, status: null }),
  choiceProvider: async () => ({ name: 'close', mode: 'first', choices: [{ name: 'close', criteria, actions }] }),
  finishChecker: async (ws) => ws.status !== null,
  ...(finalizer && { finalizer }),
});

describe('the result of a run', () => {
  test('without a finalizer, the result is the final working set', async () => {
    const outcome = await agentWith().run('case-1');

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toBe(outcome.workingSet);
    expect(outcome.result).toEqual({ subject: 'case-1', status: 'closed' });
  });

  test('a finalizer derives the result from the final working set', async () => {
    const outcome = await agentWith({ finalizer: (ws) => ({ outcome: ws.status }) }).run('case-1');

    expect(outcome.result).toEqual({ outcome: 'closed' });
    expect(outcome.workingSet).toEqual({ subject: 'case-1', status: 'closed' });
  });

  test('a finalizer may be async', async () => {
    const outcome = await agentWith({ finalizer: async (ws) => `${ws.subject}: ${ws.status}` }).run('case-1');

    expect(outcome.result).toBe('case-1: closed');
  });

  test('a run that ends no_match still has a result', async () => {
    const outcome = await agentWith({ finalizer: (ws) => ({ outcome: ws.status ?? 'undecided' }), criteria: async () => ({ matched: false }) }).run('case-1');

    expect(outcome.status).toBe('no_match');
    expect(outcome.result).toEqual({ outcome: 'undecided' });
  });

  test('a failed run has no result, and the finalizer is not called', async () => {
    let called = false;
    const outcome = await agentWith({
      finalizer: () => { called = true; return 'unused'; },
      actions: [async () => { throw new Error('write refused'); }],
    }).run('case-1');

    expect(outcome.status).toBe('failed');
    expect('result' in outcome).toBe(false);
    expect(called).toBe(false);
  });

  test('a finalizer that throws ends the run failed, naming it, with the trace so far', async () => {
    const outcome = await agentWith({ finalizer: () => { throw new Error('no outcome for "closed"'); } }).run('case-1');

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('finalizer failed: no outcome for "closed"');
    expect(outcome.workingSet).toEqual({ subject: 'case-1', status: 'closed' });
    expect(outcome.error.trace).toHaveLength(1);
  });
});
