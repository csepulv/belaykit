import { describe, expect, test } from 'vitest';
import { Agent, IterationLimitError } from '../decider.js';

const matches = (data) => async () => ({ matched: true, data });
const misses = async () => ({ matched: false });

function recordingAction(log, label) {
  return async (workingSet, match) => {
    log.push(label);
    workingSet.log.push({ label, data: match.data });
  };
}

const initializeLog = (subject) => ({ subject, log: [], done: false });
const isDone = async (workingSet) => workingSet.done;
const finish = async (workingSet) => {
  workingSet.done = true;
};

const runOnce = ({ subject, tracer, maxIterations, ...essentials }) => new Agent(essentials, { tracer, maxIterations }).run(subject);

// Best effort: a run never rejects; an error ends it as a `failed` outcome.
async function failureOf(run) {
  const outcome = await run;
  expect(outcome.status).toBe('failed');
  return outcome;
}

// A choice that records when its criteria are checked and when its action runs.
const tracked = (events, label, matched) => ({
  name: label,
  criteria: async () => {
    events.push(`check ${label}`);
    return { matched };
  },
  actions: [async (workingSet) => {
    events.push(`run ${label}`);
    workingSet.log.push(label);
  }],
});

describe('agent lifecycle', () => {
  test('initializes one working set and passes it to the first provider call', async () => {
    const seen = [];
    const outcome = await runOnce({
      subject: { id: 'r1' },
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async (workingSet) => {
        seen.push(workingSet);
        return { name: 'only', mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] };
      },
    });

    expect(outcome.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(outcome.workingSet);
    expect(seen[0].subject).toEqual({ id: 'r1' });
  });

  test('asks the provider again after an unfinished iteration and accepts a different set', async () => {
    const calls = [];
    await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async (workingSet) => {
        calls.push(workingSet.log.length);
        if (workingSet.log.length === 0) {
          return { name: 'gather', mode: 'all', choices: [{ name: 'a', criteria: matches(), actions: [recordingAction([], 'a')] }] };
        }
        return { name: 'judge', mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] };
      },
    });

    expect(calls).toEqual([0, 1]);
  });

  test('completes without calling the provider when finished from the start', async () => {
    let providerCalls = 0;
    const outcome = await runOnce({
      subject: {},
      initializer: (subject) => ({ ...initializeLog(subject), done: true }),
      finishChecker: isDone,
      choiceProvider: async () => {
        providerCalls += 1;
        return { name: 'never', mode: 'first', choices: [] };
      },
    });

    expect(outcome.status).toBe('completed');
    expect(providerCalls).toBe(0);
  });

  test('completes after an action without another provider call', async () => {
    let providerCalls = 0;
    await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async () => {
        providerCalls += 1;
        return { name: 'only', mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] };
      },
    });

    expect(providerCalls).toBe(1);
  });

  test('returns no_match when nothing in the set matches', async () => {
    const outcome = await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async () => ({ name: 'judge', mode: 'all', choices: [{ name: 'x', criteria: misses, actions: [finish] }] }),
    });

    expect(outcome.status).toBe('no_match');
    expect(outcome.workingSet.done).toBe(false);
    expect(outcome.trace).toEqual([{
      iteration: 1, set: 'judge', mode: 'all', fired: [],
      evaluated: [{ choice: 'x', matched: false }], unevaluated: [], executed: [],
    }]);
  });

  test('without maxIterations the guard stops a spinning run after 25 iterations', async () => {
    const outcome = await failureOf(runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async () => ({ name: 'spin', mode: 'first', choices: [{ name: 'noop', criteria: matches(), actions: [async () => {}] }] }),
    }));

    expect(outcome.error.message).toMatch(/after 25 iterations/);
  });

  test('a choice that keeps firing without finishing ends the run as failed with IterationLimitError', async () => {
    const outcome = await failureOf(runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      maxIterations: 3,
      choiceProvider: async () => ({ name: 'spin', mode: 'first', choices: [{ name: 'noop', criteria: matches(), actions: [async () => {}] }] }),
    }));

    expect(outcome.error).toBeInstanceOf(IterationLimitError);
    expect(outcome.error.message).toBe('agent stopped after 3 iterations without finishing');
    expect(outcome.trace).toHaveLength(3);
  });

  test('one configured agent runs many subjects, each with its own working set', async () => {
    const agent = new Agent({
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async () => ({ mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] }),
    });

    const first = await agent.run({ id: 1 });
    const second = await agent.run({ id: 2 });

    expect(first.workingSet.subject).toEqual({ id: 1 });
    expect(second.workingSet.subject).toEqual({ id: 2 });
    expect(first.workingSet).not.toBe(second.workingSet);
  });

  test('an agent made with essentials alone runs with the default options', async () => {
    const agent = new Agent({
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async () => ({ name: 'spin', mode: 'first', choices: [{ name: 'noop', criteria: matches(), actions: [async () => {}] }] }),
    });

    const outcome = await failureOf(agent.run({}));

    expect(outcome.error.message).toMatch(/after 25 iterations/);
    expect(outcome.trace).toHaveLength(25);
  });

  test('a finish checker may be synchronous', async () => {
    const outcome = await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: (workingSet) => workingSet.done,
      choiceProvider: async () => ({ name: 'only', mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] }),
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.trace).toHaveLength(1);
  });

  test('records the set name and fired choices in the trace on the result, not the working set', async () => {
    const outcome = await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      choiceProvider: async () => ({
        name: 'judge',
        mode: 'all',
        choices: [
          { name: 'skip', criteria: misses, actions: [] },
          { name: 'finish', criteria: matches(), actions: [finish] },
        ],
      }),
    });

    expect(outcome.trace).toEqual([{
      iteration: 1, set: 'judge', mode: 'all', fired: ['finish'],
      evaluated: [{ choice: 'skip', matched: false }, { choice: 'finish', matched: true }],
      unevaluated: [],
      executed: [{ choice: 'finish', action: 0 }],
    }]);
    expect(outcome.workingSet).not.toHaveProperty('trace');
  });

  test('the iteration-limit failure carries the trace so far', async () => {
    const outcome = await failureOf(runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: isDone,
      maxIterations: 2,
      choiceProvider: async () => ({ name: 'spin', mode: 'first', choices: [{ name: 'noop', criteria: matches(), actions: [async () => {}] }] }),
    }));

    expect(outcome.trace).toMatchObject([{ iteration: 1, set: 'spin' }, { iteration: 2, set: 'spin' }]);
    expect(outcome.error.trace).toBe(outcome.trace);
  });

  test('a failing initializer ends the run as failed with no working set', async () => {
    const outcome = await failureOf(runOnce({
      subject: {},
      initializer: () => { throw new Error('no context'); },
      finishChecker: isDone,
      choiceProvider: async () => ({ mode: 'first', choices: [] }),
    }));

    expect(outcome.error.message).toBe('initializer failed: no context');
    expect(outcome.workingSet).toBeNull();
    expect(outcome.trace).toEqual([]);
  });
});

