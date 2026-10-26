// Since 0.4: a rulebook given as text takes its macro files as text too, `{ imports: { path: text } }`, so a
// bundle loads without a disk. Paths are relative to the rulebook, as written in `imports:`.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const registry = () => ({
  producers: {},
  actions: {
    settle: {
      writes: ['routing'],
      params: { type: 'object', properties: { routing: { type: 'string' } }, required: ['routing'], additionalProperties: false },
      run: async (ws, { params }) => { ws.routing = params.routing; },
    },
  },
  initialKeys: ['item'],
});

const rulebookImporting = (paths, when = 'isUrgent() || isQuiet()') => `
version: 1
outputs: [routing]
imports: [${paths.join(', ')}]
sections:
  - name: decide
    when: '!has(ws.routing)'
    rules:
      - id: flagged
        when: ${when}
        then: { action: settle, routing: flagged }
      - when: "true"
        then: { action: settle, routing: ordinary }
`;

// Names no folder holds, so a load that read the disk for them would fail.
const BUNDLE = {
  'bundle-only/common.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent" || isLoud()' }, ['./shared/more.macros.yaml']),
  'bundle-only/shared/more.macros.yaml': macroFile({ isQuiet: 'ws.item == "quiet"', isLoud: 'ws.item == "loud"' }),
};
const RULEBOOK = rulebookImporting(['./bundle-only/common.macros.yaml', 'bundle-only/shared/more.macros.yaml']);

const problemsOf = (text, imports) => Rulebook.check(text, registry(), { imports });

// The macro files `load` reads from disk while `fn` runs: readFileSync patched, and the patch pushed to the ESM
// bindings the package imported (syncBuiltinESMExports), then restored.
function macroFilesReadBy(fn) {
  const original = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (path, ...rest) => {
    if (String(path).endsWith('.macros.yaml')) reads.push(String(path));
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  return reads;
}

describe('imports given as text', () => {
  test('nothing is read from disk for them, where a folder\'s are read', () => {
    const folder = folderWith(BUNDLE);
    expect(macroFilesReadBy(() => Rulebook.fromText(RULEBOOK, registry(), { imports: BUNDLE }))).toEqual([]);
    expect(macroFilesReadBy(() => Rulebook.fromText(RULEBOOK, registry(), { baseDir: folder }))).toHaveLength(2);
  });

  test('a rulebook loads and decides as the same files on disk do', async () => {
    const folder = folderWith({ 'triage.rules.yaml': RULEBOOK, ...BUNDLE });
    const fromDisk = Rulebook.load(join(folder, 'triage.rules.yaml'), registry());
    const fromText = Rulebook.fromText(RULEBOOK, registry(), { imports: BUNDLE });

    expect(fromText.sections).toEqual(fromDisk.sections);
    expect(fromText.describeFunctions()).toEqual(fromDisk.describeFunctions());
    for (const item of ['urgent', 'quiet', 'loud', 'other']) {
      expect(await fromText.decide({ item })).toEqual(await fromDisk.decide({ item }));
    }
    expect((await fromText.decide({ item: 'loud' })).outputs).toEqual({ routing: 'flagged' });
  });

  test('check and checkMacros take them too', () => {
    expect(problemsOf(RULEBOOK, BUNDLE)).toEqual([]);
    const { 'bundle-only/common.macros.yaml': common, ...rest } = BUNDLE;
    const imports = Object.fromEntries(Object.entries(rest).map(([path, text]) => [path.replace('bundle-only/', ''), text]));
    expect(Rulebook.checkMacros(common, registry(), { imports })).toEqual([]);
  });

  // The file is read once, so its first importer reports it, as on disk.
  test('a path the map doesn\'t hold is a problem naming the import as written, in the importing file', () => {
    const { 'bundle-only/shared/more.macros.yaml': _more, ...withoutMore } = BUNDLE;
    const problems = problemsOf(RULEBOOK, withoutMore);
    expect(problems).toEqual([
      'bundle-only/common.macros.yaml imports "./shared/more.macros.yaml": not among the given imports',
      'unknown function "isQuiet", used in 1 expression (an import above has a problem)',
      'unknown function "isLoud", used in 1 expression (an import above has a problem)',
    ]);
    const folder = folderWith(withoutMore);
    const fromDisk = Rulebook.check(RULEBOOK, registry(), { baseDir: folder });
    expect(problems).toEqual(fromDisk.map((problem) => problem.replace('no such file', 'not among the given imports')));
  });

  test('a path above the rulebook\'s folder resolves as on disk, so any layout can be given as text', async () => {
    const shared = {
      'shared/common.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent" || isLoud()' }, ['./more.macros.yaml']),
      'shared/more.macros.yaml': macroFile({ isQuiet: 'ws.item == "quiet"', isLoud: 'ws.item == "loud"' }),
    };
    const text = rulebookImporting(['../shared/common.macros.yaml', '../shared/more.macros.yaml']);
    const folder = folderWith({ 'rules/triage.rules.yaml': text, ...shared });
    const imports = Object.fromEntries(Object.entries(shared).map(([path, file]) => [`../${path}`, file]));

    const fromDisk = Rulebook.load(join(folder, 'rules/triage.rules.yaml'), registry());
    const fromText = Rulebook.fromText(text, registry(), { imports });
    expect(fromText.sections).toEqual(fromDisk.sections);
    for (const item of ['urgent', 'quiet', 'loud', 'other']) {
      expect(await fromText.decide({ item })).toEqual(await fromDisk.decide({ item }));
    }
    const { '../shared/more.macros.yaml': _more, ...withoutMore } = imports;
    expect(problemsOf(text, withoutMore)[0]).toBe('../shared/common.macros.yaml imports "./more.macros.yaml": not among the given imports');
  });

  test('an absolute path is refused, as written', () => {
    const imports = { 'a.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent"', isQuiet: 'false' }, ['/inner.macros.yaml']) };
    const absolute = 'not a file path relative to the text it comes with (imports given as text are)';
    expect(problemsOf(rulebookImporting(['a.macros.yaml', '/abs.macros.yaml']), imports)).toEqual([
      `a.macros.yaml imports "/inner.macros.yaml": ${absolute}`,
      `imports "/abs.macros.yaml": ${absolute}`,
    ]);
  });

  test('a ".." that stays inside, and a trailing slash, resolve as on disk', () => {
    const files = {
      'sub/b.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent"' }, ['../c.macros.yaml']),
      'c.macros.yaml': macroFile({ isQuiet: 'ws.item == "quiet"' }),
    };
    const text = rulebookImporting(['x/../sub/b.macros.yaml', 'c.macros.yaml/']);
    expect(problemsOf(text, files)).toEqual([]);
    expect(Rulebook.check(text, registry(), { baseDir: folderWith(files) })).toEqual([]);
  });

  test('checkMacros resolves a macro file\'s imports from that file', () => {
    const imports = { 'shared/b.macros.yaml': macroFile({ isQuiet: 'ws.item == "quiet"' }) };
    const file = macroFile({ isCalm: 'isQuiet()' }, ['./shared/b.macros.yaml']);
    expect(Rulebook.checkMacros(file, registry(), { imports })).toEqual([]);
    expect(Rulebook.checkMacros(file, registry(), { imports: {} })).toEqual([
      'imports "./shared/b.macros.yaml": not among the given imports',
      'unknown function "isQuiet", used in 1 expression (an import above has a problem)',
    ]);
  });

  test('a cycle and a name defined twice read as a folder\'s would', () => {
    const files = {
      'a.macros.yaml': macroFile({ isUrgent: 'ws.item == "urgent"', isQuiet: 'false' }, ['./c.macros.yaml']),
      'c.macros.yaml': macroFile({ isQuiet: 'true' }, ['./a.macros.yaml']),
    };
    const text = rulebookImporting(['./a.macros.yaml']);
    const folder = folderWith({ 'triage.rules.yaml': text, ...files });
    expect(problemsOf(text, files)).toEqual(Rulebook.check(text, registry(), { baseDir: folder }));
    expect(problemsOf(text, files)).toContain('imports form a cycle: a.macros.yaml -> c.macros.yaml -> a.macros.yaml');
  });
});

