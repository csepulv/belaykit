// BelayKit's own CEL helpers, in the `belaykit` namespace. `belaykit.present(container, "a.b")`
// says whether a value is there: every key on the path exists and the last value isn't null.
// It reads the path itself, so a missing key or a null on the way is `false`, not `No such key`.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = (initialKeys) => ({
  producers: {},
  actions: { mark: { writes: ['marked'], run: async (ws) => { ws.marked = true; } } },
  initialKeys: [...initialKeys, 'marked'],
});

const ruleText = (when, selectFirst) => `
version: 1
sections:
  - name: check
    when: "true"
    exhaustive: false
    rules:
      - id: probe
${selectFirst ? `        selectFirst: ${selectFirst}\n` : ''}        when: ${JSON.stringify(when)}
        then: { action: mark }
`;

// Whether the rule's `when` holds for this working set; rejects with the evaluation's error.
async function holds(when, ws, { selectFirst } = {}) {
  const rules = Rulebook.fromText(ruleText(when, selectFirst), registry(Object.keys(ws)));
  const workingSet = rules.initialize(ws);
  const choiceSet = await rules.provider()(workingSet);
  const { matched } = await choiceSet.choices[0].criteria(workingSet);
  return matched;
}

describe('belaykit.present on ws', () => {
  const ws = { facts: { recurrence: { answer: 'yes', note: null, later: undefined }, count: 3, tags: ['a'], label: 'x' } };

  test.each([
    ['a key that is there', 'facts', true],
    ['a nested value that is there', 'facts.recurrence.answer', true],
    ['an object that is there', 'facts.recurrence', true],
    ['a missing key', 'facts.missing', false],
    ['a missing key on the way', 'facts.missing.answer', false],
    ['a key holding null', 'facts.recurrence.note', false],
    ['a key holding undefined', 'facts.recurrence.later', false],
    ['a step past a null', 'facts.recurrence.note.inner', false],
    ['a key only Object.prototype has', 'facts.toString', false],
  ])('%s: %s is %s', async (_label, path, expected) => {
    expect(await holds(`belaykit.present(ws, "${path}")`, ws)).toBe(expected);
  });

  test.each([
    ['a string', 'facts.label.inner', '"label" is a string, not a map'],
    ['a list', 'facts.tags.inner', '"tags" is a list, not a map'],
    ['a number', 'facts.count.inner', '"count" is a number, not a map'],
  ])('a step into %s is an error naming the step', async (_label, path, problem) => {
    await expect(holds(`belaykit.present(ws, "${path}")`, ws)).rejects.toThrow(`belaykit.present "${path}": ${problem}`);
  });

  test('a null container is false, like a null on the path', async () => {
    expect(await holds('belaykit.present(ws.facts.recurrence.note, "inner")', ws)).toBe(false);
  });

  test('a CEL map literal is a container', async () => {
    expect(await holds('belaykit.present({"a": {"b": 1}}, "a.b")', ws)).toBe(true);
  });

  test('a container that isn\'t a map is an error', async () => {
    await expect(holds('belaykit.present(ws.facts.label, "inner")', ws)).rejects.toThrow('belaykit.present "inner": the container is a string, not a map');
  });
});

// A Map an action writes is a CEL map too; any other object (a Date, a Set) isn't one.
describe('belaykit.present on values an agent writes', () => {
  test('a Map is a map: its keys are read', async () => {
    const ws = { seen: new Map([['answer', 'yes'], ['note', null]]) };
    expect(await holds('belaykit.present(ws, "seen.answer")', ws)).toBe(true);
    expect(await holds('has(ws.seen.answer) && belaykit.present(ws, "seen.answer")', ws)).toBe(true);
    expect(await holds('belaykit.present(ws, "seen.missing")', ws)).toBe(false);
    expect(await holds('belaykit.present(ws, "seen.note")', ws)).toBe(false);
  });

  test.each([
    ['a Date', { at: new Date('2026-10-21T00:00:00Z') }, 'at.x', '"at" is a Date, not a map'],
    ['a Set', { tags: new Set(['a']) }, 'tags.x', '"tags" is a Set, not a map'],
  ])('a step into %s is an error', async (_label, ws, path, problem) => {
    await expect(holds(`belaykit.present(ws, "${path}")`, ws)).rejects.toThrow(`belaykit.present "${path}": ${problem}`);
  });
});

describe('belaykit.present on a binding and a CEL macro variable', () => {
  const ws = { items: [{ meta: null }, { meta: { tag: 'x' } }] };

  test('a selectFirst binding is a container', async () => {
    expect(await holds('belaykit.present(item, "meta.tag")', ws, { selectFirst: '{ item: ws.items }' })).toBe(true);
  });

  test('a CEL macro variable is a container', async () => {
    expect(await holds('ws.items.exists(i, belaykit.present(i, "meta.tag"))', ws)).toBe(true);
    expect(await holds('ws.items.all(i, belaykit.present(i, "meta.tag"))', ws)).toBe(false);
  });
});

