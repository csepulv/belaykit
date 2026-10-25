// What a macro file can contain without crashing the loader or multiplying its problems:
// comments, oversized expansions, params used where a literal is required, refused names,
// and imports that fail.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const answer = { type: 'object', properties: { answer: { enum: ['yes', 'no'] } }, additionalProperties: false };

const registry = () => ({
  producers: {},
  actions: { settle: { writes: ['routing'], run: async (ws) => { ws.routing = 'done'; } } },
  functions: [{ signature: 'app_state(map, string): string', handler: (container, key) => (key in container ? 'present' : 'absent'), keyArgs: { key: 1, in: 0 } }],
  initialKeys: ['facts', 'rule', 'routing'],
  shapes: { facts: { type: 'object', properties: { transition: answer }, additionalProperties: false } },
});

const rulebook = (...whens) => `
version: 1
imports: [./m.yaml]
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
${whens.map((when) => `      - when: ${JSON.stringify(when)}\n        then: { action: settle }`).join('\n')}
      - when: "true"
        then: { action: settle }
`;

const check = (files, text) => Rulebook.check(text, registry(), { baseDir: folderWith(files) });
const problemsWith = (macros, ...whens) => check({ 'm.yaml': macroFile(macros) }, rulebook(...whens));

describe('comments', () => {
  test('a body ending in a comment expands, called directly or from another macro', async () => {
    const macros = { isX: 'ws.rule == "x" // a note', both: { params: ['p'], body: 'isX() && p' } };

    expect(problemsWith(macros, 'isX()', 'both(true)')).toEqual([]);
    const rules = Rulebook.fromText(rulebook('both(ws.rule != "")'), registry(), { baseDir: folderWith({ 'm.yaml': macroFile(macros) }) });
    const fixture = { initial: { rule: 'x' }, expect: { status: 'completed', fired: ['decide#1'] } };
    expect((await rules.runFixture({ fixture, finishChecker: (ws) => ws.routing === 'done' })).mismatches).toEqual([]);
  });

  test('a comma or parenthesis in a comment between arguments is not a separator', () => {
    expect(problemsWith({ both: { params: ['a', 'b'], body: 'a && b' } }, 'both(ws.rule == "x" // a, b)\n, true)')).toEqual([]);
  });
});

describe('expansions too big to check', () => {
  test('are reported on the macro, not thrown', () => {
    const doubling = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `m${index}`, index === 0 ? { params: ['p'], body: 'p == 1' } : { params: ['p'], body: `m${index - 1}(p) && m${index - 1}(p)` },
    ]));

    const problems = problemsWith(doubling, 'm29(1)');

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => /^macro "m\d+" \(m\.yaml\): expands to more than/.test(problem))).toBe(true);
  });
});

describe('a param where a literal is required', () => {
  test('is checked where it is called, not refused on the macro', () => {
    const macros = {
      like: { params: ['s', 'pattern'], body: 's.matches(pattern)' },
      isSet: { params: ['container', 'path'], body: 'belaykit.present(container, path)' },
      stateOf: { params: ['key'], body: 'app_state(ws, key) == "present"' },
    };

    expect(problemsWith(macros, 'like(ws.rule, "^a$")', 'isSet(ws.facts, "transition.answer")', 'stateOf("rule")')).toEqual([]);
    expect(problemsWith(macros, 'like(ws.rule, "(a+)+$")', 'isSet(ws.facts, "transition.answr")', 'stateOf("rul")')).toEqual([
      'section "decide" rule 1 when, in macro "like": pattern "(a+)+$" may backtrack exponentially',
      expect.stringMatching(/^section "decide" rule 2 when, in macro "isSet": .*answr/),
      'section "decide" rule 3 when, in macro "stateOf": unknown ws field "rul"',
    ]);
  });
});

describe('a refused name', () => {
  test('doesn\'t take over the CEL function of that name', () => {
    expect(problemsWith({ has: 'true', size: 'true' }, 'size(ws.rule) > 0')).toEqual([
      'macro "has" (m.yaml): the name is one of CEL\'s functions',
      'macro "size" (m.yaml): the name is one of CEL\'s functions',
    ]);
  });

  test('a reserved word as a param is one problem, not also an unused param', () => {
    expect(problemsWith({ isOn: { params: ['true'], body: 'true' } })).toEqual(['macro "isOn" (m.yaml): param "true" is a CEL reserved word']);
  });

  test('a macro called as a method on cel is called as a method', () => {
    expect(problemsWith({ isReady: 'true' }, 'cel.isReady()')).toEqual([
      'section "decide" rule 1 when: macro "isReady" is called as a method; call it as isReady(…)',
    ]);
  });
});

describe('a bad call beside a good one', () => {
  test('doesn\'t hide the problems that come through the good one', () => {
    const macros = {
      isConfirmed: { params: ['p'], body: 'p.answr == "yes"' },
      isAnswered: { params: ['p', 'value'], body: 'p.answer == value' },
      isBroken: 'isMissing',
    };

    expect(problemsWith(macros, 'isConfirmed(ws.facts.transition) && isAnswered(ws.facts.transition)', 'isConfirmed(ws.facts.transition) && isBroken()')).toEqual([
      'macro "isBroken" (m.yaml): reads "isMissing", which is neither ws nor one of its params (it has none)',
      'section "decide" rule 1 when: macro "isAnswered" takes 2 arguments (p, value), given 1',
      'section "decide" rule 1 when, in macro "isConfirmed": unknown field "answr" on ws.facts.transition',
      'section "decide" rule 2 when, in macro "isConfirmed": unknown field "answr" on ws.facts.transition',
    ]);
  });
});

describe('an import that fails', () => {
  test('a file with one bad macro still gives its others', () => {
    const file = 'version: 1\nmacros:\n  isOk:\n    body: "true"\n  isBad:\n    bdy: "true"\n';

    expect(check({ 'm.yaml': file }, rulebook('isOk()', 'isOk() && true'))).toEqual(['m.yaml: macros.isBad: must have required property \'body\'', 'm.yaml: macros.isBad: unknown key "bdy"']);
  });

  test('a name it might have defined is reported once, with how many expressions use it', () => {
    const text = rulebook('isGone()', 'isGone() && isOther()', 'isGone()').replace('[./m.yaml]', '[./gone.yaml]');

    expect(check({}, text)).toEqual([
      'imports "./gone.yaml": no such file',
      'unknown function "isGone", used in 3 expressions (an import above has a problem)',
      'unknown function "isOther", used in 1 expression (an import above has a problem)',
    ]);
  });
});
