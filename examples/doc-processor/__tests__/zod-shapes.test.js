// What zod 4's z.toJSONSchema writes works unchanged as a rulebook shape and as an
// action's params, including what .meta() adds and tuples with a rest element.
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { Rulebook } from '@belaykit/rulebook';

const point = z.object({ x: z.number(), y: z.number() }).meta({ title: 'Point', custom: 'for a tool-calling API' });
const trail = z.tuple([point], z.object({ label: z.string() }));

const registry = {
  producers: {},
  actions: { mark: { writes: ['marked'], params: z.toJSONSchema(z.object({ color: z.enum(['red', 'blue']) }).meta({ custom: 1 })), run: async () => {} } },
  initialKeys: ['origin', 'trail', 'marked'],
  shapes: { origin: z.toJSONSchema(point), trail: z.toJSONSchema(trail) },
};

const rulebook = (when, then = '{ action: mark, color: red }') => `
version: 1
sections:
  - name: draw
    when: ${JSON.stringify(when)}
    rules:
      - when: "true"
        then: ${then}
`;

describe('zod output as shapes and params', () => {
  test('a schema with .meta() keys loads, and its fields are checked', () => {
    expect(Rulebook.check(rulebook('ws.origin.x > 0.0 && ws.marked == null'), registry)).toEqual([]);
    expect(Rulebook.check(rulebook('ws.origin.z > 0.0'), registry)).toEqual(['section "draw" when: unknown field "z" on ws.origin']);
  });

  test('a tuple\'s first element and its rest are each their own shape', () => {
    expect(Rulebook.check(rulebook('ws.trail[0].x > 0.0 && ws.trail[1].label != ""'), registry)).toEqual([]);
    expect(Rulebook.check(rulebook('ws.trail[0].label != ""'), registry)).toEqual(['section "draw" when: unknown field "label" on ws.trail[0]']);
  });

  test('params from zod are checked, .meta() and all', () => {
    expect(Rulebook.check(rulebook('true', '{ action: mark, color: green }'), registry)).toEqual(['section "draw" rule 1: param "color" must be one of red, blue']);
  });

  test('checking writes nothing to the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    Rulebook.check(rulebook('ws.trail[0].x > 0.0'), { ...registry, shapes: { ...registry.shapes, origin: { type: 'array', prefixItems: [{ type: 'string' }] } } });
    expect([...warn.mock.calls, ...log.mock.calls]).toEqual([]);
    warn.mockRestore();
    log.mockRestore();
  });
});
