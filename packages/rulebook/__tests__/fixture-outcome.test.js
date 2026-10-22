import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadFixture, Rulebook } from '../index.js';

// A fixture can state the result the agent should return and the failure a run should
// end with, so a table's outcome and its guards are pinned in text.
const RULEBOOK = `
version: 1
sections:
  - name: nodes
    when: ws.status == null
    exhaustive: false
    rules:
      - id: confirm_open
        selectFirst: { node: ws.nodes }
        when: node.status == "open"
        then: { action: confirm }
      - id: close
        when: "true"
        then: { action: close }
`;

const registry = {
  producers: {},
  actions: {
    confirm: {
      writes: ['nodes'],
      run: async (ws, { selected }) => {
        ws.nodes = ws.nodes.map((node, index) => (index === selected.index ? { ...node, status: 'settled' } : node));
      },
    },
    close: { writes: ['status'], run: async (ws) => { ws.status = 'closed'; } },
  },
  initialKeys: ['nodes', 'status'],
};

// Cautious: the case closes only if every node's fact is a confirmed yes.
const caseOutcome = (ws) => ({ outcome: ws.nodes.every((node) => node.fact === 'yes') ? 'close' : 'hold' });

const run = (fixture, { text = RULEBOOK, finalizer = caseOutcome } = {}) => Rulebook.fromText(text, registry).runFixture({
  fixture,
  finishChecker: (ws) => ws.status !== null,
  ...(finalizer && { finalizer }),
});

const nodes = (...facts) => facts.map((fact, index) => ({ id: `n${index}`, status: 'open', fact }));

describe('a fixture that states the result', () => {
  test('passes when the agent\'s result is the one expected, and returns it', async () => {
    const outcome = await run({ initial: { nodes: nodes('yes', 'unknown'), status: null }, expect: { status: 'completed', result: { outcome: 'hold' } } });

    expect(outcome.mismatches).toEqual([]);
    expect(outcome.result).toEqual({ outcome: 'hold' });
    expect('error' in outcome).toBe(false);
  });

  test('names a result that differs', async () => {
    const outcome = await run({ initial: { nodes: nodes('yes', 'yes'), status: null }, expect: { status: 'completed', result: { outcome: 'hold' } } });

    expect(outcome.mismatches).toEqual(['result: expected {"outcome":"hold"}, got {"outcome":"close"}']);
  });

  test('without a finalizer, the result is the final working set', async () => {
    const initial = { nodes: nodes('yes'), status: null };
    const outcome = await run({ initial, expect: { status: 'completed' } }, { finalizer: null });

    expect(outcome.result).toEqual({ nodes: [{ id: 'n0', status: 'settled', fact: 'yes' }], status: 'closed' });
  });
});

describe('a fixture that states the failure', () => {
  const failing = { initial: { nodes: 'n0,n1', status: null }, expect: { status: 'failed', error: 'selectFirst evaluated to string' } };

  test('passes when the run fails with a message containing the expected text, and returns the message', async () => {
    const outcome = await run(failing);

    expect(outcome.mismatches).toEqual([]);
    expect(outcome.error).toBe('nodes/confirm_open criteria failed: selectFirst evaluated to string, expected a list');
    expect('result' in outcome).toBe(false);
  });

  test('names a different failure', async () => {
    const outcome = await run({ ...failing, expect: { status: 'failed', error: 'pattern must be a string literal' } });

    expect(outcome.mismatches).toEqual([
      'error: expected a message containing "pattern must be a string literal", got "nodes/confirm_open criteria failed: selectFirst evaluated to string, expected a list"',
    ]);
  });

  test('names an expected failure that did not happen, and an expected result the run never returned', async () => {
    const completed = await run({ initial: { nodes: nodes('yes'), status: null }, expect: { status: 'completed', error: 'boom' } });
    const failed = await run({ ...failing, expect: { status: 'failed', result: { outcome: 'hold' } } });

    expect(completed.mismatches).toEqual(['error: expected a message containing "boom", got none']);
    expect(failed.mismatches).toEqual(['result: expected {"outcome":"hold"}, got none']);
  });
});

test('a mismatched result that holds a CEL integer (a BigInt) is named, not thrown', async () => {
  const counting = `
version: 1
sections:
  - name: count
    when: ws.status == null
    exhaustive: false
    rules:
      - id: pick_two
        selectFirst: { n: "[1, 2, 3]" }
        when: n == 2
        then: { action: close }
`;
  const keeping = { ...registry, actions: { close: { writes: ['status'], run: async (ws, { selected }) => { ws.status = selected.item; } } } };
  const outcome = await Rulebook.fromText(counting, keeping).runFixture({
    fixture: { initial: { nodes: [], status: null }, expect: { status: 'completed', result: 2 } },
    finishChecker: (ws) => ws.status !== null,
    finalizer: (ws) => ws.status,
  });

  expect(outcome.result).toBe(2n);
  expect(outcome.mismatches).toEqual(['result: expected 2, got 2n']);
});

test('a string that looks like a BigInt keeps its quotes in a mismatch', async () => {
  const outcome = await run({ initial: { nodes: [], status: null }, expect: { status: 'completed', result: '5n' } }, { finalizer: () => ({ count: '5n', big: 5n }) });

  expect(outcome.mismatches).toEqual(['result: expected "5n", got {"count":"5n","big":5n}']);
});

test('loadFixture reads result and error in expect', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'belaykit-fixture-')), 'outcome.yaml');
  writeFileSync(path, 'initial: { nodes: [], status: null }\nexpect: { status: failed, error: "selectFirst", result: { outcome: hold } }\n');

  expect(loadFixture(path).expect).toEqual({ status: 'failed', error: 'selectFirst', result: { outcome: 'hold' } });
});
