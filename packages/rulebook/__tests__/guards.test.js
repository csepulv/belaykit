// Since 0.2: an action may declare a guard, a CEL expression on `ws` that the provider checks
// before each rule naming the action. A rulebook can reorder or narrow when an action runs, never
// run it while its guard is false.
import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

const settle = (routing) => async (ws) => { ws.routing = routing; };

const makeRegistry = ({ guard = 'ws.retries < ws.limits.max', ...rest } = {}) => ({
  producers: {},
  actions: {
    escalate: { writes: ['routing'], guard, run: settle('escalate') },
    hold: { writes: ['routing'], run: settle('hold') },
  },
  initialKeys: ['retries', 'limits', 'items', 'routing', 'state'],
  shapes: { state: { enum: ['open', 'closed'] } },
  ...rest,
});

const registry = makeRegistry();

const TRIAGE = `
version: 1
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - id: escalate_now
        when: "true"
        then: { action: escalate }
      - id: fallback
        when: "true"
        then: { action: hold }
`;

describe('a guard at load', () => {
  test('a guarded action loads, and a guard is a known action key', () => {
    expect(Rulebook.check(TRIAGE, registry)).toEqual([]);
  });

  test.each([
    ['reads a field nothing declares', 'ws.retry < 3', 'action "escalate" guard: unknown ws field "retry"'],
    ['compares an enum field with a value its shape doesn\'t allow', 'ws.state == "opne"', 'action "escalate" guard: ws.state is compared with "opne", which its shape doesn\'t allow (open, closed)'],
    ['has a known type that isn\'t bool', 'ws.retries + 1', null],
    ['doesn\'t compile', 'ws.retries <', null],
  ])('a guard that %s is a problem, reported once though three rules name the action', (_label, guard, message) => {
    const text = TRIAGE.replace('      - id: fallback', '      - id: again\n        when: "true"\n        then: { action: escalate }\n      - id: and_again\n        when: ws.retries > 0\n        then: { action: escalate }\n      - id: fallback');
    const problems = Rulebook.check(text, makeRegistry({ guard }));
    expect(problems).toHaveLength(1);
    if (message) expect(problems[0]).toBe(message);
    else expect(problems[0]).toMatch(/^action "escalate" guard: /);
  });

  test('a guard problem and a rule\'s own problem are both reported', () => {
    const text = TRIAGE.replace('when: "true"\n        then: { action: escalate }', 'when: ws.missing == 1\n        then: { action: escalate }');
    expect(Rulebook.check(text, makeRegistry({ guard: 'ws.retry < 3' }))).toEqual([
      'section "decide" rule 1 (escalate_now) when: unknown ws field "missing"',
      'action "escalate" guard: unknown ws field "retry"',
    ]);
  });

  test('a guard that isn\'t a string is a registry problem', () => {
    expect(Rulebook.check(TRIAGE, makeRegistry({ guard: true }))).toEqual(['action "escalate": guard must be a CEL expression (a string)']);
  });

  // The guard is read once, so what the load checks is what the run uses.
  test('a guard read through a getter is read once: the check and the run see the same guard', async () => {
    let reads = 0;
    const shifting = { writes: ['routing'], run: settle('escalate') };
    Object.defineProperty(shifting, 'guard', { get: () => (reads++ === 0 ? undefined : 'false') });
    const reg = { ...registry, actions: { escalate: shifting } };
    const text = TRIAGE.replace('      - id: fallback\n        when: "true"\n        then: { action: hold }\n', '');
    expect(Rulebook.check(text, reg)).toEqual([]);
    reads = 0;
    const outcome = await run(text, REFUSED, reg);
    expect(outcome.workingSet.routing).toBe('escalate');
  });

  test('a guard read through a class\'s getter is checked at load', () => {
    class Escalate {
      writes = ['routing'];
      get guard() { return 'ws.nothing == 1'; }
      async run() {}
    }
    expect(Rulebook.check(TRIAGE, { ...registry, actions: { ...registry.actions, escalate: new Escalate() } }))
      .toEqual(['action "escalate" guard: unknown ws field "nothing"']);
  });

  test('an action no rule names isn\'t checked: what ws holds depends on the rulebook', () => {
    const unused = { ...registry, actions: { ...registry.actions, archive: { writes: [], guard: 'ws.archived == true', run: async () => {} } } };
    expect(Rulebook.check(TRIAGE, unused)).toEqual([]);
  });
});

