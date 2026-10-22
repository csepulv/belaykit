// Since 0.2: one presence model. A `needs` key is gathered when it is present in the
// working set; `null` is a value ("looked, found nothing") and counts. Nothing starts null, and
// there is no `ws.gathered`.
import { describe, expect, test } from 'vitest';
import { Agent } from '@belaykit/core';
import { Rulebook } from '../index.js';

const RULEBOOK = `
version: 1
sections:
  - name: read
    when: '!has(ws.page)'
    needs:
      page: read_page
  - name: decide
    when: ws.done == null
    rules:
      - id: none_found
        when: ws.page == null
        then: { action: finish, outcome: none }
      - id: found
        when: "true"
        then: { action: finish, outcome: found }
`;

const registryFor = (readPage) => ({
  producers: { read_page: { writes: ['page'], run: readPage } },
  actions: {
    finish: {
      writes: ['done'],
      params: { type: 'object', properties: { outcome: { type: 'string' } }, additionalProperties: false },
      run: async (ws, { params }) => { ws.done = params.outcome; },
    },
  },
  initialKeys: ['done'],
});

async function runWith(readPage) {
  const rules = Rulebook.fromText(RULEBOOK, registryFor(readPage));
  return new Agent({
    initializer: () => rules.initialize({ done: null }),
    choiceProvider: rules.provider(),
    finishChecker: (ws) => ws.done !== null,
  }).run();
}

describe('rulebook.initialize', () => {
  const rules = Rulebook.fromText(RULEBOOK, registryFor(async () => 'text'));

  test('adds nothing: a needs key is absent until it is gathered', () => {
    const initial = { done: null };
    const ws = rules.initialize(initial);
    expect(ws).toEqual({ done: null });
    expect(ws).not.toBe(initial);
  });

  // As before 0.2, no initial working set is an empty one.
  test('with no initial working set, starts empty', () => {
    expect(rules.initialize()).toEqual({});
  });

  test('a needs key holding undefined is absent, so it is accepted', () => {
    expect(rules.initialize({ done: null, page: undefined })).toEqual({ done: null, page: undefined });
  });

  test.each([['a value', 'text'], ['null', null]])('refuses a needs key already present, holding %s', (_label, page) => {
    expect(() => rules.initialize({ done: null, page })).toThrow(new TypeError('initialize: "page" is a needs key; its producer sets it'));
  });

  test('a fixture whose initial holds a needs key fails, saying so', async () => {
    const run = await rules.runFixture({
      fixture: { initial: { done: null, page: null }, produce: { page: 'text' }, expect: { status: 'completed' } },
      finishChecker: (ws) => ws.done !== null,
    });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('initializer failed: initialize: "page" is a needs key; its producer sets it');
  });
});

describe('gathering by presence', () => {
  test.each([
    ['a value', 'text', 'found'],
    ['null, which still counts as gathered', null, 'none_found'],
  ])('a producer that returns %s runs once, and the next section decides', async (_label, page, rule) => {
    let calls = 0;
    const outcome = await runWith(async () => { calls += 1; return page; });
    expect(outcome.status).toBe('completed');
    expect(calls).toBe(1);
    expect(outcome.trace.flatMap((entry) => entry.fired)).toEqual(['gather page', rule]);
    expect(outcome.workingSet).toEqual({ done: rule === 'found' ? 'found' : 'none', page });
  });

  test('a producer that returns undefined fails the run, naming the producer and the key', async () => {
    const outcome = await runWith(async () => {});
    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toBe('read/gather page action failed: producer "read_page" returned undefined for "page"; return null for found nothing');
  });

  // As for cel-js's has(), a key holding undefined is absent, so its section gathers it.
  test('a needs key holding undefined (an action cleared it) is gathered again', async () => {
    const rules = Rulebook.fromText(RULEBOOK, registryFor(async () => 'text'));
    const choiceSet = await rules.provider()({ done: null, page: undefined });
    expect(choiceSet?.choices.map((choice) => choice.name)).toEqual(['gather page']);
  });

  test('a rule that tests an absent key with == null fails the run, not silently', async () => {
    const rules = Rulebook.fromText(RULEBOOK.replace("'!has(ws.page)'", 'ws.page == null'), registryFor(async () => 'text'));
    const outcome = await new Agent({
      initializer: () => rules.initialize({ done: null }),
      choiceProvider: rules.provider(),
      finishChecker: (ws) => ws.done !== null,
    }).run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error.message).toMatch(/No such key: page/);
  });
});

describe('rulebook.regather', () => {
  test('deletes the key, so its section gathers it again', async () => {
    let calls = 0;
    const rules = Rulebook.fromText(RULEBOOK, registryFor(async () => { calls += 1; return 'again'; }));
    const ws = { done: null, page: 'first' };
    rules.regather(ws, 'page');
    expect(ws).toEqual({ done: null });
    const choiceSet = await rules.provider()(ws);
    expect(choiceSet.choices.map((choice) => choice.name)).toEqual(['gather page']);
    await choiceSet.choices[0].actions[0](ws);
    expect(ws.page).toBe('again');
    expect(calls).toBe(1);
  });
});

describe('ws.gathered is gone', () => {
  test('a rulebook that reads it fails to load, saying what to write instead', () => {
    const problems = Rulebook.check(RULEBOOK.replace("'!has(ws.page)'", '\'!("page" in ws.gathered)\''), registryFor(async () => 'text'));
    expect(problems).toEqual(['section "read" when: unknown ws field "gathered" (gone in 0.2: test has(ws.<key>) for a gathered key)']);
  });
});
