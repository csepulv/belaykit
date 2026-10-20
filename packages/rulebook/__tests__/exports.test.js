import { describe, expect, test } from 'vitest';
import { Agent, always, chain } from '@belaykit/core';
import * as rulebookPackage from '@belaykit/rulebook';

// Imported by package name, so this goes through the exports maps a consumer uses.
const { Rulebook } = rulebookPackage;

const RULEBOOK = `
version: 1
sections:
  - name: lookup
    when: ws.write == null && ws.existing_row == null
    needs:
      existing_row: find_row
  - name: judge
    when: ws.write == null && ws.existing_row != null
    rules:
      - when: "true"
        then: { action: finalize, write: updated }
`;

const makeRegistry = (row) => ({
  producers: { find_row: { writes: ['existing_row'], run: async () => row } },
  actions: { finalize: { writes: ['write'], params: { type: 'object', properties: { write: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.write = params.write; } } },
  initialKeys: ['item'],
});

// The gap the rulebook leaves: no row found. A code provider handles it.
const createProvider = async () => ({
  name: 'create',
  mode: 'first',
  choices: [{ name: 'create', criteria: always, actions: [async (ws) => { ws.write = 'created'; }] }],
});

function runAgent(row) {
  const rulebook = Rulebook.fromText(RULEBOOK, makeRegistry(row));
  return new Agent({
    initializer: (subject) => rulebook.initialize({ ...subject, write: null }),
    choiceProvider: chain([rulebook.provider(), createProvider]),
    finishChecker: (ws) => ws.write !== null,
  }).run({ item: 'x' });
}

const firedBySet = (trace) => trace.map(({ set, fired }) => `${set}:${fired.join(',')}`);

test('the package entry exports the public API', () => {
  expect(Object.keys(rulebookPackage).sort()).toEqual(['Rulebook', 'describeFunctions', 'loadFixture']);
});

describe('a checked rulebook runs on the core, chained with a code provider', () => {
  test('the rulebook gathers, then judges', async () => {
    const outcome = await runAgent('row-1');

    expect(outcome.status).toBe('completed');
    expect(outcome.workingSet).toMatchObject({ existing_row: 'row-1', write: 'updated', gathered: ['existing_row'] });
    expect(firedBySet(outcome.trace)).toEqual(['lookup:gather existing_row', 'judge:judge#1']);
  });

  test('the code provider takes the gap the rulebook leaves', async () => {
    const outcome = await runAgent(null);

    expect(outcome.status).toBe('completed');
    expect(outcome.workingSet).toMatchObject({ existing_row: null, write: 'created' });
    expect(firedBySet(outcome.trace)).toEqual(['lookup:gather existing_row', 'create:create']);
  });
});

// A triage rulebook and its registry, written the way the docs teach.
const TRIAGE_RULEBOOK = `# triage.rules.yaml
version: 1
sections:
  - name: gather
    when: '!("classification" in ws.gathered)'
    needs: { classification: classify_item }        # a producer fills ws.classification
  - name: decide
    when: ws.routing == null
    hitPolicy: FIRST                                 # FIRST: the first rule that holds; ALL: every rule that holds
    rules:
      - id: urgent
        when: ws.classification.urgent == true
        then: { action: settle, routing: escalate }  # \`routing\` is a param for the action
        why: urgent items go to a person
      - id: fallback
        when: "true"
        then: { action: settle, routing: hold }
`;

describe('a triage registry and rulebook, as the docs teach them', () => {
  const registry = {
    producers: { classify_item: { writes: ['classification'], run: async (ws, deps) => deps.classify(ws.item) } },
    actions: { settle: { writes: ['routing'], params: { type: 'object', properties: { routing: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.routing = params.routing; } } },
    initialKeys: ['item', 'routing'],
  };

  const triage = (subject, deps) => {
    const rules = Rulebook.fromText(TRIAGE_RULEBOOK, registry);
    const agent = new Agent({
      initializer: (subject) => rules.initialize({ item: subject, routing: null }),
      choiceProvider: rules.provider(deps),               // deps reach producers and actions
      finishChecker: (ws) => ws.routing !== null,
      finalizer: (ws) => ({ routing: ws.routing }),
    });
    return agent.run(subject);
  };

  test('escalates an urgent item and holds the rest', async () => {
    const classify = async (item) => ({ urgent: item.includes('down') });
    const urgent = await triage('server down', { classify });
    const routine = await triage('new laptop', { classify });

    expect(urgent).toMatchObject({ status: 'completed', result: { routing: 'escalate' } });
    expect(urgent.trace.flatMap((entry) => entry.fired)).toEqual(['gather classification', 'urgent']);
    expect(routine).toMatchObject({ status: 'completed', result: { routing: 'hold' } });
  });
});