const run = (text, subject, reg = registry) => {
  const rules = Rulebook.fromText(text, reg);
  return new Agent({
    initializer: (initial) => rules.initialize(initial),
    choiceProvider: rules.provider(),
    finishChecker: (ws) => Object.hasOwn(ws, 'routing'),
  }).run(subject);
};

const evaluated = (outcome) => outcome.trace.flatMap((entry) => entry.evaluated);
const ALLOWED = { retries: 0, limits: { max: 3 } };
const REFUSED = { retries: 3, limits: { max: 3 } };

describe('a guard at run time', () => {
  test('a false guard is a no match, recorded as detail { guard: false }; the next rule decides', async () => {
    const outcome = await run(TRIAGE, REFUSED);
    expect(outcome.status).toBe('completed');
    expect(outcome.workingSet.routing).toBe('hold');
    expect(evaluated(outcome)).toEqual([
      { choice: 'escalate_now', matched: false, detail: { guard: false } },
      { choice: 'fallback', matched: true },
    ]);
  });

  test('a true guard changes nothing', async () => {
    const outcome = await run(TRIAGE, ALLOWED);
    expect(outcome.workingSet.routing).toBe('escalate');
    expect(evaluated(outcome)).toEqual([{ choice: 'escalate_now', matched: true }]);
  });

  test.each([
    ['a when', '      - id: escalate_now\n        when: ws.state == "open"\n'],
    ['a selection', '      - id: escalate_now\n        selectFirst: { item: ws.items }\n        when: item == "x"\n'],
  ])('a false guard means %s that would fail (ws.state, ws.items absent) is never evaluated', async (_label, rule) => {
    const text = TRIAGE.replace('      - id: escalate_now\n        when: "true"\n', rule);
    const outcome = await run(text, REFUSED);
    expect(outcome.status).toBe('completed');
    expect(outcome.workingSet.routing).toBe('hold');
    expect(evaluated(outcome)[0]).toEqual({ choice: 'escalate_now', matched: false, detail: { guard: false } });
  });

  test('in an ALL section, a guarded rule doesn\'t fire and the others do', async () => {
    const text = TRIAGE.replace("    when: '!has(ws.routing)'\n", "    when: '!has(ws.routing)'\n    hitPolicy: ALL\n");
    const outcome = await run(text, REFUSED);
    expect(outcome.trace[0].fired).toEqual(['fallback']);
  });

  test.each([
    ['throws', { retries: 0 }, /^decide\/escalate_now criteria failed: action "escalate" guard: .*limits/],
    ['isn\'t a boolean', { retries: 0, limits: { max: 3 } }, 'decide/escalate_now criteria failed: action "escalate" guard: evaluated to double, expected a boolean'],
  ])('a guard that %s fails the run, naming the rule and the action\'s guard', async (_label, subject, message) => {
    const reg = _label === 'throws' ? registry : makeRegistry({ guard: 'ws.retries' });
    const outcome = await run(TRIAGE, subject, reg);
    expect(outcome.status).toBe('failed');
    if (typeof message === 'string') expect(outcome.error.message).toBe(message);
    else expect(outcome.error.message).toMatch(message);
  });

  test('a guard read through a class\'s getter is the guard the run uses', async () => {
    class Escalate {
      writes = ['routing'];
      get guard() { return 'ws.retries < ws.limits.max'; }
      async run(ws) { ws.routing = 'escalate'; }
    }
    const reg = { ...registry, actions: { ...registry.actions, escalate: new Escalate() } };
    const outcome = await run(TRIAGE, REFUSED, reg);
    expect(outcome.workingSet.routing).toBe('hold');
  });

  // In an ALL section every rule is selected before any action runs, so the guard is
  // checked again just before its action runs; one that no longer holds fails the run, never runs the action.
  describe('a guard that stops holding before its action runs, in an ALL section', () => {
    const once = (ws) => { ws.escalations += 1; ws.routing = 'escalate'; };
    const counting = {
      producers: {},
      actions: {
        escalate: { writes: ['escalations', 'routing'], guard: 'ws.escalations < 1', run: async (ws) => once(ws) },
        spend: { writes: ['escalations'], run: async (ws) => { ws.escalations += 1; } },
      },
      initialKeys: ['escalations', 'routing'],
    };
    const allOf = (rules) => `
version: 1
sections:
  - name: decide
    when: '!has(ws.routing)'
    hitPolicy: ALL
    rules:
${rules}`;

    test.each([
      ['two rules name the guarded action', '      - id: urgent\n        when: "true"\n        then: { action: escalate }\n      - id: vip\n        when: "true"\n        then: { action: escalate }\n', 'decide/vip'],
      ['an earlier action makes the guard false', '      - id: spend_one\n        when: "true"\n        then: { action: spend }\n      - id: vip\n        when: "true"\n        then: { action: escalate }\n', 'decide/vip'],
    ])('when %s, the run fails before the action runs again', async (_label, rules, place) => {
      const outcome = await run(allOf(rules), { escalations: 0 }, counting);
      expect(outcome.status).toBe('failed');
      expect(outcome.error.message).toBe(`${place} action failed: action "escalate" guard no longer holds; an earlier action in this iteration changed ws`);
      expect(outcome.workingSet.escalations).toBe(1);
    });
  });

  // True, throwing and non-boolean guards on every path, not only a plain FIRST rule.
  const SELECT = TRIAGE.replace('      - id: escalate_now\n        when: "true"\n', '      - id: escalate_now\n        selectFirst: { item: ws.items }\n        when: item == "x"\n');
  const ALL = TRIAGE.replace("    when: '!has(ws.routing)'\n", "    when: '!has(ws.routing)'\n    hitPolicy: ALL\n");
  test.each([
    ['a selectFirst rule', SELECT, { ...ALLOWED, items: ['y', 'x'] }],
    ['an ALL section', ALL, ALLOWED],
  ])('a true guard on %s changes nothing', async (_label, text, subject) => {
    const outcome = await run(text, subject);
    expect(outcome.trace[0].fired[0]).toBe('escalate_now');
  });

  test.each([
    ['a selectFirst rule', SELECT, registry, { retries: 0, items: ['x'] }, /^decide\/escalate_now criteria failed: action "escalate" guard: No such key: limits$/],
    ['an ALL section', ALL, makeRegistry({ guard: 'ws.retries' }), ALLOWED, /^decide\/escalate_now criteria failed: action "escalate" guard: evaluated to double, expected a boolean$/],
  ])('a failing guard on %s fails the run, naming the rule and the guard', async (_label, text, reg, subject, message) => {
    const outcome = await run(text, subject, reg);
    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(message);
  });

  test('through decide, a guard that fails resolves failed, and a true one completes', async () => {
    const rules = Rulebook.fromText(TRIAGE.replace('version: 1\n', 'version: 1\noutputs: [routing]\n'), registry);
    expect(await rules.decide({ retries: 0 })).toMatchObject({ status: 'failed', error: expect.stringMatching(/action "escalate" guard: No such key: limits/) });
    expect((await rules.decide(ALLOWED)).outputs).toEqual({ routing: 'escalate' });
  });

  test('the guard holds through runFixture and decide too', async () => {
    const withOutputs = TRIAGE.replace('version: 1\n', 'version: 1\noutputs: [routing]\n');
    const rules = Rulebook.fromText(withOutputs, registry);
    const fixtureRun = await rules.runFixture({
      fixture: { initial: REFUSED, expect: { status: 'completed', fired: ['fallback'] } },
      finishChecker: (ws) => Object.hasOwn(ws, 'routing'),
    });
    expect(fixtureRun.mismatches).toEqual([]);
    const decision = await rules.decide(REFUSED);
    expect(decision.outputs).toEqual({ routing: 'hold' });
  });
});
