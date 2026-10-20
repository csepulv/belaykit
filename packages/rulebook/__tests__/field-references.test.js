import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: { classify_item: { writes: ['classification'] } },
  actions: { flag: { writes: ['flags'] } },
  initialKeys: ['item', 'flags'],
  shapes: { classification: { type: 'object', properties: { projects: {}, ambiguity: {} }, additionalProperties: false } },
};

const rulebookWith = (when) => `
version: 1
sections:
  - name: classify
    when: "true"
    needs:
      classification: classify_item
    rules:
      - when: '${when}'
        then: { action: flag }
`;

const errorsOf = (when) => {
  try {
    Rulebook.fromText(rulebookWith(when), registry);
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

describe('field references are read from the syntax tree', () => {
  test('a subscript with a literal key is checked like a dotted reference', () => {
    expect(errorsOf('ws["clasification"] != null')).toEqual(['section "classify" rule 1 when: unknown ws field "clasification"']);
    expect(errorsOf('ws["classification"] != null')).toEqual([]);
  });

  test('a reference spelled inside a string literal is not a reference', () => {
    expect(errorsOf('ws.item == "ws.clasification"')).toEqual([]);
  });

  test('a nested subscript is checked against the key\'s shape', () => {
    expect(errorsOf('ws.classification["ambigity"] != null')).toEqual([
      'section "classify" rule 1 when: unknown field "ambigity" on ws.classification',
    ]);
    expect(errorsOf('ws["classification"].ambiguity != null')).toEqual([]);
  });

  test('a computed subscript is not checked', () => {
    expect(errorsOf('ws[ws.item] != null')).toEqual([]);
  });

  test('a macro variable is not a ws reference', () => {
    expect(errorsOf('ws.classification.projects.exists(p, p.clasification == "x")')).toEqual([]);
  });

  test('references inside macros and calls are still checked', () => {
    expect(errorsOf('ws.classification.projects.exists(p, p in ws.known_slugs)')).toEqual([
      'section "classify" rule 1 when: unknown ws field "known_slugs"',
    ]);
  });
});
