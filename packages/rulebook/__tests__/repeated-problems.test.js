// A mistake an expression makes twice is one problem for its author: it is reported once.
import { expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: {},
  actions: { settle: { writes: ['routing'], run: async () => {} } },
  initialKeys: ['routing', 'name', 'other'],
  shapes: { routing: { type: 'object', properties: { state: { type: 'string', enum: ['open'] } }, additionalProperties: false } },
};

const checkWhen = (when) => Rulebook.check(`
version: 1
sections:
  - name: decide
    when: "true"
    exhaustive: false
    rules:
      - when: '${when}'
        then: { action: settle }
`, registry);

test.each([
  ['an unknown key', 'ws.missing == 1 || ws.missing == 2', 'unknown ws field "missing"'],
  ['an unknown field', 'ws.routing.b == 1 && ws.routing.b == 2', 'unknown field "b" on ws.routing'],
  ['a compared value the shape doesn\'t allow', 'ws.routing.state == "shut" || ws.routing.state == "shut"', 'ws.routing.state is compared with "shut", which its shape doesn\'t allow (open)'],
])('%s read twice in one when is reported once', (_label, when, problem) => {
  expect(checkWhen(when)).toEqual([`section "decide" rule 1 when: ${problem}`]);
});

test('the same placeholder written twice in one templated param is reported once', () => {
  const templating = { ...registry, actions: { note: { writes: ['routing'], params: { type: 'object', properties: { text: { type: 'string' } } }, templates: ['text'], run: async () => {} } } };
  expect(Rulebook.check(`
version: 1
sections:
  - name: decide
    when: "true"
    exhaustive: false
    rules:
      - when: "true"
        then: { action: note, text: "{ws.missing} and {ws.missing}" }
`, templating)).toEqual(['section "decide" rule 1 param "text" placeholder {ws.missing}: unknown ws field "missing"']);
});

// A problem whose message doesn't say which call it is about stays one per call: two calls are two fixes.
test.each([
  ['two non-literal patterns', 'ws.name.matches(ws.routing.state) || ws.name.matches(ws.other)', 'pattern must be a string literal'],
  ['two non-literal paths, where cel-js refuses the expression too', 'belaykit.present(ws, ws.name) && belaykit.present(ws, ws.other) && app_missing()', 'belaykit.present: path must be a string literal'],
])('%s are both reported', (_label, when, problem) => {
  expect(checkWhen(when).filter((line) => line.endsWith(problem))).toHaveLength(2);
});

test('two different mistakes in one when are both reported', () => {
  expect(checkWhen('ws.missing == 1 || ws.absent == 2')).toEqual([
    'section "decide" rule 1 when: unknown ws field "missing"',
    'section "decide" rule 1 when: unknown ws field "absent"',
  ]);
});
