// A rulebook author's mistake is reported in the rulebook's own words: by section name
// and rule number (from 1), never as a JSON path, and naming what's wrong.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadFixture, Rulebook } from '../index.js';

const registry = {
  producers: { classify_item: { writes: ['classification'] } },
  actions: { settle: { writes: ['routing'] } },
  functions: [{ signature: 'app_isBlank(string): bool', handler: (text) => !text.trim() }],
  initialKeys: ['item', 'routing'],
};

const rulebook = ({ when = 'ws.routing == null', rule = '' } = {}) => `
version: 1
sections:
  - name: gather
    when: '!("classification" in ws.gathered)'
    needs: { classification: classify_item }
  - name: decide
    when: ${JSON.stringify(when)}
    rules:
      - id: urgent
        when: ws.classification.urgent == true
        then: { action: settle }
${rule}`;

const problemsOf = (text) => Rulebook.check(text, registry);

describe('unknown functions', () => {
  test('a call to a function nobody defines is named as unknown', () => {
    expect(problemsOf(rulebook({ rule: '      - when: app_isBlnk(ws.item)\n        then: { action: settle }' })))
      .toEqual(['section "decide" rule 2 when: unknown function "app_isBlnk"']);
  });

  test('a method nobody defines is named as unknown', () => {
    expect(problemsOf(rulebook({ when: 'ws.item.lowerAsci() == "x"' })))
      .toEqual(['section "decide" when: unknown function "lowerAsci"']);
  });

  test('a known function given the wrong arguments keeps CEL\'s own message', () => {
    expect(problemsOf(rulebook({ rule: '      - when: app_isBlank(1)\n        then: { action: settle }' })))
      .toEqual(['section "decide" rule 2 when: found no matching overload for \'app_isBlank(int)\'']);
  });

  test('CEL\'s built-in functions and macros are known', () => {
    const when = '"x" in ws.gathered && size(ws.gathered) > 0 && ws.gathered.exists(g, g.startsWith("a")) && ws.gathered.all(g, g.lowerAscii() == g) && ws.gathered.exists_one(g, g == "a") && size(ws.gathered.filter(g, g == "a").map(g, g.trim())) == 1 && has(ws.item.x)';
    expect(problemsOf(rulebook({ when }))).toEqual([]);
  });
});

describe('the file\'s shape, in the rulebook\'s words', () => {
  test.each([
    ['a misspelled rule key', (text) => text.replace('      - id: urgent\n', '      - id: urgent\n        selectFrist: { s: ws.items }\n'), 'section "decide" rule 1 (urgent): unknown key "selectFrist"'],
    ['a rule key of the wrong type', (text) => text.replace('when: ws.classification.urgent == true', 'when: 3'), 'section "decide" rule 1 (urgent) when: must be string'],
    ['a rule with no action', (text) => text.replace('then: { action: settle }', 'then: { routing: hold }'), 'section "decide" rule 1 (urgent) then: must have required property \'action\''],
    ['an unknown hit policy', (text) => text.replace('  - name: decide\n', '  - name: decide\n    hitPolicy: FRIST\n'), 'section "decide" hitPolicy: must be one of FIRST, ALL'],
    ['an unknown default hit policy', (text) => text.replace('version: 1\n', 'version: 1\nhitPolicyDefault: any\n'), 'hitPolicyDefault: must be one of FIRST, ALL'],
    ['an unknown top-level key', (text) => text.replace('version: 1\n', 'version: 1\nstages: []\n'), '(top level): unknown key "stages"'],
    ['a section whose name breaks the pattern', (text) => text.replace('name: decide', 'name: Decide'), 'section 2 name: must match pattern "^[a-z][a-z0-9_]*$"'],
  ])('%s', (_label, edit, message) => {
    expect(problemsOf(edit(rulebook()))).toEqual([message]);
  });

  test('a selectFirst binding with a bad name is one problem, naming the binding', () => {
    const text = rulebook().replace('      - id: urgent\n', '      - id: urgent\n        selectFirst: { Item: ws.item }\n');
    expect(problemsOf(text)).toEqual(['section "decide" rule 1 (urgent) selectFirst: binding "Item" must match pattern "^[a-z][a-z0-9_]*$"']);
  });

  test('no load message carries a JSON path', () => {
    const broken = rulebook().replace('then: { action: settle }', 'then: 7').replace('hitPolicy', 'x');
    expect(problemsOf(broken).join('\n')).not.toMatch(/\/sections\//);
  });
});

describe('needs keys', () => {
  test.each(['__proto__', 'constructor', 'toString'])('a needs key named %s is refused', (key) => {
    const text = rulebook().replace('needs: { classification: classify_item }', `needs: { ${key}: classify_item }`).replace('ws.classification.urgent == true', '"true"');
    expect(problemsOf(text)).toContain(`section "gather" needs "${key}": that name is a property of every JavaScript object; use another`);
  });
});

describe('arguments that aren\'t text', () => {
  test.each([
    ['check', () => Rulebook.check(undefined, registry), 'Rulebook.check: text must be a string'],
    ['fromText', () => Rulebook.fromText({ version: 1 }, registry), 'Rulebook.fromText: text must be a string'],
    ['load', () => Rulebook.load(42, registry), 'Rulebook.load: path must be a string'],
  ])('Rulebook.%s refuses them, naming the argument', (_name, call, message) => {
    expect(call).toThrow(new TypeError(message));
  });
});

describe('fixture files', () => {
  const fixtureFile = (text) => {
    const path = join(mkdtempSync(join(tmpdir(), 'belaykit-fixture-')), 'fixture.yaml');
    writeFileSync(path, text);
    return path;
  };

  test('YAML that doesn\'t parse is reported naming the file', () => {
    const path = fixtureFile('initial: { a: 1\nexpect: { status: completed }\n');
    expect(() => loadFixture(path)).toThrow(new RegExp(`^${path.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: YAML: `));
  });

  test('a fixture of the wrong shape is reported in the fixture\'s own keys', () => {
    const path = fixtureFile('initial: {}\nexpect: { status: done }\n');
    expect(() => loadFixture(path)).toThrow(`${path}: expect.status: must be one of completed, no_match, failed`);
  });
});