describe('configuring an agent', () => {
  const essentials = { initializer: initializeLog, finishChecker: isDone, choiceProvider: async () => null };

  test('essentials that aren\'t an object are refused; options may be left out or null', () => {
    expect(() => new Agent()).toThrow(new TypeError('new Agent: the essentials must be an object'));
    expect(() => new Agent([])).toThrow(new TypeError('new Agent: the essentials must be an object'));
    expect(() => new Agent(essentials, 5)).toThrow(new TypeError('new Agent: the options must be an object'));
    expect(new Agent(essentials, null)).toBeInstanceOf(Agent);
  });

  test('an option passed with the essentials is refused, saying where it belongs', () => {
    expect(() => new Agent({ ...essentials, maxIterations: 5 })).toThrow(
      new TypeError('new Agent: unknown essential "maxIterations" (it is an option: pass it in the second argument)'),
    );
  });

  test('an essential passed with the options is refused, saying where it belongs', () => {
    expect(() => new Agent(essentials, { finalizer: (ws) => ws })).toThrow(
      new TypeError('new Agent: unknown option "finalizer" (it is an essential: pass it in the first argument)'),
    );
  });

  test.each(['initializer', 'choiceProvider', 'finishChecker'])('a missing or non-function %s is refused, naming it', (part) => {
    const { [part]: _omitted, ...withoutPart } = essentials;
    expect(() => new Agent(withoutPart)).toThrow(new TypeError(`new Agent: ${part} must be a function`));
    expect(() => new Agent({ ...essentials, [part]: 'yes' })).toThrow(new TypeError(`new Agent: ${part} must be a function`));
  });

  test('a finalizer, when given, must be a function', () => {
    expect(() => new Agent({ ...essentials, finalizer: { result: 1 } })).toThrow(new TypeError('new Agent: finalizer must be a function'));
    expect(new Agent({ ...essentials, finalizer: undefined })).toBeInstanceOf(Agent);
  });

  test('a tracer must be a function or false', () => {
    expect(() => new Agent(essentials, { tracer: true })).toThrow(new TypeError('new Agent: tracer must be a function or false'));
    expect(() => new Agent(essentials, { tracer: null })).toThrow(new TypeError('new Agent: tracer must be a function or false'));
    expect(new Agent(essentials, { tracer: false })).toBeInstanceOf(Agent);
  });

  test.each([['10', '"10"'], [0, '0'], [-1, '-1'], [2.5, '2.5'], [Number.POSITIVE_INFINITY, 'Infinity'], [Number.NaN, 'NaN']])(
    'maxIterations %s is refused: it must be a positive integer',
    (maxIterations, shown) => {
      expect(() => new Agent(essentials, { maxIterations })).toThrow(
        new TypeError(`new Agent: maxIterations must be a positive integer, got ${shown}`),
      );
    },
  );

  test('an agent with valid parts still runs', async () => {
    const agent = new Agent(
      { initializer: initializeLog, finishChecker: isDone, choiceProvider: async () => ({ name: 'only', mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] }), finalizer: (ws) => ws.done },
      { tracer: (entry) => entry.set, maxIterations: 1 },
    );

    expect(await agent.run({})).toMatchObject({ status: 'completed', result: true, trace: ['only'] });
  });

  test('a key that is neither is refused, listing what each argument takes', () => {
    expect(() => new Agent({ ...essentials, isFinished: isDone })).toThrow(
      new TypeError('new Agent: unknown essential "isFinished" (essentials: initializer, choiceProvider, finishChecker, finalizer)'),
    );
    expect(() => new Agent(essentials, { trace: false })).toThrow(
      new TypeError('new Agent: unknown option "trace" (options: tracer, maxIterations)'),
    );
  });
});