// `belaykit` belongs to the helpers, so every way a rulebook or a registry could take the name is
// refused at load, with a message that says so; a misspelled helper is named as one.
describe('the name belaykit is reserved for the helpers', () => {
  const place = 'section "check" rule 1 (probe)';
  const problemsOf = (when, { selectFirst, functions } = {}) => Rulebook.check(ruleText(when, selectFirst), { ...registry(['items']), functions });

  test('as a selectFirst binding', () => {
    expect(problemsOf('true', { selectFirst: '{ belaykit: ws.items }' }))
      .toEqual([`${place} selectFirst: binding "belaykit" is reserved for BelayKit's helpers`]);
  });

  test('as a CEL macro variable', () => {
    expect(problemsOf('ws.items.exists(belaykit, belaykit == 1)'))
      .toEqual([`${place} when: CEL macro variable "belaykit" is reserved for BelayKit's helpers`]);
  });

  // cel-js has cel.bind(var, value, expr), a macro with a variable of its own.
  test('as the variable of cel.bind', () => {
    expect(problemsOf('cel.bind(belaykit, 1, belaykit == 1)'))
      .toEqual([`${place} when: CEL macro variable "belaykit" is reserved for BelayKit's helpers`]);
  });

  // The reserved name is the cause, so it's reported even when the check fails for it.
  test('as a CEL macro variable, in a rule that also fails cel-js\'s check', () => {
    expect(problemsOf('ws.items.exists(belaykit, belaykit.foo(1))')).toContain(`${place} when: CEL macro variable "belaykit" is reserved for BelayKit's helpers`);
  });

  // A method on dyn named like a helper would also apply to the helpers' type.
  test('a registered method on dyn named like a helper is refused in BelayKit\'s words', () => {
    expect(problemsOf('true', { functions: [{ signature: 'dyn.present(dyn, string): bool', handler: () => true }] }))
      .toEqual(['function "dyn.present": a method on dyn named "present" would also apply to belaykit.present; rename it']);
  });

  test('as a registered function\'s name', () => {
    expect(problemsOf('true', { functions: [{ signature: 'belaykit(dyn): bool', handler: () => true }] }))
      .toEqual(['function "belaykit": the name is reserved for BelayKit\'s helpers']);
  });

  test('as the receiver of a registered method, so a registry can\'t add to the helpers', () => {
    expect(problemsOf('true', { functions: [{ signature: 'BelayKit.extra(dyn): bool', handler: () => true }] }))
      .toEqual(['function "BelayKit.extra": BelayKit is the type of BelayKit\'s helpers; a registry can\'t add to it']);
  });

  test('a misspelled helper is an unknown function, named with its namespace', () => {
    expect(problemsOf('belaykit.presnt(ws, "items")')).toEqual([`${place} when: unknown function "belaykit.presnt"`]);
  });

  test('a helper called without its namespace is an unknown function', () => {
    expect(problemsOf('present(ws, "items")')).toEqual([`${place} when: unknown function "present"`]);
  });

  test('a registered function that only starts with the name loads', () => {
    expect(problemsOf('belaykit_like(ws)', { functions: [{ signature: 'belaykit_like(dyn): bool', handler: () => true }] })).toEqual([]);
  });
});

