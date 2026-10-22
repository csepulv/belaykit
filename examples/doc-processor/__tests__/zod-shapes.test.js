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

  test('a string compared with z.enum, a nullable z.enum or z.literal must be one of its values', () => {
    const ticket = z.object({
      status: z.enum(['open', 'closed']),
      level: z.enum(['low', 'high']).nullable(),
      kind: z.literal('memo'),
      stage: z.enum(['draft', 'final']).and(z.string().min(1)),   // an allOf: still only its enum's values
    });
    const withTicket = { ...registry, initialKeys: [...registry.initialKeys, 'ticket'], shapes: { ...registry.shapes, ticket: z.toJSONSchema(ticket) } };

    expect(Rulebook.check(rulebook('ws.ticket.status == "open" && ws.ticket.level in ["low", "high"] && ws.ticket.kind == "memo" && ws.ticket.stage == "final"'), withTicket)).toEqual([]);
    expect(Rulebook.check(rulebook('ws.ticket.status == "opne" || ws.ticket.level == "hgih" || ws.ticket.kind != "note" || ws.ticket.stage == "fnal"'), withTicket)).toEqual([
      'section "draw" when: ws.ticket.status is compared with "opne", which its shape doesn\'t allow (open, closed)',
      'section "draw" when: ws.ticket.level is compared with "hgih", which its shape doesn\'t allow (low, high)',
      'section "draw" when: ws.ticket.kind is compared with "note", which its shape doesn\'t allow (memo)',
      'section "draw" when: ws.ticket.stage is compared with "fnal", which its shape doesn\'t allow (draft, final)',
    ]);
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
