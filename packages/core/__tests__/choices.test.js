import { describe, expect, test } from 'vitest';
import { Agent, always, chain, IterationLimitError } from '../index.js';

describe('always', () => {
  test('matches any working set', async () => {
    expect(await always({})).toEqual({ matched: true });
  });
});

describe('chain', () => {
  test('the first provider that returns a set wins; a code provider fills the gaps', async () => {
    const rulebook = async () => null;
    const code = async () => ({ name: 'code-section', mode: 'first', choices: [] });

    expect((await chain([rulebook, code])({})).name).toBe('code-section');
  });

  test('passes (null) when no provider claims the working set, so chains nest', async () => {
    const inner = chain([async () => null]);
    const code = async () => ({ name: 'code-section', mode: 'first', choices: [] });

    expect(await inner({})).toBeNull();
    expect((await chain([inner, code])({})).name).toBe('code-section');
  });

  test('as the agent\'s provider, a chain that passes ends the run failed', async () => {
    const outcome = await new Agent({
      initializer: () => ({ done: false }),
      choiceProvider: chain([async () => null]),
      finishChecker: (ws) => ws.done,
    }).run({});

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('iteration 1 choiceProvider returned no choice set');
  });
});

describe('index', () => {
  test('exposes the Agent class and its error type', () => {
    expect(typeof Agent).toBe('function');
    expect(new IterationLimitError(1, [])).toBeInstanceOf(Error);
  });
});