describe('agent combined modes', () => {
  const runCombined = (choiceSet) => runOnce({
    subject: {},
    initializer: initializeLog,
    finishChecker: async (workingSet) => workingSet.log.length > 0,
    choiceProvider: async () => choiceSet,
  });

  test('first_else_all with a first-group match runs only that choice and never checks the fallback', async () => {
    const events = [];
    await runCombined({
      name: 'triage',
      mode: 'first_else_all',
      first: [tracked(events, 'fast-a', false), tracked(events, 'fast-b', true), tracked(events, 'fast-c', true)],
      all: [tracked(events, 'look-up', true)],
    });

    expect(events).toEqual(['check fast-a', 'check fast-b', 'run fast-b']);
  });

  test('first_else_all with no first-group match runs every matching fallback choice', async () => {
    const events = [];
    await runCombined({
      name: 'triage',
      mode: 'first_else_all',
      first: [tracked(events, 'fast-a', false)],
      all: [tracked(events, 'history', true), tracked(events, 'refs', false), tracked(events, 'eligibility', true)],
    });

    expect(events).toEqual([
      'check fast-a', 'check history', 'check refs', 'check eligibility', 'run history', 'run eligibility',
    ]);
  });

  test('first_then_all checks both groups before any action, then runs the first match before the all matches', async () => {
    const events = [];
    const outcome = await runCombined({
      name: 'assess',
      mode: 'first_then_all',
      first: [tracked(events, 'approve', false), tracked(events, 'reject', true), tracked(events, 'review', true)],
      all: [tracked(events, 'note-a', true), tracked(events, 'note-b', false)],
    });

    expect(events).toEqual([
      'check approve', 'check reject', 'check note-a', 'check note-b', 'run reject', 'run note-a',
    ]);
    expect(outcome.trace[0].fired).toEqual(['reject', 'note-a']);
  });

  test('a combined set with no match in either group ends the run as no_match', async () => {
    const events = [];
    const outcome = await runCombined({
      name: 'assess',
      mode: 'first_then_all',
      first: [tracked(events, 'approve', false)],
      all: [tracked(events, 'note', false)],
    });

    expect(outcome.status).toBe('no_match');
  });

  test('first_else_all with no match in either group ends the run as no_match', async () => {
    const events = [];
    const outcome = await runCombined({
      name: 'triage',
      mode: 'first_else_all',
      first: [tracked(events, 'fast', false)],
      all: [tracked(events, 'look-up', false)],
    });

    expect(outcome.status).toBe('no_match');
    expect(events).toEqual(['check fast', 'check look-up']);
  });

  test('an unknown mode fails the run, naming the set', async () => {
    const outcome = await failureOf(runCombined({ name: 'oops', mode: 'every', choices: [] }));

    expect(outcome.error.message).toMatch(/oops.*every/);
  });

  test('a combined set missing a group fails the run, naming the set and the group', async () => {
    const outcome = await failureOf(runCombined({ name: 'triage', mode: 'first_else_all', first: [] }));

    expect(outcome.error.message).toMatch(/triage.*"all"/);
  });
});

