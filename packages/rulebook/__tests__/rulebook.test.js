import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

// A rulebook keeps the registry it was checked against, so what it provides can't be run
// with another one. `regather` has a gathered key produced again, from an action.
const RULEBOOK = `
version: 1
sections:
  - name: read
    when: '!("page" in ws.gathered)'
    needs: { page: read_page }
  - name: segment
    when: ws.accepted == null
    needs: { segmentation: segment_page }
    rules:
      - id: retry
        selectFirst: { attempt: ws.attempts }
        when: attempt == "first" && ws.segmentation == "rough"
        then: { action: resegment }
        why: a rough segmentation gets one more try
      - when: "true"
        then: { action: accept, note: ok }
`;

const registry = (pages = ['rough', 'clean']) => ({
  producers: {
    read_page: { writes: ['page'], run: async () => 'text' },
    segment_page: { writes: ['segmentation'], run: async () => pages.shift() },
  },
  actions: {
    resegment: { writes: ['attempts'], run: async () => {} },
    accept: { writes: ['accepted'], params: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false }, run: async (ws) => { ws.accepted = true; } },
  },
  initialKeys: ['attempts', 'accepted'],
});

describe('making a rulebook', () => {
  test('only load and fromText make one', () => {
    expect(() => new Rulebook()).toThrow(new TypeError('new Rulebook: use Rulebook.load(path, registry) or Rulebook.fromText(text, registry)'));
  });

  test('load reads a file and checks it like fromText', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'belaykit-rulebook-')), 'segment.rules.yaml');
    writeFileSync(path, RULEBOOK);

    expect(Rulebook.load(path, registry()).declaredKeys).toEqual(['page', 'segmentation']);
    expect(() => Rulebook.load(path, { ...registry(), actions: {} })).toThrow(/unknown action "resegment"/);
  });
});

describe('what a rulebook shows', () => {
  test('its sections and their rules, as loaded, without the CEL environment', () => {
    const { sections } = Rulebook.fromText(RULEBOOK, registry());

    expect(sections).toEqual([
      { name: 'read', when: '!("page" in ws.gathered)', needs: { page: 'read_page' }, hitPolicy: 'FIRST', rules: [] },
      {
        name: 'segment', when: 'ws.accepted == null', needs: { segmentation: 'segment_page' }, hitPolicy: 'FIRST',
        rules: [
          { id: 'retry', selectFirst: { name: 'attempt', expression: 'ws.attempts' }, when: 'attempt == "first" && ws.segmentation == "rough"', action: 'resegment', params: {}, why: 'a rough segmentation gets one more try' },
          { id: 'segment#2', selectFirst: null, when: 'true', action: 'accept', params: { note: 'ok' }, why: null },
        ],
      },
    ]);
  });

  test('changing what it shows doesn\'t change the rulebook', () => {
    const rulebook = Rulebook.fromText(RULEBOOK, registry());
    rulebook.sections[1].rules.length = 0;
    rulebook.sections[0].needs.page = 'segment_page';
    rulebook.declaredKeys.length = 0;
    const shown = rulebook.sections;
    shown[1].rules[1].params.note = 'changed';

    expect(rulebook.sections[1].rules).toHaveLength(2);
    expect(rulebook.sections[0].needs).toEqual({ page: 'read_page' });
    expect(rulebook.sections[1].rules[1].params).toEqual({ note: 'ok' });
    expect(rulebook.declaredKeys).toEqual(['page', 'segmentation']);
  });
});