// A path is checked when the rulebook loads, like the field access it stands for, so it must be a
// string literal (as a `matches` pattern must).
describe('belaykit.present\'s path is checked at load', () => {
  const place = 'section "check" rule 1 (probe)';
  const shapedRegistry = {
    ...registry(['facts', 'items', 'p']),
    shapes: {
      facts: {
        type: 'object',
        properties: {
          recurrence: { anyOf: [{ type: 'null' }, { type: 'object', properties: { answer: { type: 'string' } }, additionalProperties: false }] },
          label: { type: 'string' },
          open: { type: 'object' },
        },
        additionalProperties: false,
      },
      items: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' } }, additionalProperties: false } },
    },
  };
  const problemsOf = (when, { selectFirst } = {}) => Rulebook.check(ruleText(when, selectFirst), shapedRegistry);

  test.each([
    ['a field', 'ws.p'],
    ['a concatenation', '"fa" + "cts"'],
    ['a number', '1'],
    ['null', 'null'],
  ])('a path that is %s is refused, in BelayKit\'s words alone', (_label, path) => {
    expect(problemsOf(`belaykit.present(ws, ${path})`)).toEqual([`${place} when: belaykit.present: path must be a string literal`]);
  });

  // A path problem never hides another call's problem, such as a wrong number of arguments.
  test.each([
    ['a reserved CEL macro variable', 'ws.items.exists(belaykit, true)', 'CEL macro variable "belaykit" is reserved for BelayKit\'s helpers'],
    ['an empty path', 'belaykit.present(ws, "")', 'belaykit.present "": a path is keys joined by dots, such as "facts.recurrence"'],
    ['a number as the path', 'belaykit.present(ws, 1)', 'belaykit.present: path must be a string literal'],
  ])('%s beside a call with too few arguments: both are reported', (_label, first, problem) => {
    expect(problemsOf(`${first} && belaykit.present(ws)`))
      .toEqual([`${place} when: ${problem}`, `${place} when: found no matching overload for 'BelayKit.present(map<dyn, dyn>)'`]);
  });

  test.each([['an empty path', ''], ['an empty segment', 'facts..answer']])('%s is refused', (_label, path) => {
    expect(problemsOf(`belaykit.present(ws, "${path}")`))
      .toEqual([`${place} when: belaykit.present "${path}": a path is keys joined by dots, such as "facts.recurrence"`]);
  });

  test.each([
    ['from ws', 'belaykit.present(ws, "facts.recurence")', {}, 'belaykit.present "facts.recurence": unknown field "recurence" on ws.facts'],
    ['from ws.<key>', 'belaykit.present(ws.facts, "recurrence.anser")', {}, 'belaykit.present "recurrence.anser": unknown field "anser" on ws.facts.recurrence'],
    ['from a selectFirst binding', 'belaykit.present(item, "tg")', { selectFirst: '{ item: ws.items }' }, 'belaykit.present "tg": unknown field "tg" on item (an item of ws.items)'],
    ['from a CEL macro variable', 'ws.items.exists(i, belaykit.present(i, "tg"))', {}, 'belaykit.present "tg": unknown field "tg" on i (an item of ws.items)'],
    ['an unknown first key', 'belaykit.present(ws, "fact.recurrence")', {}, 'belaykit.present "fact.recurrence": unknown ws field "fact"'],
    ['a step through a string', 'belaykit.present(ws, "facts.label.x")', {}, 'belaykit.present "facts.label.x": unknown field "x" on ws.facts.label'],
    ['a step through a list', 'belaykit.present(ws, "items.tag")', {}, 'belaykit.present "items.tag": unknown field "tag" on ws.items (a list)'],
  ])('a misspelled path %s is refused, naming the helper\'s path and the field', (_label, when, options, problem) => {
    expect(problemsOf(when, options)).toEqual([`${place} when: ${problem}`]);
  });

  test.each([
    ['spelled correctly, through a nullable field', 'belaykit.present(ws, "facts.recurrence.answer")', {}],
    ['spelled correctly, from a binding', 'belaykit.present(item, "tag")', { selectFirst: '{ item: ws.items }' }],
    ['into an open shape', 'belaykit.present(ws, "facts.open.anything.at.all")', {}],
    ['under a key without a shape', 'belaykit.present(ws, "p.anything")', {}],
    ['in a map literal', 'belaykit.present({"a": 1}, "b.c")', {}],
  ])('a path %s loads', (_label, when, options) => {
    expect(problemsOf(when, options)).toEqual([]);
  });
});

// A rule guarded this way runs on every case and fires only where the fact is there.
describe('a rule guarded by belaykit.present', () => {
  const guarded = 'belaykit.present(ws, "facts.recurrence") && ws.facts.recurrence.answer == "yes"';
  const rulebookFor = (when) => Rulebook.fromText(`
version: 1
sections:
  - name: decide
    when: ws.marked == null
    exhaustive: false
    rules:
      - id: recurring
        when: ${JSON.stringify(when)}
        then: { action: mark }
`, registry(['facts']));
  const run = (when, facts) => rulebookFor(when).runFixture({
    fixture: { initial: { facts, marked: null }, expect: { status: 'completed' } },
    finishChecker: (ws) => ws.marked === true,
  });

  test.each([
    ['recurrence missing', {}],
    ['recurrence null', { recurrence: null }],
  ])('with %s, the run ends without the rule firing and without failing', async (_label, facts) => {
    const outcome = await run(guarded, facts);
    expect(outcome.status).toBe('no_match');
    expect(outcome.trace.flatMap((entry) => entry.fired)).toEqual([]);
  });

  test('with recurrence there, the rule fires', async () => {
    const outcome = await run(guarded, { recurrence: { answer: 'yes' } });
    expect(outcome.status).toBe('completed');
    expect(outcome.trace.flatMap((entry) => entry.fired)).toEqual(['recurring']);
  });

  test('written with has(), the same rule fails the run on the null case (the oddity present answers)', async () => {
    const outcome = await run('has(ws.facts.recurrence) && ws.facts.recurrence.answer == "yes"', { recurrence: null });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/No such key: answer/);
  });
});