describe('agent matching', () => {
  test('first mode stops at the first match and skips later criteria and actions', async () => {
    const evaluated = [];
    const ran = [];
    const track = (label, result) => async () => {
      evaluated.push(label);
      return result;
    };

    await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: async (workingSet) => workingSet.log.length > 0,
      choiceProvider: async () => ({
        name: 'judge',
        mode: 'first',
        choices: [
          { name: 'a', criteria: track('a', { matched: false }), actions: [recordingAction(ran, 'a')] },
          { name: 'b', criteria: track('b', { matched: true }), actions: [recordingAction(ran, 'b')] },
          { name: 'c', criteria: track('c', { matched: true }), actions: [recordingAction(ran, 'c')] },
        ],
      }),
    });

    expect(evaluated).toEqual(['a', 'b']);
    expect(ran).toEqual(['b']);
  });

  test('all mode evaluates every criterion and runs matched actions in choice then action order', async () => {
    const ran = [];
    await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: async (workingSet) => workingSet.log.length > 0,
      choiceProvider: async () => ({
        name: 'gather',
        mode: 'all',
        choices: [
          { name: 'a', criteria: matches(), actions: [recordingAction(ran, 'a1'), recordingAction(ran, 'a2')] },
          { name: 'b', criteria: misses, actions: [recordingAction(ran, 'b1')] },
          { name: 'c', criteria: matches(), actions: [recordingAction(ran, 'c1')] },
        ],
      }),
    });

    expect(ran).toEqual(['a1', 'a2', 'c1']);
  });

  test('evaluates all criteria in a set before running any action', async () => {
    const events = [];
    await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: async (workingSet) => workingSet.log.length > 0,
      choiceProvider: async () => ({
        name: 'gather',
        mode: 'all',
        choices: ['a', 'b'].map((label) => ({
          name: label,
          criteria: async () => {
            events.push(`check ${label}`);
            return { matched: true };
          },
          actions: [async (workingSet) => {
            events.push(`run ${label}`);
            workingSet.log.push(label);
          }],
        })),
      }),
    });

    expect(events).toEqual(['check a', 'check b', 'run a', 'run b']);
  });

  test('passes async criterion data to the matched choice actions', async () => {
    const outcome = await runOnce({
      subject: {},
      initializer: initializeLog,
      finishChecker: async (workingSet) => workingSet.log.length > 0,
      choiceProvider: async () => ({
        name: 'lookup',
        mode: 'first',
        choices: [{
          name: 'found',
          criteria: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return { matched: true, data: { entryId: 'e-7' } };
          },
          actions: [recordingAction([], 'found')],
        }],
      }),
    });

    expect(outcome.workingSet.log).toEqual([{ label: 'found', data: { entryId: 'e-7' } }]);
  });
});