// Since 0.4: text has no path, so `checkMacros` takes the checked file's own (`path`), relative to the folder or the
// map's root; an import that leads back to it is then a cycle, as `belaykit-rulebook check` reports one.
describe('checkMacros with the checked file\'s path', () => {
  const a = macroFile({ isCalm: 'isQ()' }, ['./b.macros.yaml']);
  const b = macroFile({ isQ: 'true' }, ['./a.macros.yaml']);

  test('an import back to the checked file is a cycle, from text as from a folder', () => {
    const fromText = Rulebook.checkMacros(a, registry(), { imports: { 'a.macros.yaml': a, 'b.macros.yaml': b }, path: 'a.macros.yaml' });
    const fromFolder = Rulebook.checkMacros(a, registry(), { baseDir: folderWith({ 'a.macros.yaml': a, 'b.macros.yaml': b }), path: 'a.macros.yaml' });
    expect(fromText).toEqual(['imports form a cycle: a.macros.yaml -> b.macros.yaml -> a.macros.yaml']);
    expect(fromFolder).toEqual(fromText);
  });

  test('without the path, the file is read again and its macros are defined twice, as before', () => {
    expect(Rulebook.checkMacros(a, registry(), { imports: { 'a.macros.yaml': a, 'b.macros.yaml': b } }))
      .toContain('macro "isCalm" is defined in both this file and a.macros.yaml');
  });

  test('the checked file\'s imports resolve from its own folder', () => {
    const nested = macroFile({ isCalm: 'isQ()' }, ['./b.macros.yaml']);
    const imports = { 'sub/b.macros.yaml': macroFile({ isQ: 'true' }) };
    expect(Rulebook.checkMacros(nested, registry(), { imports, path: 'sub/a.macros.yaml' })).toEqual([]);
  });

  test.each([
    ['a path that isn\'t a string', { imports: {}, path: 3 }, 'Rulebook.checkMacros: path must be a string'],
    ['a path with no files to place it among', { path: 'a.macros.yaml' }, 'Rulebook.checkMacros: path places the file among baseDir or imports; pass one'],
    ['a path naming a folder', { imports: {}, path: '.' }, 'Rulebook.checkMacros: path "." isn\'t a file path relative to the imports'],
    ['a path naming a folder, beside baseDir', { baseDir: '.', path: '.' }, 'Rulebook.checkMacros: path "." isn\'t a file path relative to baseDir'],
    ['an empty path, beside baseDir', { baseDir: '.', path: '' }, 'Rulebook.checkMacros: path "" isn\'t a file path relative to baseDir'],
    ['the folder above, beside baseDir', { baseDir: '.', path: '../' }, 'Rulebook.checkMacros: path "../" isn\'t a file path relative to baseDir'],
    ['a path whose map entry holds other text', { imports: { 'a.macros.yaml': b }, path: 'a.macros.yaml' }, 'Rulebook.checkMacros: imports "a.macros.yaml" holds other text than the file checked at path "a.macros.yaml"'],
  ])('%s is a TypeError', (_label, options, message) => {
    expect(() => Rulebook.checkMacros(a, registry(), options)).toThrow(new TypeError(message));
  });

  test('a path whose map entry holds the same text is the same file', () => {
    expect(Rulebook.checkMacros(a, registry(), { imports: { './a.macros.yaml': a, 'b.macros.yaml': b }, path: 'a.macros.yaml' }))
      .toEqual(['imports form a cycle: a.macros.yaml -> b.macros.yaml -> a.macros.yaml']);
  });

  test('fromText and check take no path: a rulebook isn\'t imported', () => {
    const text = rulebookImporting(['a.macros.yaml']);
    expect(() => Rulebook.check(text, registry(), { imports: {}, path: 'x.rules.yaml' }))
      .toThrow(new TypeError('Rulebook.check: unknown option "path" (options: baseDir, imports)'));
  });
});

