// Mistakes in macro files are refused at load, each once, in words that say what to fix,
// and none hides another.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const answer = { type: 'object', properties: { answer: { enum: ['yes', 'no'] } }, additionalProperties: false };

const registry = () => ({
  producers: {},
  actions: { settle: { writes: ['routing'], run: async (ws) => { ws.routing = 'done'; } } },
  functions: [{ signature: 'app_isBlank(string): bool', handler: (text) => !text.trim() }],
  initialKeys: ['facts', 'items', 'routing'],
  shapes: {
    facts: { type: 'object', properties: { transition: answer }, additionalProperties: false },
    items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } },
  },
});

const rulebook = (...whens) => `
version: 1
imports: [./m.yaml]
sections:
  - name: decide
    when: ws.routing == null
    rules:
${whens.map((when) => `      - when: ${JSON.stringify(when)}\n        then: { action: settle }`).join('\n')}
      - when: "true"
        then: { action: settle }
`;

const problemsWith = (macros, ...whens) => Rulebook.check(rulebook(...whens), registry(), { baseDir: folderWith({ 'm.yaml': macroFile(macros) }) });

describe('a macro\'s own problems, reported once on the macro, whether or not it is called', () => {
  test('macros that call each other are a cycle; a call to one is not expanded, and adds nothing', () => {
    expect(problemsWith({ isA: 'isB()', isB: 'isA()', isC: 'isC()' }, 'isA()')).toEqual([
      'macro "isA" (m.yaml): calls itself: isA -> isB -> isA',
      'macro "isC" (m.yaml): calls itself: isC -> isC',
    ]);
  });

  test('a name that a rulebook\'s CEL already calls is refused', () => {
    expect(problemsWith({ size: 'true', has: 'true', app_isBlank: 'true', belaykit: 'true', cel: 'true' })).toEqual([
      'macro "size" (m.yaml): the name is one of CEL\'s functions',
      'macro "has" (m.yaml): the name is one of CEL\'s functions',
      'macro "app_isBlank" (m.yaml): the name is a registered function\'s name',
      'macro "belaykit" (m.yaml): the name is reserved for BelayKit\'s helpers',
      'macro "cel" (m.yaml): the name is CEL\'s own namespace',
    ]);
  });

  test('a param is named as a selectFirst binding is', () => {
    expect(problemsWith({
      hidesWs: { params: ['ws'], body: 'ws.routing == null' },
      typeName: { params: ['string'], body: 'string == "x"' },
      reserved: { params: ['in'], body: 'true' },
    })).toEqual([
      'macro "hidesWs" (m.yaml): param "ws" would hide the working set',
      'macro "typeName" (m.yaml): param "string" is a name CEL already defines',
      'macro "reserved" (m.yaml): param "in" is a CEL reserved word',
    ]);
  });

  test('a body reads only ws, its params and the variables it binds', () => {
    expect(problemsWith({
      isLeaky: { params: ['p'], body: 'p.answer == expected' },
      isFine: { params: ['list'], body: 'list.exists(entry, entry.name == "x") && cel.bind(n, 1, n == 1) && type(ws) == map' },
    })).toEqual([
      'macro "isLeaky" (m.yaml): reads "expected", which is neither ws nor one of its params (p)',
      'macro "isFine" (m.yaml): param "list" is a name CEL already defines',
    ]);
  });

  test('a param the body never uses is refused', () => {
    expect(problemsWith({ isReady: { params: ['p', 'value'], body: 'p.answer == "yes"' } })).toEqual([
      'macro "isReady" (m.yaml): param "value" is never used',
    ]);
  });

  test('a body that calls a macro with the wrong number of arguments, or as a method, is refused', () => {
    expect(problemsWith({
      isAnswered: { params: ['p', 'value'], body: 'p.answer == value' },
      isYes: { params: ['p'], body: 'isAnswered(p)' },
      isMethod: { params: ['p'], body: 'p.isAnswered("yes")' },
    })).toEqual([
      'macro "isYes" (m.yaml): macro "isAnswered" takes 2 arguments (p, value), given 1',
      'macro "isMethod" (m.yaml): macro "isAnswered" is called as a method; call it as isAnswered(…)',
    ]);
  });

  test('a body that doesn\'t parse is refused', () => {
    expect(problemsWith({ isBroken: 'ws.routing ==' })).toEqual([expect.stringMatching(/^macro "isBroken" \(m\.yaml\): /)]);
  });
});

describe('a call\'s problems, reported where it is', () => {
  const COMMON = { isAnswered: { params: ['p', 'value'], body: 'p.answer == value' }, isNamed: { params: ['entry'], body: 'ws.items.exists(item, item.name == entry)' } };

  test('a call with the wrong number of arguments, or as a method, is refused at the call', () => {
    expect(problemsWith(COMMON, 'isAnswered(ws.facts.transition)', 'ws.facts.isAnswered("yes")')).toEqual([
      'section "decide" rule 1 when: macro "isAnswered" takes 2 arguments (p, value), given 1',
      'section "decide" rule 2 when: macro "isAnswered" is called as a method; call it as isAnswered(…)',
    ]);
  });

  test('an argument that a body\'s variable would capture is refused at the call', () => {
    const text = rulebook('true').replace('      - when: "true"\n        then: { action: settle }\n      - when', '      - selectFirst: { item: ws.items }\n        when: isNamed(item.name)\n        then: { action: settle }\n      - when');

    expect(Rulebook.check(text, registry(), { baseDir: folderWith({ 'm.yaml': macroFile(COMMON) }) })).toEqual([
      'section "decide" rule 1 when: macro "isNamed": an argument reads "item", which the macro\'s body binds too; rename that variable in the macro',
    ]);
  });

  test('a call to a macro from an import that has a problem says so', () => {
    const text = rulebook('isGone()').replace('imports: [./m.yaml]', 'imports: [./gone.yaml]');

    expect(Rulebook.check(text, registry(), { baseDir: folderWith({}) })).toEqual([
      'imports "./gone.yaml": no such file',
      'unknown function "isGone", used in 1 expression (an import above has a problem)',
    ]);
    expect(Rulebook.check(text, registry())).toEqual([
      'imports: a rulebook read from text resolves its imports from a folder; pass { baseDir }',
      'unknown function "isGone", used in 1 expression (an import above has a problem)',
    ]);
  });
});

describe('two mistakes at once are both reported', () => {
  test('a macro\'s problem, a call\'s problem and a rule\'s own typo', () => {
    expect(problemsWith(
      { isReady: { params: ['p', 'unused'], body: 'p.answer == "yes"' }, isAnswered: { params: ['p', 'value'], body: 'p.answer == value' } },
      'isAnswered(ws.facts.transition) && ws.itme == 1',
      'isReady(ws.facts.transition, 1)',
    )).toEqual([
      'macro "isReady" (m.yaml): param "unused" is never used',
      'section "decide" rule 1 when: macro "isAnswered" takes 2 arguments (p, value), given 1',
      'section "decide" rule 1 when: unknown ws field "itme"',
    ]);
  });
});
