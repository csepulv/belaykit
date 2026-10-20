import { describe, expect, test } from 'vitest';
import { Agent, chain } from '@belaykit/core';
import { Rulebook } from '../index.js';

// A `when` decides whether a section claims the working set or a row matches, so it must
// be a boolean: refused at load when its type is known and isn't `bool`, and a failed run
// when a `dyn` expression evaluates to anything else. Never a silent "no match".
const registry = {
  producers: {},
  actions: { finalize: { writes: ['decision'], params: { type: 'object', properties: { decision: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.decision = params.decision; } } },
  functions: [{ signature: 'label_of(map): string', handler: () => 'x' }],
  initialKeys: ['label', 'flag'],
};

const judge = (sectionWhen, rows) => `
version: 1
sections:
  - name: judge
    when: ${JSON.stringify(sectionWhen)}
    rules:
${rows.map(([when, decision]) => `      - when: ${JSON.stringify(when)}\n        then: { action: finalize, decision: ${decision} }`).join('\n')}
`;

const errorsOf = (text) => {
  try {
    Rulebook.fromText(text, registry);
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

const codeProvider = async () => ({
  name: 'code', mode: 'first',
  choices: [{ name: 'code-finalize', criteria: async () => ({ matched: true }), actions: [async (ws) => { ws.decision = 'from-code'; }] }],
});

function run(text, request, { withCode = false } = {}) {
  const rulebook = Rulebook.fromText(text, registry);
  const provider = rulebook.provider();
  return new Agent({
    initializer: (r) => rulebook.initialize({ ...r, decision: null }),
    choiceProvider: withCode ? chain([provider, codeProvider]) : provider,
    finishChecker: async (ws) => ws.decision !== null,
  }).run(request);
}

describe('at load, a predicate of a known non-boolean type is refused', () => {
  const cases = [['"yes"', 'string'], ['1', 'int'], ['1.5', 'double'], ['[true]', 'list<bool>'], ['{"a": true}', 'map<string, bool>'], ['label_of(ws)', 'string']];

  test.each(cases)('a rule `when: %s` is refused as %s, naming the section and row', (when, type) => {
    expect(errorsOf(judge('ws.decision == null', [[when, 'act'], ['true', 'close']])))
      .toContain(`section "judge" rule 1 when: has type ${type}, expected bool`);
  });

  test('a section `when` of a known non-boolean type is refused, naming the section', () => {
    expect(errorsOf(judge('"yes"', [['true', 'close']]))).toContain('section "judge" when: has type string, expected bool');
  });

  test('bool and dyn predicates load', () => {
    expect(errorsOf(judge('ws.decision == null', [['ws.flag', 'act'], ['has(ws.label) && ws.label == "a"', 'other'], ['true', 'close']]))).toEqual([]);
  });
});

describe('at run time, a dyn predicate that is not a boolean fails the run', () => {
  test('a row that evaluates to a string fails the run, naming the section, row and type, instead of letting the fallback fire', async () => {
    const outcome = await run(judge('ws.decision == null', [['ws.label', 'act'], ['true', 'close']]), { label: 'abc' });

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/judge\/judge#1 criteria failed: when evaluated to string, expected a boolean/);
    expect(outcome.workingSet.decision).toBeNull();
    expect(outcome.trace.at(-1)).toMatchObject({ failed: true, evaluated: [{ choice: 'judge#1', error: 'when evaluated to string, expected a boolean' }] });
  });

  test('a section `when` that evaluates to a string fails the run, naming the section', async () => {
    const outcome = await run(judge('ws.label', [['true', 'close']]), { label: 'abc' });

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/section "judge" when failed: when evaluated to string, expected a boolean/);
  });

  test('chained before a code provider, a non-boolean section `when` fails the run rather than handing off', async () => {
    const outcome = await run(judge('ws.label', [['true', 'close']]), { label: 'abc' }, { withCode: true });

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/section "judge" when failed: when evaluated to string, expected a boolean/);
    expect(outcome.workingSet.decision).toBeNull();
  });

  test('a load-time refusal names a row by its id as well as its position', () => {
    const text = `
version: 1
sections:
  - name: judge
    when: ws.decision == null
    rules:
      - when: "true"
        then: { action: finalize, decision: first }
      - id: created_default
        when: '"yes"'
        then: { action: finalize, decision: second }
`;
    expect(errorsOf(text)).toContain('section "judge" rule 2 (created_default) when: has type string, expected bool');
  });

  test('null, a number and a list are named by type too', async () => {
    for (const [value, type] of [[null, 'null'], [3, 'double'], [['x'], 'list']]) {
      const outcome = await run(judge('ws.decision == null', [['ws.label', 'act'], ['true', 'close']]), { label: value });

      expect(outcome.error.message).toMatch(new RegExp(`when evaluated to ${type}, expected a boolean`));
    }
  });

  test('a boolean dyn predicate runs as before', async () => {
    const outcome = await run(judge('ws.decision == null', [['ws.flag', 'act'], ['true', 'close']]), { flag: true });

    expect(outcome).toMatchObject({ status: 'completed', workingSet: { decision: 'act' } });
  });
});
