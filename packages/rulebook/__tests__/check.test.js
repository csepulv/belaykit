import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: { classify_item: { writes: ['classification'] } },
  actions: { flag: { writes: ['flags'] } },
  initialKeys: ['item'],
};

const CLEAN = `
version: 1
sections:
  - name: classify
    when: "true"
    needs:
      classification: classify_item
    rules:
      - when: ws.classification != null
        then: { action: flag }
`;

describe('Rulebook.check', () => {
  test('a clean file has no problems', () => {
    expect(Rulebook.check(CLEAN, registry)).toEqual([]);
  });

  test('a broken file returns the same problems the loader throws, one string each', () => {
    const broken = CLEAN.replace('classify_item', 'classify_itme').replace('action: flag', 'action: flgg');
    const thrown = (() => {
      try {
        Rulebook.fromText(broken, registry);
      } catch (error) {
        return error.message.split('\n');
      }
    })();

    expect(Rulebook.check(broken, registry)).toEqual(thrown);
    expect(thrown).toEqual([
      'section "classify" needs "classification": unknown producer "classify_itme"',
      'section "classify" rule 1: unknown action "flgg"',
    ]);
  });

  test('a schema problem is returned, not thrown', () => {
    expect(Rulebook.check(`bogus: 1\n${CLEAN}`, registry)).toEqual(['(top level): unknown key "bogus"']);
  });

  test('YAML that does not parse is returned as one problem, not thrown', () => {
    const problems = Rulebook.check('sections: [unclosed', registry);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^YAML: /);
  });

  test('a YAML alias that does not resolve is a problem in the file, not thrown', () => {
    expect(Rulebook.check('version: 1\nsections: *nope\n', registry)).toEqual([
      'YAML: Unresolved alias (the anchor must be set before the alias): nope',
    ]);
  });

  test('names inherited from Object are not registered names or shape fields', () => {
    const withShapes = { ...registry, shapes: { classification: { type: 'object', properties: { urgent: {} }, additionalProperties: false } } };

    expect(Rulebook.check(CLEAN.replace('action: flag', 'action: toString'), registry)).toEqual([
      'section "classify" rule 1: unknown action "toString"',
    ]);
    expect(Rulebook.check(CLEAN.replace('classify_item', 'hasOwnProperty'), registry)).toEqual([
      'section "classify" needs "classification": unknown producer "hasOwnProperty"',
    ]);
    expect(Rulebook.check(CLEAN.replace('ws.classification != null', 'ws.constructor.x == 1'), withShapes)).toEqual([
      'section "classify" rule 1 when: unknown ws field "constructor"',
    ]);
  });

  test('a broken registry is not a problem in the file: it throws', () => {
    expect(() => Rulebook.check(CLEAN, { producers: {} })).toThrow(TypeError);
  });
});