describe('the imports option', () => {
  const text = rulebookImporting(['a.macros.yaml']);
  const imports = { 'a.macros.yaml': macroFile({ isUrgent: 'true', isQuiet: 'false' }) };

  test.each([
    ['fromText', (options) => Rulebook.fromText(text, registry(), options)],
    ['check', (options) => Rulebook.check(text, registry(), options)],
    ['checkMacros', (options) => Rulebook.checkMacros(imports['a.macros.yaml'], registry(), options)],
  ])('%s refuses baseDir and imports together', (name, call) => {
    expect(() => call({ baseDir: '.', imports })).toThrow(new TypeError(`Rulebook.${name}: pass baseDir or imports, not both`));
  });

  test.each([
    ['a string', 'a.macros.yaml', 'Rulebook.check: imports must be a plain object of path to text'],
    ['a list', ['a.macros.yaml'], 'Rulebook.check: imports must be a plain object of path to text'],
    ['a Map', new Map([['a.macros.yaml', '']]), 'Rulebook.check: imports must be a plain object of path to text; for a Map, pass Object.fromEntries(map)'],
    ['a class instance', new (class Files { constructor() { this['a.macros.yaml'] = ''; } })(), 'Rulebook.check: imports must be a plain object of path to text'],
    ['text that isn\'t a string', { 'a.macros.yaml': 1 }, 'Rulebook.check: imports "a.macros.yaml" must be text (a string)'],
    ['two keys naming one file', { './a.macros.yaml': '', 'a.macros.yaml': '' }, 'Rulebook.check: imports "./a.macros.yaml" and "a.macros.yaml" name the same file'],
    ['an absolute key', { '/a.macros.yaml': '' }, 'Rulebook.check: imports "/a.macros.yaml" isn\'t a file path relative to the text it comes with'],
    ['a key naming a folder', { '.': '', '..': '' }, 'Rulebook.check: imports "." isn\'t a file path relative to the text it comes with'],
    ['a key naming the folder above', { '../': '' }, 'Rulebook.check: imports "../" isn\'t a file path relative to the text it comes with'],
  ])('a map that is %s is a TypeError', (_label, value, message) => {
    expect(() => Rulebook.check(text, registry(), { imports: value })).toThrow(new TypeError(message));
  });

  test('a map without a prototype is taken', () => {
    expect(Rulebook.check(text, registry(), { imports: Object.assign(Object.create(null), imports) })).toEqual([]);
  });

  test('a baseDir that isn\'t a string is named first, beside imports too', () => {
    expect(() => Rulebook.check(text, registry(), { baseDir: null, imports })).toThrow(new TypeError('Rulebook.check: baseDir must be a string'));
  });

  test('text with imports and neither option says to pass one', () => {
    expect(Rulebook.check(text, registry())).toEqual([
      'imports: a rulebook read from text resolves its imports from a folder; pass { baseDir } or { imports }',
      'unknown function "isUrgent", used in 1 expression (an import above has a problem)',
      'unknown function "isQuiet", used in 1 expression (an import above has a problem)',
    ]);
  });
});
