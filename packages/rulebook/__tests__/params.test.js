// A rule's `then:` params are checked at load against the JSON Schema its action declares;
// an action that declares none takes none.
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

// The shape z.toJSONSchema gives z.object({ routing: z.enum(['escalate', 'hold']), note: z.string().optional() }).
const SETTLE_PARAMS = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { routing: { type: 'string', enum: ['escalate', 'hold'] }, note: { type: 'string' } },
  required: ['routing'],
  additionalProperties: false,
};

const registry = (settleParams = SETTLE_PARAMS) => ({
  producers: {},
  actions: {
    settle: { writes: ['routing'], params: settleParams, run: async (ws, { params }) => { ws.routing = params.routing; } },
    mark: { writes: ['marked'], run: async (ws) => { ws.marked = true; } },
  },
  initialKeys: ['routing', 'marked'],
});

const rulebookWith = (then) => `
version: 1
sections:
  - name: decide
    when: ws.routing == null
    rules:
      - id: urgent
        when: "true"
        then: ${then}
`;

const problemsOf = (then, registryUsed = registry()) => Rulebook.check(rulebookWith(then), registryUsed);

describe('params checked against the action\'s schema', () => {
  test('params that match load, and reach the action', async () => {
    expect(problemsOf('{ action: settle, routing: escalate, note: "from the pager" }')).toEqual([]);
  });

  test.each([
    ['a misspelled param', '{ action: settle, routng: escalate }', [
      'section "decide" rule 1 (urgent): "settle" needs param "routing"',
      'section "decide" rule 1 (urgent): param "routng" isn\'t one "settle" takes',
    ]],
    ['a value outside the enum', '{ action: settle, routing: urgent }', ['section "decide" rule 1 (urgent): param "routing" must be one of escalate, hold']],
    ['a value of the wrong type', '{ action: settle, routing: hold, note: 3 }', ['section "decide" rule 1 (urgent): param "note" must be string']],
  ])('%s is a load error naming the rule and the param', (_label, then, problems) => {
    expect(problemsOf(then)).toEqual(problems);
  });

  test('an action that declares no params takes none', () => {
    expect(problemsOf('{ action: mark }')).toEqual([]);
    expect(problemsOf('{ action: mark, color: red }')).toEqual([
      'section "decide" rule 1 (urgent): "mark" takes no params, but the rule passes "color"',
    ]);
  });

  test('a params schema without $schema is read as JSON Schema 2020-12', () => {
    const { $schema: _dropped, ...plain } = SETTLE_PARAMS;
    expect(problemsOf('{ action: settle, routing: escalate }', registry(plain))).toEqual([]);
    expect(problemsOf('{ action: settle, routing: no }', registry(plain))).toEqual(['section "decide" rule 1 (urgent): param "routing" must be one of escalate, hold']);
  });

  test('an unknown key in a nested param is named', () => {
    const nested = { type: 'object', properties: { routing: { type: 'string' }, opts: { type: 'object', properties: { loud: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false };
    expect(problemsOf('{ action: settle, routing: hold, opts: { lod: true } }', registry(nested))).toEqual(['section "decide" rule 1 (urgent): param "opts" has no key "lod"']);
  });

  test('a params schema is closed by default: an unknown param is refused even without additionalProperties: false', () => {
    const unsaid = { type: 'object', properties: { routing: { type: 'string' } } };
    expect(problemsOf('{ action: settle, routing: hold, noet: x }', registry(unsaid))).toEqual(['section "decide" rule 1 (urgent): param "noet" isn\'t one "settle" takes']);
  });

  test('closing by default respects params a composed schema allows', () => {
    const composed = { allOf: [{ type: 'object', properties: { routing: { type: 'string' } } }, { required: ['routing'] }] };
    expect(problemsOf('{ action: settle, routing: hold }', registry(composed))).toEqual([]);
    expect(problemsOf('{ action: settle, routing: hold, noet: x }', registry(composed))).toEqual(['section "decide" rule 1 (urgent): param "noet" isn\'t one "settle" takes']);
  });

  test('a params schema that opens itself (additionalProperties set) is taken as written', () => {
    const open = { type: 'object', properties: { routing: { type: 'string' } }, additionalProperties: true };
    expect(problemsOf('{ action: settle, routing: hold, noet: x }', registry(open))).toEqual([]);
  });

  test('a params schema that isn\'t valid JSON Schema is a registry problem, reported once', () => {
    const broken = { type: 'object', properties: { routing: { type: 'strng' } } };
    const problems = problemsOf('{ action: settle, routing: escalate }', registry(broken));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^action "settle" params: /);
  });
});