describe('rulebook.regather', () => {
  test('sets a gathered key back to null and out of gathered, so its section gathers it again', () => {
    const rulebook = Rulebook.fromText(RULEBOOK, registry());
    const ws = { ...rulebook.initialize({ attempts: ['first'], accepted: null }), page: 'text', segmentation: 'rough', gathered: ['page', 'segmentation'] };

    rulebook.regather(ws, 'segmentation');

    expect(ws).toMatchObject({ page: 'text', segmentation: null, gathered: ['page'] });
  });

  test('a run re-gathers through it from an action, and the producer runs again', async () => {
    const rulebook = Rulebook.fromText(RULEBOOK, {
      ...registry(),
      actions: {
        ...registry().actions,
        resegment: { writes: ['attempts'], run: async (ws) => { ws.attempts = ['second']; rulebook.regather(ws, 'segmentation'); } },
      },
    });
    const outcome = await new Agent({
      initializer: () => rulebook.initialize({ attempts: ['first'], accepted: null }),
      choiceProvider: rulebook.provider(),
      finishChecker: (ws) => ws.accepted === true,
    }).run();

    expect(outcome.status).toBe('completed');
    expect(outcome.trace.flatMap((entry) => entry.fired)).toEqual(['gather page', 'gather segmentation', 'retry', 'gather segmentation', 'segment#2']);
    expect(outcome.workingSet.segmentation).toBe('clean');
  });

  test('a key the rulebook doesn\'t declare is refused, naming it and the declared keys', () => {
    const rulebook = Rulebook.fromText(RULEBOOK, registry());
    const ws = rulebook.initialize({ attempts: ['first'], accepted: null });

    expect(() => rulebook.regather(ws, 'segmentaton')).toThrow(
      new TypeError('regather: "segmentaton" is not a needs key of this rulebook (needs keys: page, segmentation)'),
    );
    expect(ws.gathered).toEqual([]);
  });

  test('called from an action with an undeclared key, it ends the run failed, naming the key', async () => {
    const rulebook = Rulebook.fromText(RULEBOOK, {
      ...registry(),
      actions: { ...registry().actions, resegment: { writes: ['attempts'], run: async (ws) => rulebook.regather(ws, 'segmentaton') } },
    });
    const outcome = await new Agent({
      initializer: () => rulebook.initialize({ attempts: ['first'], accepted: null }),
      choiceProvider: rulebook.provider(),
      finishChecker: (ws) => ws.accepted === true,
    }).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('segment/retry action failed: regather: "segmentaton" is not a needs key of this rulebook (needs keys: page, segmentation)');
  });
});

describe('rulebook.runFixture', () => {
  const fixture = { initial: { attempts: ['second'], accepted: null }, produce: { page: 'text', segmentation: 'clean' }, expect: { status: 'completed' } };

  test('an option it doesn\'t take is refused, listing the ones it does', async () => {
    const rulebook = Rulebook.fromText(RULEBOOK, registry());

    await expect(rulebook.runFixture({ fixture, isFinished: (ws) => ws.accepted === true })).rejects.toThrow(
      new TypeError('rulebook.runFixture: unknown option "isFinished" (options: fixture, deps, finishChecker, finalizer, maxIterations)'),
    );
  });

  test('runs with the rulebook\'s own registry', async () => {
    const outcome = await Rulebook.fromText(RULEBOOK, registry()).runFixture({ fixture, finishChecker: (ws) => ws.accepted === true });

    expect(outcome.mismatches).toEqual([]);
    expect(outcome.trace.flatMap((entry) => entry.fired)).toEqual(['gather page', 'gather segmentation', 'segment#2']);
  });
});

describe('what a rulebook runs', () => {
  const run = (rulebook) => new Agent({
    initializer: () => rulebook.initialize({ attempts: ['second'], accepted: null }),
    choiceProvider: rulebook.provider(),
    finishChecker: (ws) => ws.accepted === true,
  }).run();

  test('changing the registry after load doesn\'t change what the rulebook runs', async () => {
    const changing = registry(['clean']);
    const rulebook = Rulebook.fromText(RULEBOOK, changing);
    delete changing.actions.accept;
    changing.producers.read_page.run = async () => { throw new Error('swapped in after the check'); };

    const outcome = await run(rulebook);

    expect(outcome.status).toBe('completed');
    expect(outcome.workingSet.page).toBe('text');
  });

  test('an action can\'t change its rule\'s params for later runs: they are read-only', async () => {
    const changing = registry(['clean', 'clean']);
    changing.actions.accept = { ...changing.actions.accept, run: async (ws, { params }) => { params.note = 'changed'; ws.accepted = true; } };
    const rulebook = Rulebook.fromText(RULEBOOK, changing);

    const outcome = await run(rulebook);

    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/^segment\/segment#2 action failed: .*read only property 'note'/);
    expect(rulebook.sections[1].rules[1].params).toEqual({ note: 'ok' });
  });
});

describe('rulebook.runFixture without what it needs', () => {
  const fixture = { initial: { attempts: ['second'], accepted: null }, produce: { page: 'text', segmentation: 'clean' }, expect: { status: 'completed' } };

  test('refuses a run with no fixture or no finish checker', async () => {
    const rulebook = Rulebook.fromText(RULEBOOK, registry());

    await expect(rulebook.runFixture({ finishChecker: () => true })).rejects.toThrow(new TypeError('rulebook.runFixture: "fixture" is required'));
    await expect(rulebook.runFixture({ fixture })).rejects.toThrow(new TypeError('rulebook.runFixture: "finishChecker" is required'));
    await expect(rulebook.runFixture()).rejects.toThrow(new TypeError('rulebook.runFixture: "fixture" is required'));
  });
});
