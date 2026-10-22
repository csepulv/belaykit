// Each problem is reported where it is, once, in a line an author can read: one mistake doesn't add a
// second, misleading one, and doesn't hide an unrelated one.
import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

const settle = { writes: ['routing'], params: { type: 'object', properties: { note: { type: 'string' } } }, run: async (ws) => { ws.routing = 1; } };
const registry = { producers: {}, actions: { settle }, initialKeys: ['routing', 'items', 'flag', 'item'] };
const sections = (body) => `version: 1\nsections:\n${body}`;
const oneRule = (rule, when = '"true"') => sections(`  - name: decide\n    when: ${when}\n    exhaustive: false\n    rules:\n${rule}`);

describe('at load', () => {
  test('a selectFirst binding named belaykit is refused, and its when adds no problem of its own', () => {
    expect(Rulebook.check(oneRule('      - selectFirst: { belaykit: ws.items }\n        when: belaykit == 1\n        then: { action: settle }\n'), registry))
      .toEqual(['section "decide" rule 1 selectFirst: binding "belaykit" is reserved for BelayKit\'s helpers']);
  });

  test('a real problem in that rule\'s when is still reported beside it', () => {
    expect(Rulebook.check(oneRule('      - selectFirst: { belaykit: ws.items }\n        when: belaykit == 1 && ws.missing == 1\n        then: { action: settle }\n'), registry)).toEqual([
      'section "decide" rule 1 selectFirst: binding "belaykit" is reserved for BelayKit\'s helpers',
      'section "decide" rule 1 when: unknown ws field "missing"',
    ]);
  });

  test('a brace in a param is reported beside an action key problem that has nothing to do with templates', () => {
    const withStore = { ...registry, actions: { settle: { ...settle, store: 'db' } } };
    expect(Rulebook.check(oneRule('      - when: "true"\n        then: { action: settle, note: "{ws.item}" }\n'), withStore)).toEqual([
      'action "settle": unknown key "store" (keys: writes, params, templates, guard, run; pass dependencies through deps)',
      'section "decide" rule 1: param "note" has a brace, but "settle" doesn\'t template "note"',
    ]);
  });

  test('a brace stays unreported when an unknown key lists that param: a misspelled templates explains it', () => {
    const misspelled = { ...registry, actions: { settle: { ...settle, template: ['note'] } } };
    expect(Rulebook.check(oneRule('      - when: "true"\n        then: { action: settle, note: "{ws.item}" }\n'), misspelled))
      .toEqual(['action "settle": unknown key "template" (keys: writes, params, templates, guard, run; pass dependencies through deps)']);
  });
});

describe('at run time', () => {
  const errorOf = async (text) => (await new Agent({
    initializer: () => ({ items: [] }),
    choiceProvider: Rulebook.fromText(text, registry).provider(),
    finishChecker: (ws) => ws.routing === 1,
  }).run()).error.message;

  test.each([
    ['a section\'s', oneRule('      - when: "true"\n        then: { action: settle }\n', 'ws.flag == 1'), 'iteration 1 choiceProvider failed: section "decide" when failed: No such key: flag'],
    ['a rule\'s', oneRule('      - when: ws.flag == 1\n        then: { action: settle }\n'), 'decide/decide#1 criteria failed: No such key: flag'],
  ])('%s when that fails gives a one-line message, without cel-js\'s source excerpt', async (_label, text, message) => {
    expect(await errorOf(text)).toBe(message);
  });
});
