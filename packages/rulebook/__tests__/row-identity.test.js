import { expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

// Every rule has an identity: its optional `id`, or `<section>#<n>`.
const registry = {
  producers: {},
  actions: { finalize: { writes: ['write'], params: { type: 'object', properties: { write: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.write = params.write; } } },
  initialKeys: ['found'],
};

const finalizeSection = (rows) => `
version: 1
sections:
  - name: finalize
    when: ws.write == null
    rules:
${rows.join('\n')}
`;
const row = ({ id, when, write, why }) => [
  `      - when: ${JSON.stringify(when)}`,
  id ? `        id: ${id}` : null,
  `        then: { action: finalize, write: ${write} }`,
  why ? `        why: ${why}` : null,
].filter(Boolean).join('\n');

const errorsOf = (text) => {
  try {
    Rulebook.fromText(text, registry);
    return [];
  } catch (error) {
    return error.message.split('\n');
  }
};

async function choicesFor(text, ws) {
  const rulebook = Rulebook.fromText(text, registry);
  return (await rulebook.provider()(rulebook.initialize({ write: null, ...ws }))).choices;
}

function runRulebook(text, request) {
  const rulebook = Rulebook.fromText(text, registry);
  return new Agent({
    initializer: (r) => rulebook.initialize({ ...r, write: null }),
    choiceProvider: rulebook.provider(),
    finishChecker: async (ws) => ws.write !== null,
  }).run(request);
}

test('rows without an id are named <section>#<n>, counting from 1', async () => {
  const text = finalizeSection([row({ when: 'ws.found', write: 'updated' }), row({ when: 'true', write: 'created' })]);

  expect((await choicesFor(text, { found: false })).map((choice) => choice.name)).toEqual(['finalize#1', 'finalize#2']);
});

test('a row with an id is named by it, and carries its why on the choice', async () => {
  const text = finalizeSection([
    row({ when: 'ws.found', write: 'updated' }),
    row({ id: 'created_default', when: 'true', write: 'created', why: 'fallback' }),
  ]);
  const choices = await choicesFor(text, { found: false });

  expect(choices.map(({ name, why }) => ({ name, why }))).toEqual([{ name: 'finalize#1', why: undefined }, { name: 'created_default', why: 'fallback' }]);
});

test('two rows with the same action run, and the trace says which fired', async () => {
  const text = finalizeSection([row({ when: 'ws.found', write: 'updated' }), row({ when: 'true', write: 'created' })]);
  const outcome = await runRulebook(text, { found: false });

  expect(outcome.status).toBe('completed');
  expect(outcome.workingSet.write).toBe('created');
  expect(outcome.trace.map(({ fired }) => fired)).toEqual([['finalize#2']]);
});

test('an explicit id keeps its name when a row is inserted above it', async () => {
  const named = row({ id: 'created_default', when: 'true', write: 'created' });
  const before = await runRulebook(finalizeSection([named]), { found: false });
  const after = await runRulebook(finalizeSection([row({ when: 'ws.found', write: 'updated' }), named]), { found: false });

  expect([before.trace[0].fired, after.trace[0].fired]).toEqual([['created_default'], ['created_default']]);
});

test('two rows sharing an id in a section are refused at load, naming both rows', () => {
  const text = finalizeSection([row({ id: 'same', when: 'ws.found', write: 'updated' }), row({ id: 'same', when: 'true', write: 'created' })]);

  expect(errorsOf(text)).toContain('section "finalize" rules 1 and 2 share id "same"');
});

test('an id that does not match the section-name pattern is refused by the schema', () => {
  for (const id of ['"has#hash"', 'Upper', '"9lead"']) {
    const errors = errorsOf(finalizeSection([row({ id, when: 'true', write: 'created' })]));

    expect(errors.join('\n')).toMatch(/section "finalize" rule 1 id: must match pattern/);
  }
});
