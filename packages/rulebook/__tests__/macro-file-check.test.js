import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const HINT = ' (a macro file knows the keys its registry names: initialKeys, writes and shapes)';

const registry = () => ({
  producers: { fetch: { writes: ['items'] } },
  actions: { settle: { writes: ['routing'], run: async (ws) => { ws.routing = 'done'; } } },
  initialKeys: ['item'],
  shapes: {
    item: { type: 'object', properties: { age: { type: 'integer' } }, additionalProperties: false },
    profile: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  },
});

const rulebookImporting = (path, when) => `
version: 1
imports: [${path}]
sections:
  - name: decide
    when: "true"
    rules:
      - when: '${when}'
        then: { action: settle }
      - when: "true"
        then: { action: settle }
`;

describe('Rulebook.checkMacros: every macro in a file, against a registry', () => {
  test('a clean file has no problems', () => {
    const text = macroFile({ isOld: { params: ['item'], body: 'item.age > 3' }, hasItems: 'size(ws.items) > 0' });

    expect(Rulebook.checkMacros(text, registry())).toEqual([]);
  });

  test('a macro nothing calls is checked: a key the registry doesn\'t name, with where keys come from', () => {
    const text = macroFile({ isStale: 'size(ws.itmes) > 0', isNamed: 'ws.profile.name != ""' });

    expect(Rulebook.checkMacros(text, registry())).toEqual([`macro "isStale": unknown ws field "itmes"${HINT}`]);
  });

  test('its body is checked as a called one is: shapes, params, names it reads, calls, cycles', () => {
    const text = macroFile({
      isAged: 'ws.item.ag > 3',
      isLoose: { params: ['x', 'unused'], body: 'x > other' },
      callsBadly: 'isAged(1)',
      isPing: 'isPong()',
      isPong: 'isPing()',
    });

    expect(Rulebook.checkMacros(text, registry())).toEqual([
      'macro "isLoose": reads "other", which is neither ws nor one of its params (x, unused)',
      'macro "isLoose": param "unused" is never used',
      'macro "callsBadly": macro "isAged" takes no arguments, given 1',
      'macro "isPing": calls itself: isPing -> isPong -> isPing',
      'macro "isAged": unknown field "ag" on ws.item',
    ]);
  });

  test('one file, two agents: each registry shows which macros its agent can call', () => {
    const text = macroFile({ readsA: 'ws.a == 1', readsB: 'ws.b == 1' });
    const agent = (key) => ({ producers: {}, actions: {}, initialKeys: [key] });

    expect(Rulebook.checkMacros(text, agent('a'))).toEqual([`macro "readsB": unknown ws field "b"${HINT}`]);
    expect(Rulebook.checkMacros(text, agent('b'))).toEqual([`macro "readsA": unknown ws field "a"${HINT}`]);
  });

  test('a rulebook that imports the file, but calls only what works, still checks clean', () => {
    const folder = folderWith({ 'common.macros.yaml': macroFile({ hasItems: 'size(ws.items) > 0', isStale: 'size(ws.itmes) > 0' }) });
    // A shape for a key only some rulebook's needs declares (profile) is refused in a rulebook that doesn't.
    const { profile, ...shapes } = registry().shapes;

    expect(Rulebook.check(rulebookImporting('./common.macros.yaml', 'hasItems()'), { ...registry(), shapes }, { baseDir: folder })).toEqual([]);
  });

  test('its imports resolve from baseDir; their macros are checked as far as the file calls them', () => {
    const folder = folderWith({
      'more.macros.yaml': macroFile({ isBusy: 'size(ws.items) > 9', isBroken: 'ws.nope' }),
    });
    const text = macroFile({ isReady: '!isBusy()' }, ['./more.macros.yaml', './gone.macros.yaml']);

    expect(Rulebook.checkMacros(text, registry(), { baseDir: folder })).toEqual(['imports "./gone.macros.yaml": no such file']);
  });

  test('without baseDir its imports aren\'t read, and its own macros are still checked', () => {
    const text = macroFile({ isReady: '!isBusy()', isStale: 'size(ws.itmes) > 0' }, ['./more.macros.yaml']);

    expect(Rulebook.checkMacros(text, registry())).toEqual([
      'imports: a macro file read from text resolves its imports from a folder; pass { baseDir }',
      'unknown function "isBusy", used in 1 expression (an import above has a problem)',
      `macro "isStale": unknown ws field "itmes"${HINT}`,
    ]);
  });

  test('a call to one of its own macros that has a problem names the macro, not an import', () => {
    const text = 'version: 1\nmacros:\n  good:\n    body: "bad()"\n  bad:\n    bdy: "true"\n';

    expect(Rulebook.checkMacros(text, registry())).toEqual([
      'macros.bad: must have required property \'body\'',
      'macros.bad: unknown key "bdy"',
      'unknown function "bad", used in 1 expression (a macro above has a problem)',
    ]);
  });

  test('names, captures, size, helper paths and patterns are checked too', () => {
    const doubling = Object.fromEntries(Array.from({ length: 14 }, (_, level) => [`m${level}`,
      level === 0 ? 'ws.item.age > 1 && ws.item.age < 100' : `m${level - 1}() && m${level - 1}()`]));
    const text = macroFile({
      size: 'true',
      inner: { params: ['p'], body: 'ws.items.exists(x, x == p)' },
      outer: { params: ['x'], body: 'inner(x)' },
      hasAge: 'belaykit.present(ws, "itme.age")',
      isSafe: 'ws.profile.name.matches("(a+)+$")',
      ...doubling,
    });

    expect(Rulebook.checkMacros(text, registry())).toEqual([
      'macro "size": the name is one of CEL\'s functions',
      'macro "outer": macro "inner": an argument reads "x", which the macro\'s body binds too; rename that variable in the macro',
      'macro "m12": expands to more than 100,000 characters, too large to check; call fewer macros that call macros',
      `macro "hasAge": belaykit.present "itme.age": unknown ws field "itme"${HINT}`,
      'macro "isSafe": pattern "(a+)+$" may backtrack exponentially',
    ]);
  });

  test('a name defined both in the file and in one it imports is refused', () => {
    const folder = folderWith({ 'more.macros.yaml': macroFile({ isBusy: 'true' }) });

    expect(Rulebook.checkMacros(macroFile({ isBusy: 'false' }, ['./more.macros.yaml']), registry(), { baseDir: folder }))
      .toEqual(['macro "isBusy" is defined in both this file and more.macros.yaml']);
  });

  test('its YAML and schema are checked, as an imported file\'s are', () => {
    expect(Rulebook.checkMacros('version: 1\nmacros:\n  isReady:\n    bdy: "true"\n', registry())).toEqual([
      'macros.isReady: must have required property \'body\'',
      'macros.isReady: unknown key "bdy"',
    ]);
    expect(Rulebook.checkMacros('version: 1\nmacros: [oops\n', registry())).toEqual([expect.stringMatching(/^YAML: /)]);
  });

  test('the registry\'s own problems are reported too', () => {
    const broken = { ...registry(), functions: [{ signature: 'bad.name(string): bool', handler: () => true }] };

    expect(Rulebook.checkMacros(macroFile({ isOld: 'ws.item.age > 3' }), broken))
      .toEqual(['function "bad.name": dots aren\'t allowed in names; use bad_name']);
  });

  test('a macro file given to Rulebook.check says to use checkMacros', () => {
    expect(Rulebook.check(macroFile({ isOld: 'ws.item.age > 3' }), registry())).toContain(
      'this is a macro file (macros:, no sections:); check it with Rulebook.checkMacros or belaykit-rulebook check',
    );
  });

  test('a rulebook given to checkMacros says to use Rulebook.check', () => {
    const rulebook = 'version: 1\nsections:\n  - name: decide\n    when: "true"\n    rules: []\n';

    expect(Rulebook.checkMacros(rulebook, registry())).toEqual([
      "(top level): must have required property 'macros'",
      '(top level): unknown key "sections"',
      'this is a rulebook (sections:); check it with Rulebook.check or belaykit-rulebook check',
    ]);
  });

  test('it takes the options fromText and check take', () => {
    expect(() => Rulebook.checkMacros(macroFile({ isOld: 'true' }), registry(), { basedir: '.' }))
      .toThrow(new TypeError('Rulebook.checkMacros: unknown option "basedir" (options: baseDir)'));
    expect(() => Rulebook.checkMacros(3, registry())).toThrow(new TypeError('Rulebook.checkMacros: text must be a string'));
  });
});
