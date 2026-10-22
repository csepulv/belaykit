import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

// A row selects one item with `selectFirst`: the first item, in list order, for which
// its `when` holds. Its action receives the item, and the trace says which one.
const TABLE = `
version: 1
sections:
  - name: nodes
    when: ws.status == null
    exhaustive: false
    rules:
      - id: probe_unknown
        selectFirst: { node: ws.nodes }
        when: node.status == "open" && node.fact == "unknown"
        then: { action: probe }
        why: examine the first open node nobody has settled
      - id: close
        when: ws.nodes.all(n, n.status == "settled")
        then: { action: close }
`;

const NODES = [
  { id: 'a', status: 'settled', fact: 'yes' },
  { id: 'b', status: 'open', fact: 'unknown' },
  { id: 'c', status: 'open', fact: 'unknown' },
];

// The working set is replaced, never mutated: probe settles the node at the selected index.
const makeRegistry = (probed = []) => ({
  producers: {},
  actions: {
    probe: {
      writes: ['nodes'],
      run: async (ws, { selected }) => {
        probed.push(selected);
        ws.nodes = ws.nodes.map((node, index) => (index === selected.index ? { ...node, status: 'settled', fact: 'no' } : node));
      },
    },
    close: { writes: ['status'], run: async (ws) => { ws.status = 'closed'; } },
  },
  functions: [{ signature: 'app_open(string): bool', handler: (status) => status === 'open' }],
  initialKeys: ['nodes', 'status', 'pattern'],
});

const runTable = (text, nodes, registry = makeRegistry()) => {
  const rulebook = Rulebook.fromText(text, registry);
  return new Agent({
    initializer: () => rulebook.initialize({ nodes, status: null }),
    choiceProvider: rulebook.provider(),
    finishChecker: async (ws) => ws.status !== null,
  }).run();
};

describe('a row that selects an item', () => {
  test('acts on the first matching item each step, in list order, until the case closes', async () => {
    const probed = [];
    const outcome = await runTable(TABLE, NODES, makeRegistry(probed));

    expect(outcome.status).toBe('completed');
    expect(probed).toEqual([
      { name: 'node', item: NODES[1], index: 1 },
      { name: 'node', item: NODES[2], index: 2 },
    ]);
    expect(outcome.trace.map(({ fired }) => fired)).toEqual([['probe_unknown'], ['probe_unknown'], ['close']]);
  });

  test('the default trace records which item each step selected', async () => {
    const outcome = await runTable(TABLE, NODES);

    expect(outcome.trace[0].evaluated).toEqual([
      { choice: 'probe_unknown', matched: true, why: 'examine the first open node nobody has settled', detail: { node: 1 } },
    ]);
    expect(outcome.trace[1].evaluated[0].detail).toEqual({ node: 2 });
    expect(outcome.trace[2].evaluated[0]).toEqual({ choice: 'probe_unknown', matched: false, why: 'examine the first open node nobody has settled' });
  });

  test('no matching item means the row does not match', async () => {
    const settled = NODES.map((node) => ({ ...node, status: 'settled' }));
    const outcome = await runTable(TABLE, settled);

    expect(outcome.trace.map(({ fired }) => fired)).toEqual([['close']]);
  });

  test('under ALL, each selecting row binds its own first match', async () => {
    const both = `
version: 1
sections:
  - name: nodes
    when: ws.status == null
    hitPolicy: ALL
    rules:
      - id: probe_unknown
        selectFirst: { node: ws.nodes }
        when: node.fact == "unknown"
        then: { action: probe }
      - id: probe_any_open
        selectFirst: { candidate: ws.nodes }
        when: app_open(candidate.status)
        then: { action: probe }
      - id: close
        when: ws.nodes.all(n, n.status == "settled")
        then: { action: close }
`;
    const probed = [];
    await runTable(both, NODES, makeRegistry(probed));

    expect(probed.slice(0, 2)).toEqual([
      { name: 'node', item: NODES[1], index: 1 },
      { name: 'candidate', item: NODES[1], index: 1 },
    ]);
  });
});

