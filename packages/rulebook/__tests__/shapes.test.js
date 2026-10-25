// The registry's shapes: a JSON Schema per working-set key. The loader checks every field
// path a rulebook reads against them, at any depth, from ws.<key>, from a selectFirst
// binding and from a macro's variable, so a misspelled field fails at load, not in a run.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

// The shape z.toJSONSchema (zod 4.6.7) gives z.array(snippet), where snippet is
// z.object({ text, classification: classification.nullable(), error: optional, reviewed }).
const SNIPPETS = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      classification: {
        anyOf: [
          {
            type: 'object',
            properties: { topics: { type: 'array', items: { type: 'string' } }, type: { type: 'string', enum: ['note', 'task'] }, ambiguity: { type: 'string' } },
            required: ['topics', 'type', 'ambiguity'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
      },
      error: { type: 'string' },
      reviewed: { type: 'boolean' },
    },
    required: ['text', 'classification', 'reviewed'],
    additionalProperties: false,
  },
};

const registry = (shapes = { snippets: SNIPPETS }) => ({
  producers: {},
  actions: { review: { writes: ['snippets'], run: async () => {} } },
  initialKeys: ['snippets', 'meta', 'loose'],
  shapes,
});

const reviewRule = ({ when, selectFirst = '{ snippet: ws.snippets }' }) => `
version: 1
sections:
  - name: review
    when: ${JSON.stringify(when.section ?? 'ws.snippets.exists(s, !s.reviewed)')}
    exhaustive: false
    rules:
      - id: flag
        selectFirst: ${selectFirst}
        when: ${JSON.stringify(when.rule ?? '!snippet.reviewed')}
        then: { action: review }
`;

const problemsOf = (when, options = {}) => Rulebook.check(reviewRule({ when, ...options }), options.registry ?? registry());

describe('a field read through a selectFirst binding', () => {
  test('a misspelled field of the item is a load error', () => {
    expect(problemsOf({ rule: 'snippet.reviewd == false' }))
      .toEqual(['section "review" rule 1 (flag) when: unknown field "reviewd" on snippet (an item of ws.snippets)']);
  });

  test('a misspelled field deeper down, through a nullable object, is a load error', () => {
    expect(problemsOf({ rule: 'snippet.classification != null && snippet.classification.ambigity != ""' }))
      .toEqual(['section "review" rule 1 (flag) when: unknown field "ambigity" on snippet.classification']);
  });

  test('fields spelled right load, at any depth, including a literal subscript', () => {
    expect(problemsOf({ rule: 'snippet.classification != null && snippet.classification.ambiguity != "" && snippet["text"] != "" && size(snippet.classification.topics) > 0' })).toEqual([]);
  });
});

describe('a field read through a CEL macro variable', () => {
  test.each(['exists', 'all', 'exists_one', 'filter', 'map'])('in %s, a misspelled field of the item is a load error', (macro) => {
    const section = macro === 'filter' || macro === 'map' ? `size(ws.snippets.${macro}(s, s.reviewd)) > 0` : `ws.snippets.${macro}(s, s.reviewd)`;
    expect(problemsOf({ section })).toEqual([`section "review" when: unknown field "reviewd" on s (an item of ws.snippets)`]);
  });

  test('the variable means the item only inside its macro', () => {
    expect(problemsOf({ section: 'ws.snippets.exists(s, s.reviewed) && ws.snippets.all(s, s.text != "")' })).toEqual([]);
  });
});

describe('a field read from ws.<key>', () => {
  test('ws.<key>.<a>.<b> is checked at every level', () => {
    const shapes = { meta: { type: 'object', properties: { source: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } };
    const section = 'ws.meta.source.ulr != ""';
    expect(problemsOf({ section }, { registry: registry(shapes) })).toEqual(['section "review" when: unknown field "ulr" on ws.meta.source']);
  });

  test('a field read on a list, rather than on its items, is a load error', () => {
    expect(problemsOf({ section: 'ws.snippets.text != ""' })).toEqual(['section "review" when: unknown field "text" on ws.snippets (a list)']);
  });
});

describe('where checking stops', () => {
  test('an object left open (additionalProperties not false) is not checked past where it opens', () => {
    const shapes = { meta: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: {} }, loose: { type: 'object' } };
    expect(problemsOf({ section: 'ws.meta.anything == "x" && ws.loose.whatever.deep == 1' }, { registry: registry(shapes) })).toEqual([]);
  });

  test('a key without a shape is not checked past the key', () => {
    expect(problemsOf({ section: 'ws.loose.whatever == 1 && ws.snippets.exists(s, s.text != "")' })).toEqual([]);
  });

  test('a local $ref is followed', () => {
    const shapes = { meta: { $defs: { source: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } }, type: 'object', properties: { source: { $ref: '#/$defs/source' } }, additionalProperties: false } };
    expect(problemsOf({ section: 'ws.meta.source.ulr != ""' }, { registry: registry(shapes) })).toEqual(['section "review" when: unknown field "ulr" on ws.meta.source']);
  });
});