describe('agent errors (best effort: the run resolves as failed)', () => {
  const runWith = (config) => runOnce({ subject: {}, initializer: initializeLog, finishChecker: isDone, ...config });
  const finishing = { name: 'judge', mode: 'first', choices: [{ name: 'finish', criteria: matches(), actions: [finish] }] };
  const failingMessage = async (config) => (await failureOf(runWith(config))).error.message;

  test('a failing criterion fails the run, naming the choice', async () => {
    const choiceProvider = async () => ({
      name: 'judge',
      mode: 'first',
      choices: [{ name: 'lookup', criteria: async () => { throw new Error('search unavailable'); }, actions: [finish] }],
    });

    expect(await failingMessage({ choiceProvider })).toMatch(/judge.*lookup.*search unavailable/);
  });

  test('a failing action fails the run rather than reporting no_match, keeping the working set', async () => {
    const outcome = await failureOf(runWith({
      choiceProvider: async () => ({
        name: 'write',
        mode: 'first',
        choices: [{ name: 'create', criteria: matches(), actions: [async () => { throw new Error('store 503'); }] }],
      }),
    }));

    expect(outcome.error.message).toMatch(/write.*create.*store 503/);
    expect(outcome.workingSet.done).toBe(false);
  });

  test('a failing provider fails the run, naming the iteration', async () => {
    const choiceProvider = async () => { throw new Error('section when failed'); };

    expect(await failingMessage({ choiceProvider })).toMatch(/iteration 1 choiceProvider failed: section when failed/);
  });

  test('a failing finished check fails the run, saying so', async () => {
    const finishChecker = async () => { throw new Error('bad state'); };

    expect(await failingMessage({ finishChecker, choiceProvider: async () => finishing })).toMatch(/finishChecker failed: bad state/);
  });

  test('a provider that returns no choice set fails the run', async () => {
    expect(await failingMessage({ choiceProvider: async () => null })).toMatch(/iteration 1 choiceProvider returned no choice set/);
  });

  test('a criterion that returns a bare boolean fails the run instead of silently not matching', async () => {
    const choiceProvider = async () => ({ name: 'judge', mode: 'first', choices: [{ name: 'quick', criteria: async () => true, actions: [finish] }] });

    expect(await failingMessage({ choiceProvider })).toMatch(/judge\/quick criteria returned true, expected \{ matched \}/);
  });

  test('an unnamed set is labelled by its iteration in errors and the trace', async () => {
    const outcome = await runWith({ choiceProvider: async () => ({ mode: 'first', choices: finishing.choices }) });
    const message = await failingMessage({ choiceProvider: async () => ({ mode: 'first', choices: [{ name: 'x', criteria: async () => { throw new Error('no'); }, actions: [] }] }) });

    expect(outcome.trace[0].set).toBe('set 1');
    expect(message).toMatch(/^set 1\/x criteria failed: no/);
  });

  test('a failed run keeps the trace of the iterations before the error', async () => {
    let iteration = 0;
    const outcome = await failureOf(runWith({
      choiceProvider: async () => {
        iteration += 1;
        if (iteration === 1) return { name: 'gather', mode: 'all', choices: [{ name: 'a', criteria: matches(), actions: [async () => {}] }] };
        return { name: 'write', mode: 'first', choices: [{ name: 'create', criteria: matches(), actions: [async () => { throw new Error('store 503'); }] }] };
      },
    }));

    expect(outcome.trace).toMatchObject([{ iteration: 1, set: 'gather', fired: ['a'] }, { iteration: 2, set: 'write', failed: true }]);
  });

  test('a matched choice whose actions are not a list fails the run, naming the set and choice', async () => {
    const choiceProvider = async () => ({ name: 'judge', mode: 'first', choices: [{ name: 'x', criteria: matches(), actions: undefined }] });

    expect(await failingMessage({ choiceProvider })).toMatch(/judge\/x needs an array "actions"/);
  });

  test.each([
    [{ name: 'judge', mode: 'first', choices: [null] }, 'choice set "judge": choice 1 in "choices" is not a choice (null)'],
    [{ name: 'judge', mode: 'all', choices: [finishing.choices[0], 'finish'] }, 'choice set "judge": choice 2 in "choices" is not a choice ("finish")'],
    [{ name: 'triage', mode: 'first_else_all', first: [], all: [{ criteria: matches(), actions: [] }] }, 'choice set "triage": choice 1 in "all" needs a string "name"'],
    [{ name: 'judge', mode: 'first', choices: [{ name: 'lookup', criteria: 'yes', actions: [] }] }, 'choice set "judge": choice "lookup" needs a function "criteria"'],
  ])('a malformed choice fails the run, naming its set and place: %#', async (choiceSet, message) => {
    expect(await failingMessage({ choiceProvider: async () => choiceSet })).toBe(message);
  });

  test('a thrown non-Error is still readable in the message', async () => {
    const choiceProvider = async () => ({ name: 'judge', mode: 'first', choices: [{ name: 'x', criteria: async () => { throw 'quota'; }, actions: [] }] });

    expect(await failingMessage({ choiceProvider })).toMatch(/judge\/x criteria failed: quota/);
  });
});

test('a thrown value with no readable message still fails the run naming its source', async () => {
  const unreadable = Object.create(null);
  const outcome = await runOnce({
    subject: {},
    initializer: initializeLog,
    finishChecker: isDone,
    choiceProvider: async () => ({ name: 'judge', mode: 'first', choices: [{ name: 'x', criteria: async () => { throw unreadable; }, actions: [] }] }),
  });

  expect(outcome.status).toBe('failed');
  expect(outcome.error.message).toBe('judge/x criteria failed: [object Object]');
});
