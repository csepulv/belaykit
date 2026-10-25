// Macros: a rulebook calls a named expression from a macro file it imports, and the call is
// expanded when the rulebook loads, so every check applies to the expansion where it's called.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const answer = { type: 'object', properties: { answer: { enum: ['yes', 'no'] } }, additionalProperties: false };
const item = { type: 'object', properties: { name: { type: 'string' }, ok: { type: 'boolean' } }, additionalProperties: false };

const registry = () => ({
  producers: {},
  actions: {
    settle: {
      writes: ['routing', 'note'],
      params: { type: 'object', properties: { routing: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
      templates: ['note'],
      run: async (ws, { params }) => { ws.routing = params.routing; ws.note = params.note ?? null; },
    },
    pick: { writes: ['picked'], run: async (ws, { selected }) => { ws.picked = selected.item.name; } },
  },
  initialKeys: ['facts', 'rule', 'items', 'routing', 'note', 'picked'],
  shapes: {
    facts: { type: 'object', properties: { transition: answer, payload: answer, preExisting: answer }, additionalProperties: false },
    items: { type: 'array', items: item },
  },
});

const READY = 'ws.facts.transition.answer == "yes" && ws.facts.payload.answer == "yes" && (ws.rule != "exception" || ws.facts.preExisting.answer == "no")';

const COMMON = macroFile({
  noErrorAndReady: { body: READY, description: 'transition and payload confirmed, and no exception blocks it' },
  isAnswered: { params: ['p', 'value'], body: 'p.answer == value' },
});

const triage = (ready, confirmed) => `
version: 1
imports: [./common.macros.yaml]
outputs: [routing]
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - id: ready
        when: ${JSON.stringify(ready)}
        then: { action: settle, routing: go }
      - id: confirmed
        when: ${JSON.stringify(confirmed)}
        then: { action: settle, routing: check }
      - id: hold
        when: "true"
        then: { action: settle, routing: hold }
`;

const CASES = [
  { facts: { transition: { answer: 'yes' }, payload: { answer: 'yes' }, preExisting: { answer: 'no' } }, rule: 'exception' },
  { facts: { transition: { answer: 'yes' }, payload: { answer: 'yes' }, preExisting: { answer: 'yes' } }, rule: 'exception' },
  { facts: { transition: { answer: 'yes' }, payload: { answer: 'no' }, preExisting: { answer: 'yes' } }, rule: 'normal' },
  { facts: { transition: { answer: 'no' }, payload: { answer: 'no' }, preExisting: { answer: 'no' } }, rule: 'normal' },
];

const loadIn = (folder, text) => Rulebook.fromText(text, registry(), { baseDir: folder });

const problemsIn = (folder, text) => Rulebook.check(text, registry(), { baseDir: folder });

describe('same decisions, one definition', () => {
  const folder = folderWith({ 'common.macros.yaml': COMMON });
  const pasted = () => loadIn(folder, triage(READY, 'ws.facts.transition.answer == "yes"'));
  const withMacros = () => loadIn(folder, triage('noErrorAndReady()', 'isAnswered(ws.facts.transition, "yes")'));

  test('decide gives the same outputs on every case', async () => {
    const decisions = async (rules) => Promise.all(CASES.map(async (initial) => (await rules.decide(initial)).outputs));

    expect(await decisions(withMacros())).toEqual([{ routing: 'go' }, { routing: 'check' }, { routing: 'check' }, { routing: 'hold' }]);
    expect(await decisions(withMacros())).toEqual(await decisions(pasted()));
  });

  test('runFixture and the provider fire the same rules', async () => {
    const fired = async (rules, initial) => {
      const fixture = { initial, expect: { status: 'completed' } };
      const run = await rules.runFixture({ fixture, finishChecker: (ws) => ws.routing !== undefined });
      const agent = new Agent({ initializer: (subject) => rules.initialize(subject), choiceProvider: rules.provider(), finishChecker: (ws) => ws.routing !== undefined });
      const outcome = await agent.run(initial);
      return [run.status, run.fired, outcome.trace.flatMap((entry) => entry.executed)];
    };

    for (const initial of CASES) expect(await fired(withMacros(), initial)).toEqual(await fired(pasted(), initial));
  });

  test('grouping parentheses in a body and in arguments, and commas in strings, are kept', async () => {
    const files = folderWith({
      'common.macros.yaml': macroFile({
        isEither: { params: ['p', 'value'], body: '(p.answer == value) || (p.answer == "yes")' },
        isNot: { params: ['p'], body: '!(p)' },
      }),
    });
    const rules = loadIn(files, triage('isEither((ws.facts.transition), ("no")) && isNot((ws.rule == "a,b"))', 'false'));

    expect((await rules.decide(CASES[0])).outputs).toEqual({ routing: 'go' });
    expect((await rules.decide(CASES[3])).outputs).toEqual({ routing: 'go' });
    expect((await rules.decide({ ...CASES[3], rule: 'a,b' })).outputs).toEqual({ routing: 'hold' });
  });

  test('sections show each call as written', () => {
    expect(withMacros().sections[0].rules.map((rule) => rule.when)).toEqual(['noErrorAndReady()', 'isAnswered(ws.facts.transition, "yes")', 'true']);
  });

  test('a rulebook calls the macros of the files it imports itself; their bodies call those of the files they import', async () => {
    const files = folderWith({
      'common.macros.yaml': macroFile({ noErrorAndReady: 'isConfirmed(ws.facts.transition) && isConfirmed(ws.facts.payload)' }, ['./base.macros.yaml']),
      'base.macros.yaml': macroFile({ isConfirmed: { params: ['p'], body: 'p.answer == "yes"' } }),
    });

    expect((await loadIn(files, triage('noErrorAndReady()', 'false')).decide(CASES[2])).outputs).toEqual({ routing: 'hold' });
    expect((await loadIn(files, triage('noErrorAndReady()', 'false')).decide(CASES[1])).outputs).toEqual({ routing: 'go' });
    expect(problemsIn(files, triage('isConfirmed(ws.facts.transition)', 'false'))).toEqual([
      'section "decide" rule 1 (ready) when: unknown function "isConfirmed"',
    ]);
  });

  test('a rulebook loaded from a file expands its macros too', async () => {
    const files = folderWith({ 'common.macros.yaml': COMMON, 'triage.rules.yaml': triage('noErrorAndReady()', 'false') });

    expect((await Rulebook.load(join(files, 'triage.rules.yaml'), registry()).decide(CASES[0])).outputs).toEqual({ routing: 'go' });
  });
});

describe('a typo is caught once, in the right place', () => {
  test('a field misspelled in a body alone is reported once, on the macro', () => {
    const folder = folderWith({ 'common.macros.yaml': macroFile({ isReady: 'ws.facts.transtion.answer == "yes"' }) });

    const text = triage('isReady()', 'isReady() && ws.rule == "x"').replace('when: \'!has(ws.routing)\'', 'when: \'!has(ws.routing) && isReady()\'');

    expect(problemsIn(folder, text)).toEqual([
      'macro "isReady" (common.macros.yaml): unknown field "transtion" on ws.facts',
    ]);
  });

  test('a field misspelled through a parameter is reported at each call, naming the macro', () => {
    const folder = folderWith({ 'common.macros.yaml': macroFile({ isAnswered: { params: ['p'], body: 'p.answr == "yes"' } }) });

    expect(problemsIn(folder, triage('isAnswered(ws.facts.transition)', 'isAnswered(ws.facts.payload)'))).toEqual([
      'section "decide" rule 1 (ready) when, in macro "isAnswered": unknown field "answr" on ws.facts.transition',
      'section "decide" rule 2 (confirmed) when, in macro "isAnswered": unknown field "answr" on ws.facts.payload',
    ]);
  });

  test('a misspelled argument is reported at the call, as the rule\'s own', () => {
    const folder = folderWith({ 'common.macros.yaml': COMMON });

    expect(problemsIn(folder, triage('isAnswered(ws.facts.transtion, "yes")', 'false'))).toEqual([
      'section "decide" rule 1 (ready) when: unknown field "transtion" on ws.facts',
    ]);
  });

  test('with two macros in one expression, a problem names the macro it comes through', () => {
    const folder = folderWith({ 'common.macros.yaml': COMMON });

    expect(problemsIn(folder, triage('noErrorAndReady() && isAnswered(ws.facts.payload, "yse")', 'false'))).toEqual([
      'section "decide" rule 1 (ready) when, in macro "isAnswered": ws.facts.payload.answer is compared with "yse", which its shape doesn\'t allow (yes, no)',
    ]);
  });

  test('a literal outside a field\'s enum, through a parameter, is reported at the call', () => {
    const folder = folderWith({ 'common.macros.yaml': COMMON });

    expect(problemsIn(folder, triage('isAnswered(ws.facts.transition, "yse")', 'false'))).toEqual([
      expect.stringMatching(/^section "decide" rule 1 \(ready\) when, in macro "isAnswered": .*"yse"/),
    ]);
  });
});

describe('macros work wherever a rulebook has CEL', () => {
  const MACROS = macroFile({
    hasFacts: 'has(ws.facts)',
    okItems: 'ws.items.filter(i, i.ok)',
    labelOf: { params: ['entry'], body: '"item " + entry.name' },
    isNamed: { params: ['entry', 'name'], body: 'entry.name == name' },
  });
  const rulebook = (when = 'isNamed(item, "b")') => `
version: 1
imports: [./macros.yaml]
sections:
  - name: pick
    when: "hasFacts() && !has(ws.picked)"
    exhaustive: false
    rules:
      - selectFirst: { item: okItems() }
        when: ${JSON.stringify(when)}
        then: { action: settle, routing: picked, note: "{labelOf(item)}" }
`;

  test('a section when, a selectFirst list, a rule when with the binding as argument, and a placeholder expand and run', async () => {
    const folder = folderWith({ 'macros.yaml': MACROS });
    const rules = loadIn(folder, rulebook());
    const items = [{ name: 'a', ok: true }, { name: 'b', ok: false }, { name: 'b', ok: true }];
    const fixture = { initial: { facts: {}, items }, expect: { status: 'completed' } };

    const run = await rules.runFixture({ fixture, finishChecker: (ws) => ws.routing === 'picked' });

    expect(run.status).toBe('completed');
    expect(run.result).toMatchObject({ routing: 'picked', note: 'item b' });
    expect(rules.sections[0].rules[0]).toMatchObject({ selectFirst: { name: 'item', expression: 'okItems()' }, when: 'isNamed(item, "b")', params: { note: '{labelOf(item)}' } });
  });

  test('a field misspelled through a selectFirst binding is refused by its shape', () => {
    const folder = folderWith({ 'macros.yaml': macroFile({ isNamed: { params: ['entry', 'name'], body: 'entry.nmae == name' } }) });
    const text = rulebook().replace('{ item: okItems() }', '{ item: ws.items }').replace('note: "{labelOf(item)}"', 'note: x').replace('hasFacts() && ', '');

    expect(problemsIn(folder, text)).toEqual([
      'section "pick" rule 1 when, in macro "isNamed": unknown field "nmae" on item (an item of ws.items)',
    ]);
  });

  test('an action\'s guard can\'t call a macro', () => {
    const folder = folderWith({ 'macros.yaml': MACROS });
    const guarded = { ...registry(), actions: { ...registry().actions, settle: { ...registry().actions.settle, guard: 'hasFacts()' } } };

    expect(Rulebook.check(rulebook(), guarded, { baseDir: folder })).toEqual(['action "settle" guard: unknown function "hasFacts"']);
  });

  test('a FIRST section whose last rule calls a macro that is literally true has its catch-all', () => {
    const folder = folderWith({ 'macros.yaml': macroFile({ always: 'true' }) });
    const text = triage('false', 'false').replace('imports: [./common.macros.yaml]', 'imports: [./macros.yaml]').replace('when: "true"', 'when: always()');

    expect(problemsIn(folder, text)).toEqual([]);
  });
});