describe('shapes the walk must not misread (review)', () => {
  test('a keyword ajv doesn\'t know (zod\'s .meta() copies its keys) is allowed in a shape and in params', () => {
    const meta = { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false, custom: 1 };
    const withMeta = { ...registry({ meta }), actions: { review: { writes: ['snippets'], params: { type: 'object', properties: {}, toolHint: 'x' }, run: async () => {} } } };
    expect(problemsOf({ section: 'ws.meta.url != ""' }, { registry: withMeta })).toEqual([]);
  });

  test('a tuple\'s prefixItems describe their own indexes; items, the rest', () => {
    // z.toJSONSchema(z.tuple([z.object({ a }), z.object({ b })], z.object({ c })))
    const pair = (name) => ({ type: 'object', properties: { [name]: { type: 'string' } }, additionalProperties: false });
    const meta = { type: 'array', prefixItems: [pair('a'), pair('b')], items: pair('c') };
    const check = (section) => problemsOf({ section }, { registry: registry({ meta }) });
    expect(check('ws.meta[0].a != "" && ws.meta[1].b != "" && ws.meta[2].c != ""')).toEqual([]);
    expect(check('ws.meta[0].b != ""')).toEqual(['section "review" when: unknown field "b" on ws.meta[0]']);
  });

  test('unevaluatedProperties doesn\'t close an object for the check (if/then and dependentSchemas can add fields)', () => {
    const meta = { type: 'object', properties: { kind: { type: 'string' } }, if: { properties: { kind: { const: 'x' } } }, then: { properties: { extra: { type: 'string' } } }, unevaluatedProperties: false };
    expect(problemsOf({ section: 'ws.meta.extra == "x"' }, { registry: registry({ meta }) })).toEqual([]);
  });

  test('a shape that refers to itself through a union doesn\'t overflow the check', () => {
    const meta = { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { $ref: '#' }] };
    expect(() => problemsOf({ section: 'ws.meta.b == ""' }, { registry: registry({ meta }) })).not.toThrow();
  });

});

