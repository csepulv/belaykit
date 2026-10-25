import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const registry = () => ({
  producers: {},
  actions: { settle: { writes: ['routing'], run: async (ws) => { ws.routing = 'done'; } } },
  initialKeys: ['item', 'routing'],
});

const rulebookImporting = (...paths) => `
version: 1
imports: [${paths.join(', ')}]
sections:
  - name: decide
    when: ws.routing == null
    rules:
      - when: "true"
        then: { action: settle }
`;

const problemsOf = (folder, rulebookPath = 'triage.rules.yaml') => {
  try {
    Rulebook.load(join(folder, rulebookPath), registry());
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

describe('a rulebook imports macro files', () => {
  test('a rulebook importing a macro file loads, from a file or from text with baseDir', () => {
    const folder = folderWith({
      'triage.rules.yaml': rulebookImporting('./common.macros.yaml'),
      'common.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent"' }),
    });

    expect(problemsOf(folder)).toEqual([]);
    expect(Rulebook.check(rulebookImporting('./common.macros.yaml'), registry(), { baseDir: folder })).toEqual([]);
    expect(Rulebook.fromText(rulebookImporting('./common.macros.yaml'), registry(), { baseDir: folder }).sections).toHaveLength(1);
  });

  test('imports resolve from the importing file, wherever that is', () => {
    const folder = folderWith({
      'rules/triage.rules.yaml': rulebookImporting('../shared/common.macros.yaml'),
      'shared/common.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent"' }, ['./more.macros.yaml']),
      'shared/more.macros.yaml': macroFile({ isQuiet: 'ws.item == "quiet"' }),
    });

    expect(problemsOf(folder, 'rules/triage.rules.yaml')).toEqual([]);
  });

  test('text with imports and no baseDir says what to pass', () => {
    expect(Rulebook.check(rulebookImporting('./common.macros.yaml'), registry())).toEqual([
      'imports: a rulebook read from text resolves its imports from a folder; pass { baseDir }',
    ]);
  });

  test('a missing import names the file that imports it and the path', () => {
    const folder = folderWith({
      'triage.rules.yaml': rulebookImporting('./common.macros.yaml', './gone.macros.yaml'),
      'common.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent"' }, ['./also-gone.macros.yaml']),
    });

    expect(problemsOf(folder)).toEqual([
      'common.macros.yaml imports "./also-gone.macros.yaml": no such file',
      'imports "./gone.macros.yaml": no such file',
    ]);
  });

  test('files that import each other are a cycle, named once', () => {
    const folder = folderWith({
      'triage.rules.yaml': rulebookImporting('./a.macros.yaml'),
      'a.macros.yaml': macroFile({ isA: 'true' }, ['./b.macros.yaml']),
      'b.macros.yaml': macroFile({ isB: 'true' }, ['./a.macros.yaml']),
    });

    expect(problemsOf(folder)).toEqual(['imports form a cycle: a.macros.yaml -> b.macros.yaml -> a.macros.yaml']);
  });

  test('a file reached by two paths is read once, and is not a cycle', () => {
    const folder = folderWith({
      'triage.rules.yaml': rulebookImporting('./a.macros.yaml', './b.macros.yaml'),
      'a.macros.yaml': macroFile({ isA: 'true' }, ['./shared.macros.yaml']),
      'b.macros.yaml': macroFile({ isB: 'true' }, ['./shared.macros.yaml']),
      'shared.macros.yaml': macroFile({ isShared: 'true' }),
    });

    expect(problemsOf(folder)).toEqual([]);
  });

  test('one name defined in two files is refused, naming both', () => {
    const folder = folderWith({
      'triage.rules.yaml': rulebookImporting('./a.macros.yaml', './b.macros.yaml'),
      'a.macros.yaml': macroFile({ isReady: 'true' }),
      'b.macros.yaml': macroFile({ isReady: 'false' }),
    });

    expect(problemsOf(folder)).toEqual(['macro "isReady" is defined in both a.macros.yaml and b.macros.yaml']);
  });

  test('a macro file is checked against its own schema and YAML, named by file', () => {
    const folder = folderWith({
      'triage.rules.yaml': rulebookImporting('./a.macros.yaml', './b.macros.yaml', './c.macros.yaml'),
      'a.macros.yaml': 'version: 1\nmacros:\n  isReady:\n    bdy: "true"\n',
      'b.macros.yaml': 'version: 1\nmacros:\n  is-ready:\n    body: "true"\n',
      'c.macros.yaml': 'version: 1\nmacros: [oops\n',
    });

    expect(problemsOf(folder)).toEqual([
      'a.macros.yaml: macros.isReady: must have required property \'body\'',
      'a.macros.yaml: macros.isReady: unknown key "bdy"',
      'b.macros.yaml: macros: macro "is-ready" must match pattern "^[a-z][a-zA-Z0-9_]*$"',
      expect.stringMatching(/^c\.macros\.yaml: YAML: /),
    ]);
  });

  test('a rulebook can\'t define macros itself; they live in macro files', () => {
    const text = `${rulebookImporting('./a.macros.yaml')}macros:\n  isReady:\n    body: "true"\n`;

    expect(Rulebook.check(text, registry(), { baseDir: folderWith({ 'a.macros.yaml': macroFile({ isA: 'true' }) }) }))
      .toEqual(['(top level): unknown key "macros"']);
  });

  test('fromText and check take only baseDir, as a string', () => {
    const text = rulebookImporting('./a.macros.yaml');

    expect(() => Rulebook.fromText(text, registry(), { basedir: '.' }))
      .toThrow(new TypeError('Rulebook.fromText: unknown option "basedir" (options: baseDir)'));
    expect(() => Rulebook.check(text, registry(), { baseDir: 3 }))
      .toThrow(new TypeError('Rulebook.check: baseDir must be a string'));
    expect(() => Rulebook.check(text, registry(), 'rules'))
      .toThrow(new TypeError('Rulebook.check: options must be an object, such as { baseDir }'));
  });
});