describe('selectFirst at run time', () => {
  test('a list expression that is not a list fails the run, naming the section and row', async () => {
    const outcome = await runTable(TABLE, 'abc');

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('nodes/probe_unknown criteria failed: selectFirst evaluated to string, expected a list');
  });

  test('a when that fails for one item names the binding and the item\'s index', async () => {
    const outcome = await runTable(TABLE, [{ id: 'a', status: 'settled', fact: 'yes' }, null]);

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/^nodes\/probe_unknown criteria failed: node = item 1: \S/);
    expect(outcome.error.message).not.toContain('\n');
  });

  test('a when that is not a boolean for an item fails the run, as any when does', async () => {
    const outcome = await runTable(TABLE.replace('node.status == "open" && node.fact == "unknown"', 'node.fact'), NODES);

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('nodes/probe_unknown criteria failed: node = item 0: when evaluated to string, expected a boolean');
  });
});

describe('selectFirst at load', () => {
  const registry = makeRegistry();
  const problemsWith = (selectFirst, when = 'node.status == "open"') => Rulebook.check(
    TABLE.replace('selectFirst: { node: ws.nodes }', `selectFirst: ${selectFirst}`).replace('node.status == "open" && node.fact == "unknown"', when),
    registry,
  );
  const row = 'section "nodes" rule 1 (probe_unknown)';

  test('a binding that is a reserved word, ws, or a registered function is refused', () => {
    expect(problemsWith('{ true: ws.nodes }', '"true"')).toContain(`${row} selectFirst: binding "true" is a CEL reserved word`);
    expect(problemsWith('{ ws: ws.nodes }', '"true"')).toContain(`${row} selectFirst: binding "ws" would hide the working set`);
    expect(problemsWith('{ app_open: ws.nodes }', '"true"')).toContain(`${row} selectFirst: binding "app_open" is a registered function's name`);
  });

  test('a binding named like one of CEL\'s own types is a problem in its row, never a thrown error', () => {
    for (const name of ['string', 'int', 'uint', 'bool', 'double', 'bytes', 'list', 'map', 'type', 'null_type', 'google']) {
      expect(problemsWith(`{ ${name}: ws.nodes }`, '"true"')).toEqual([`${row} selectFirst: binding "${name}" is a name CEL already defines`]);
    }
  });

  test('a list expression of a known type that is not a list is refused', () => {
    expect(problemsWith('{ node: \'"abc"\' }')).toEqual([`${row} selectFirst: has type string, expected list`]);
    expect(problemsWith('{ node: "[1, 2]" }')).toEqual([]);
  });

  test('a list expression gets the usual field checks', () => {
    expect(problemsWith('{ node: ws.nodez }')).toEqual([`${row} selectFirst: unknown ws field "nodez"`]);
  });

  test('a binding exists only in its own row', () => {
    const elsewhere = Rulebook.check(TABLE.replace('ws.nodes.all(n, n.status == "settled")', 'node.status == "settled"'), registry);
    const inSectionWhen = Rulebook.check(TABLE.replace('when: ws.status == null', 'when: ws.status == null && node.id == "a"'), registry);

    expect(elsewhere).toEqual([expect.stringMatching(/^section "nodes" rule 2 \(close\) when: .*node/)]);
    expect(inSectionWhen).toEqual([expect.stringMatching(/^section "nodes" when: .*node/)]);
  });

  test('the schema takes exactly one binding, named like a section', () => {
    expect(problemsWith('{ node: ws.nodes, other: ws.nodes }').join('\n')).toMatch(/selectFirst/);
    expect(problemsWith('{ Node: ws.nodes }', '"true"').join('\n')).toMatch(/selectFirst/);
  });
});
