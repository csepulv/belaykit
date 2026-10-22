import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: { classify_item: { writes: ['classification'] }, find_agent_row: { writes: ['existing_row'] } },
  actions: {
    flag_ambiguity: { writes: ['flags'] },
    create_and_finalize: { writes: ['write'] },
  },
  functions: [{ signature: 'is_blank(string): bool', handler: (text) => !text.trim() }],
  initialKeys: ['item', 'known_slugs', 'flags'],
};

const VALID = `
version: 1
hitPolicyDefault: FIRST
sections:
  - name: classify
    when: ws.write == null && !has(ws.classification)
    needs:
      classification: classify_item
    hitPolicy: ALL
    rules:
      - when: '!is_blank(ws.classification.ambiguity)'
        then: { action: flag_ambiguity }
        why: ambiguous
      - when: "true"
        then: { action: create_and_finalize }
`;

const errorsOf = (text) => {
  try {
    Rulebook.fromText(text, registry);
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

describe('Rulebook.fromText', () => {
  test('a valid rulebook loads, with sections compiled and declared keys collected', () => {
    const rulebook = Rulebook.fromText(VALID, registry);

    expect(rulebook.sections.map((section) => section.name)).toEqual(['classify']);
    expect(rulebook.sections[0].hitPolicy).toBe('ALL');
    expect(rulebook.declaredKeys).toEqual(['classification']);
  });

  test('an unknown top-level key is rejected by the schema, naming the key', () => {
    expect(errorsOf(`bogusKey: 1\n${VALID}`).join('\n')).toMatch(/bogusKey/);
  });

  test('an unregistered action is rejected, naming the section, rule and action', () => {
    const errors = errorsOf(VALID.replace('create_and_finalize', 'create_and_finalise'));

    expect(errors).toContain('section "classify" rule 2: unknown action "create_and_finalise"');
  });

  test('an unregistered producer is rejected', () => {
    expect(errorsOf(VALID.replace('classify_item', 'classify_itme'))).toContain('section "classify" needs "classification": unknown producer "classify_itme"');
  });

  test('a misspelled ws field is rejected — the field-reference rule', () => {
    const errors = errorsOf(VALID.replace('ws.classification.ambiguity', 'ws.clasification.ambiguity'));

    expect(errors).toContain('section "classify" rule 1 when: unknown ws field "clasification"');
  });

  test('a CEL syntax error is rejected, naming the when', () => {
    const errors = errorsOf(VALID.replace("'!is_blank(ws.classification.ambiguity)'", '"ws.classification &&"'));

    expect(errors.join('\n')).toMatch(/section "classify" rule 1 when: /);
  });

  test('an unknown function is rejected at load by CEL type-checking', () => {
    const errors = errorsOf(VALID.replace('is_blank(', 'is_blnk('));

    expect(errors.join('\n')).toMatch(/section "classify" rule 1 when: .*is_blnk/);
  });

  test('a misspelled nested field is rejected when the registry gives the key a shape', () => {
    const withShapes = { ...registry, shapes: { classification: { type: 'object', properties: { projects: {}, ambiguity: {} }, additionalProperties: false } } };
    const broken = VALID.replace('ws.classification.ambiguity', 'ws.classification.ambigity');

    expect(() => Rulebook.fromText(broken, withShapes)).toThrow('section "classify" rule 1 when: unknown field "ambigity" on ws.classification');
    expect(() => Rulebook.fromText(VALID, withShapes)).not.toThrow();
  });

  test('nested fields of keys without a shape are not checked', () => {
    expect(() => Rulebook.fromText(VALID.replace('ws.classification.ambiguity', 'ws.classification.anything'), registry)).not.toThrow();
  });

  test('every problem is reported, not just the first', () => {
    const broken = VALID.replace('create_and_finalize', 'nope').replace('classify_item', 'nada');

    expect(errorsOf(broken)).toHaveLength(2);
  });
});

test('a schema error names its place in the rulebook\'s own words', () => {
  const text = VALID.replace('      - when: "true"', '      - when: 3');

  expect(errorsOf(text)).toEqual(['section "classify" rule 2 when: must be string']);
});