describe('the registry\'s shapes themselves', () => {
  test.each([['a string', 'x'], ['null', null], ['a list', [SNIPPETS]]])('shapes that are %s are a registry problem', (_label, shapes) => {
    expect(Rulebook.check(reviewRule({ when: {} }), registry(shapes))).toEqual(['shapes: must be an object of JSON Schemas, one per ws key']);
  });

  test('a shape in another draft of JSON Schema is refused, saying which draft BelayKit reads', () => {
    const problems = Rulebook.check(reviewRule({ when: {} }), registry({ meta: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' } }));
    expect(problems).toEqual(['shapes "meta": must be JSON Schema draft 2020-12 (or have no $schema)']);
  });

  test('a shape for a key nothing declares is a registry problem', () => {
    const problems = Rulebook.check(reviewRule({ when: {} }), registry({ snippets: SNIPPETS, snipets: SNIPPETS }));
    expect(problems).toEqual(['shapes "snipets": no initial key, needs key or writes declares that key']);
  });

  test('a shape that isn\'t valid JSON Schema is a registry problem', () => {
    const problems = Rulebook.check(reviewRule({ when: {} }), registry({ meta: { type: 'objct' } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^shapes "meta": /);
  });

  test('a registry key the plugin doesn\'t read is refused, so a leftover fields isn\'t ignored', () => {
    const problems = Rulebook.check(reviewRule({ when: {} }), { ...registry(), fields: { snippets: ['text'] } });
    expect(problems).toEqual(['registry: unknown key "fields" (keys: producers, actions, functions, version, initialKeys, shapes)']);
  });
});

// A string literal compared with a field whose shape lists its values (`enum`, `const`) must be
// one of them, so a typo in a compared value fails at load instead of never matching.
describe('a string literal compared with a field that allows only certain values', () => {
  const META = {
    type: 'object',
    properties: { status: { type: 'string', enum: ['open', 'closed'] }, kind: { const: 'memo' }, note: { type: 'string' } },
    additionalProperties: false,
  };
  const withMeta = registry({ snippets: SNIPPETS, meta: META });
  const ruleProblems = (rule) => problemsOf({ rule: `!snippet.reviewed && ${rule}` }, { registry: withMeta });
  const place = 'section "review" rule 1 (flag) when';

  test.each([
    ['==', 'ws.meta.status == "opne"', 'opne'],
    ['!=', 'ws.meta.status != "opne"', 'opne'],
    ['== with the literal first', '"opne" == ws.meta.status', 'opne'],
    ['in a list', 'ws.meta.status in ["open", "clsoed"]', 'clsoed'],
  ])('through %s, a value the enum lacks is a load error', (_label, rule, value) => {
    expect(ruleProblems(rule)).toEqual([`${place}: ws.meta.status is compared with "${value}", which its shape doesn't allow (open, closed)`]);
  });

  test('a const allows its one value', () => {
    expect(ruleProblems('ws.meta.kind == "note"')).toEqual([`${place}: ws.meta.kind is compared with "note", which its shape doesn't allow (memo)`]);
    expect(ruleProblems('ws.meta.kind == "memo"')).toEqual([]);
  });

  test('through a selectFirst binding, a nullable enum (as zod writes it) is checked', () => {
    expect(ruleProblems('snippet.classification.type == "nte"'))
      .toEqual([`${place}: snippet.classification.type is compared with "nte", which its shape doesn't allow (note, task)`]);
  });

  test('through a CEL macro variable, the item\'s enum is checked', () => {
    expect(problemsOf({ section: 'ws.snippets.exists(s, s.classification.type == "tsk")' }, { registry: withMeta }))
      .toEqual(['section "review" when: s.classification.type is compared with "tsk", which its shape doesn\'t allow (note, task)']);
  });

  test('values the shape allows, a field that doesn\'t restrict its values, and a key without a shape load as before', () => {
    expect(ruleProblems('ws.meta.status == "open" && "closed" != ws.meta.status && ws.meta.status in ["open", "closed"]')).toEqual([]);
    expect(ruleProblems('ws.meta.note == "anything"')).toEqual([]);
    expect(ruleProblems('ws.loose.status == "anything"')).toEqual([]);
  });

  test('a misspelled field is reported once, as an unknown field, not also as a compared value', () => {
    expect(ruleProblems('ws.meta.statsu == "open"')).toEqual([`${place}: unknown field "statsu" on ws.meta`]);
  });

  test('a value repeated in an in-list is reported once', () => {
    expect(ruleProblems('ws.meta.status in ["opne", "opne"]'))
      .toEqual([`${place}: ws.meta.status is compared with "opne", which its shape doesn't allow (open, closed)`]);
  });

  // `allOf` is an intersection, so a branch that doesn't restrict values doesn't lift another's restriction.
  describe('combined schemas', () => {
    const problemsFor = (status, rule) => Rulebook.check(
      reviewRule({ when: { rule: `!snippet.reviewed && ${rule}` } }),
      registry({ snippets: SNIPPETS, meta: { type: 'object', properties: { status }, additionalProperties: false } }),
    );
    const refused = (value, allowed) => [`${place}: ws.meta.status is compared with "${value}", which its shape doesn't allow (${allowed})`];

    test('allOf with an enum and an unrestricted branch (as zod writes .and()) is checked', () => {
      const status = { allOf: [{ type: 'string', enum: ['open', 'closed'] }, { type: 'string', minLength: 1 }] };
      expect(problemsFor(status, 'ws.meta.status == "opne"')).toEqual(refused('opne', 'open, closed'));
      expect(problemsFor(status, 'ws.meta.status == "open"')).toEqual([]);
    });

    test('allOf of two enums allows only the values both allow', () => {
      const status = { allOf: [{ enum: ['a', 'b'] }, { enum: ['b', 'c'] }] };
      expect(problemsFor(status, 'ws.meta.status == "a"')).toEqual(refused('a', 'b'));
      expect(problemsFor(status, 'ws.meta.status == "b"')).toEqual([]);
    });

    test('a schema\'s own type beside anyOf branches with enums is checked against the branches', () => {
      const status = { type: 'string', anyOf: [{ enum: ['a'] }, { enum: ['b'] }] };
      expect(problemsFor(status, 'ws.meta.status == "c"')).toEqual(refused('c', 'a, b'));
      expect(problemsFor(status, 'ws.meta.status in ["a", "b"]')).toEqual([]);
    });

    test('anyOf with an unrestricted branch allows any string', () => {
      const status = { anyOf: [{ enum: ['a'] }, { type: 'string' }] };
      expect(problemsFor(status, 'ws.meta.status == "c"')).toEqual([]);
    });
  });
});
