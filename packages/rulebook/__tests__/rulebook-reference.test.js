// A rulebook's own reference: what the registry's reference lists, then the macros the rulebook
// can call, each with its call form, file, description and body.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeFunctions, Rulebook } from '../index.js';
import { folderWith, macroFile } from './macro-files.js';

const registry = () => ({
  producers: {},
  actions: { settle: { writes: ['routing'], run: async () => {} } },
  initialKeys: ['facts', 'routing'],
});

const RULEBOOK = `version: 1
imports: [./common.macros.yaml]
sections:
  - name: decide
    when: ws.routing == null
    exhaustive: false
    rules:
      - when: isAnswered(ws.facts, "yes") && isReady()
        then: { action: settle }
`;

const files = () => folderWith({
  'triage.rules.yaml': RULEBOOK,
  'common.macros.yaml': macroFile({
    isReady: { body: 'isConfirmed(ws.facts)', description: 'the facts are confirmed' },
    isAnswered: { params: ['p', 'value'], body: 'p.answer == value' },
  }, ['./base.macros.yaml']),
  'base.macros.yaml': macroFile({ isConfirmed: { params: ['p'], body: 'p.confirmed == true' } }),
});

const MACROS = `Macros, from the files this rulebook imports: each is expanded where it's called, so its body is checked there.

## isAnswered

\`isAnswered(p, value)\`, from \`common.macros.yaml\`

\`\`\`cel
p.answer == value
\`\`\`

## isReady

\`isReady()\`, from \`common.macros.yaml\`

the facts are confirmed

\`\`\`cel
isConfirmed(ws.facts)
\`\`\`
`;

describe('rulebook.describeFunctions', () => {
  test('is the registry\'s reference, then the macros the rulebook can call, by name', () => {
    const rules = Rulebook.load(join(files(), 'triage.rules.yaml'), registry());

    expect(rules.describeFunctions()).toBe(`${describeFunctions(registry())}\n${MACROS}`);
  });

  test('a rulebook without imports gives exactly the registry\'s reference', () => {
    const rules = Rulebook.fromText(RULEBOOK.replace('imports: [./common.macros.yaml]\n', '').replace('isAnswered(ws.facts, "yes") && isReady()', '"true"'), registry());

    expect(rules.describeFunctions()).toBe(describeFunctions(registry()));
  });

  test('lists the functions the rulebook was checked with, not ones added to the registry after', () => {
    const given = { ...registry(), functions: [{ signature: 'app_a(string): bool', handler: () => true }] };
    const rules = Rulebook.load(join(files(), 'triage.rules.yaml'), given);
    const before = rules.describeFunctions();
    given.functions.push({ signature: 'app_b(string): bool', handler: () => true });
    given.functions[0].description = 'added later';

    expect(rules.describeFunctions()).toBe(before);
  });

  test('lists each function\'s params and key note as checked, not as edited in the registry after', () => {
    const given = {
      ...registry(),
      functions: [{
        signature: 'app_has(map, string): bool',
        handler: () => true,
        params: [{ name: 'container', description: 'where to look' }, { name: 'field', description: 'the field' }],
        keyArgs: { key: 1, in: 0 },
      }],
    };
    const rules = Rulebook.load(join(files(), 'triage.rules.yaml'), given);
    const before = rules.describeFunctions();
    given.functions[0].params[0].description = 'edited later';
    given.functions[0].params.push({ name: 'extra' });
    given.functions[0].keyArgs.key = 0;

    expect(rules.describeFunctions()).toBe(before);
  });
});

describe('belaykit-rulebook reference <file>', () => {
  const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
  const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: FIXTURES, encoding: 'utf-8' });

  test('prints the rulebook\'s reference, its imports resolved from its folder', () => {
    const { status, stdout } = run('reference', 'rules/with-macros.yaml', '--registry', 'registry.js#triageRegistry');

    expect(status).toBe(0);
    expect(stdout).toMatch(/^# Rulebook functions\n/);
    expect(stdout).toContain('## hasText\n\n`hasText()`, from `triage.macros.yaml`\n\nthe item has something besides whitespace\n');
  });

  test('a rulebook with problems prints them and exits 1', () => {
    const { status, stdout, stderr } = run('reference', 'rules/missing-import.yaml', '--registry', 'registry.js#triageRegistry');

    expect({ status, stdout, stderr: stderr.trim() }).toEqual({ status: 1, stdout: '', stderr: 'rules/missing-import.yaml: imports "./gone.macros.yaml": no such file' });
  });
});
