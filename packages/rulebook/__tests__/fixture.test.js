import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadFixture, Rulebook } from '../index.js';

const RULEBOOK = `
version: 1
sections:
  - name: gather
    when: ws.routing == null && !has(ws.classification)
    needs:
      classification: classify_item
  - name: decide
    when: ws.routing == null
    rules:
      - id: urgent
        when: ws.classification.urgent == true
        then: { action: settle, routing: escalate }
      - id: fallback
        when: "true"
        then: { action: settle, routing: hold }
`;

// The real producer would call a model; a fixture run must never reach it.
const registry = {
  producers: { classify_item: { writes: ['classification'], run: async () => { throw new Error('producer called'); } } },
  actions: {
    settle: {
      params: { type: 'object', properties: { routing: { type: 'string' } }, additionalProperties: false },
      writes: ['routing'],
      run: async (ws, { params, deps }) => {
        deps.settled.push(params.routing);
        ws.routing = params.routing;
      },
    },
  },
  initialKeys: ['item'],
};

const FIXTURE = {
  initial: { item: 'server down', routing: null },
  produce: { classification: { urgent: true } },
  expect: { status: 'completed', fired: ['gather classification', 'urgent'] },
};

const run = (overrides = {}) => Rulebook.fromText(overrides.rulebookText ?? RULEBOOK, registry).runFixture({
  fixture: overrides.fixture ?? FIXTURE,
  deps: overrides.deps ?? { settled: [] },
  finishChecker: (ws) => ws.routing !== null,
});

describe('rulebook.runFixture', () => {
  test('a fixture whose expectations hold has no mismatches, and the real action ran with the given deps', async () => {
    const deps = { settled: [] };
    const result = await run({ deps });

    expect(result.mismatches).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.workingSet).toMatchObject({ item: 'server down', classification: { urgent: true }, routing: 'escalate' });
    expect(deps.settled).toEqual(['escalate']);
    expect(result.trace.map((entry) => entry.fired)).toEqual([['gather classification'], ['urgent']]);
  });

  test('an edited row that changes which row fires shows up as a fired mismatch', async () => {
    const edited = RULEBOOK.replace('ws.classification.urgent == true', 'ws.classification.urgent == false');

    expect((await run({ rulebookText: edited })).mismatches).toEqual([
      'fired: expected ["gather classification","urgent"], got ["gather classification","fallback"]',
    ]);
  });

  test('a needs key missing from produce fails the run, naming the key', async () => {
    const result = await run({ fixture: { ...FIXTURE, produce: {} } });

    expect(result.status).toBe('failed');
    expect(result.mismatches).toEqual([
      expect.stringMatching(/^status: expected "completed", got "failed" \(.*fixture has no produce value for "classification"/),
      'fired: expected ["gather classification","urgent"], got []',
      'produce: no value for "classification", which the run needed',
    ]);
  });

  test('a fixture expecting failed still names a missing produce key, so it cannot pass for that reason', async () => {
    const fixture = { initial: FIXTURE.initial, produce: {}, expect: { status: 'failed' } };

    expect((await run({ fixture })).mismatches).toEqual(['produce: no value for "classification", which the run needed']);
  });

  test('a produce key can\'t come from Object\'s prototype: a needs key named like one doesn\'t load', () => {
    const rulebookText = RULEBOOK.replaceAll('classification', 'toLocaleString');

    expect(() => Rulebook.fromText(rulebookText, registry)).toThrow('section "gather" needs "toLocaleString": that name is a property of every JavaScript object');
  });

  test('a status that differs is a mismatch; fired is compared only when expected', async () => {
    const fixture = { ...FIXTURE, expect: { status: 'no_match' } };

    expect((await run({ fixture })).mismatches).toEqual(['status: expected "no_match", got "completed"']);
  });

  test('the fixture is not changed by the run, even by actions that change nested values', async () => {
    const fixture = { ...structuredClone(FIXTURE), initial: { item: 'server down', notes: [], routing: null } };
    const noting = {
      ...registry,
      actions: { settle: { writes: ['routing'], params: { type: 'object', properties: { routing: { type: 'string' } }, additionalProperties: false }, run: async (ws, { params }) => { ws.notes.push(params.routing); ws.routing = params.routing; } } },
    };
    await Rulebook.fromText(RULEBOOK, noting).runFixture({ fixture, finishChecker: (ws) => ws.routing !== null });

    expect(fixture.initial).toEqual({ item: 'server down', notes: [], routing: null });
    expect(fixture.produce).toEqual(FIXTURE.produce);
  });
});

const TRIAGE_FIXTURE = fileURLToPath(new URL('./fixtures/triage-fixture.yaml', import.meta.url));

describe('the README\'s fixture example', () => {
  test('is the triage fixture file, word for word', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf-8');
    const example = readme.split('## Fixture runs')[1]?.match(/```yaml\n([\s\S]*?)```/)?.[1];

    expect(example, 'README has a ```yaml block under "## Fixture runs"').toBeDefined();
    expect(example).toBe(readFileSync(TRIAGE_FIXTURE, 'utf-8'));
  });

  test('runs as written, with the agent\'s finalizer', async () => {
    const outcome = await Rulebook.fromText(RULEBOOK, registry).runFixture({
      fixture: loadFixture(TRIAGE_FIXTURE),
      deps: { settled: [] },
      finishChecker: (ws) => ws.routing !== null,
      finalizer: (ws) => ({ routing: ws.routing }),
    });

    expect(outcome.mismatches).toEqual([]);
    expect(outcome.result).toEqual({ routing: 'escalate' });
  });
});

describe('loadFixture', () => {
  test('reads a YAML fixture', () => {
    expect(loadFixture(TRIAGE_FIXTURE)).toEqual({ ...FIXTURE, expect: { ...FIXTURE.expect, result: { routing: 'escalate' } } });
  });

  test('refuses a malformed fixture, naming the file and the problem', () => {
    const directory = mkdtempSync(join(tmpdir(), 'belaykit-fixture-'));
    const path = join(directory, 'bad.yaml');
    writeFileSync(path, 'initial: {}\nexpect: { status: done }\nproduced: {}\n');

    expect(() => loadFixture(path)).toThrow(`${path}: (top level): unknown key "produced"`);
    expect(() => loadFixture(path)).toThrow(`${path}: expect.status: must be one of completed, no_match, failed`);
  });
});
