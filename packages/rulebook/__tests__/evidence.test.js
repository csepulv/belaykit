// Since 0.4: a rulebook declares `evidence:`, working-set keys every decision shows as the run left them, and a
// decision returns copies, so a caller can't change what the run saw.
import { evaluate } from '@marcbachmann/cel-js';
import { describe, expect, test } from 'vitest';
import { Rulebook } from '../index.js';

const registry = {
  producers: {
    configure: { writes: ['configuration'], run: async (ws, deps) => deps.configuration ?? { mode: 'site' } },
    listClients: { writes: ['clients'], run: async (ws, deps) => (deps.clients === undefined ? ['a'] : deps.clients) },
  },
  actions: {
    settle: {
      writes: ['routing'],
      params: { type: 'object', properties: { routing: { type: 'string' } }, required: ['routing'], additionalProperties: false },
      run: async (ws, { params, deps }) => {
        ws.routing = { route: params.routing };
        if (deps.keep) deps.keep.ws = ws;
      },
    },
    fail: { writes: ['routing'], run: async () => { throw new Error('router down'); } },
    note: { writes: ['memo'], run: async (ws) => { ws.memo = 'noted'; } },
  },
  initialKeys: ['item'],
};

const TRIAGE = ({ evidence = '[configuration, clients]', outputs = '[routing]' } = {}) => `
version: 1
outputs: ${outputs}
evidence: ${evidence}
sections:
  - name: gather
    when: '(!has(ws.configuration) || !has(ws.clients)) && ws.item != "skip"'
    needs: { configuration: configure, clients: listClients }
  - name: decide
    when: '!has(ws.routing) && ws.item != "skip"'
    rules:
      - id: broken
        when: ws.configuration.mode == "broken"
        then: { action: fail }
      - id: hold
        when: "true"
        then: { action: settle, routing: hold }
`;

describe('evidence: at load', () => {
  test('declared keys load: needs keys, initial keys, and keys an action writes', () => {
    expect(Rulebook.check(TRIAGE({ evidence: '[configuration, clients, item]' }), registry)).toEqual([]);
    const withMemo = TRIAGE({ evidence: '[memo]' });
    expect(Rulebook.check(withMemo, registry)).toEqual([]);
  });

  test('a key nothing declares, an output, and evidence without outputs are each refused', () => {
    expect(Rulebook.check(TRIAGE({ evidence: '[configuraton, routing]' }), registry)).toEqual([
      'evidence "configuraton": nothing declares it (a needs key, initialKeys, or a producer\'s or action\'s writes)',
      'evidence "routing" is an output; decide returns it already',
    ]);
    const withoutOutputs = TRIAGE().replace('outputs: [routing]\n', '');
    expect(Rulebook.check(withoutOutputs, registry)).toEqual(['evidence applies to a rulebook with outputs (what decide returns)']);
  });

  test.each([
    ['empty', '[]', 'evidence: must NOT have fewer than 1 items'],
    ['repeated', '[clients, clients]', 'evidence "clients" is listed more than once'],
    ['misnamed', '[Clients]', 'evidence "Clients": nothing declares it (a needs key, initialKeys, or a producer\'s or action\'s writes)'],
  ])('a list of evidence that is %s is refused', (_label, evidence, problem) => {
    expect(Rulebook.check(TRIAGE({ evidence }), registry)).toEqual([problem]);
  });

  test('several mistakes at once are each reported, none hiding another', () => {
    expect(Rulebook.check(TRIAGE({ evidence: '[configuraton, routing, clients, clients, configuraton]' }), registry)).toEqual([
      'evidence "configuraton" is listed more than once',
      'evidence "configuraton": nothing declares it (a needs key, initialKeys, or a producer\'s or action\'s writes)',
      'evidence "routing" is an output; decide returns it already',
      'evidence "clients" is listed more than once',
    ]);
    const withoutOutputs = TRIAGE({ evidence: '[configuraton]' }).replace('outputs: [routing]\n', '');
    expect(Rulebook.check(withoutOutputs, registry)).toEqual([
      'evidence applies to a rulebook with outputs (what decide returns)',
      'evidence "configuraton": nothing declares it (a needs key, initialKeys, or a producer\'s or action\'s writes)',
    ]);
  });
});

describe('evidence in a decision', () => {
  const rules = Rulebook.fromText(TRIAGE({ evidence: '[configuration, clients, item]' }), registry);

  test('a completed decision shows the declared keys, a producer\'s null included', async () => {
    const decision = await rules.decide({ item: 'x' }, { deps: { clients: null } });
    expect(decision.status).toBe('completed');
    expect(decision.evidence).toStrictEqual({ configuration: { mode: 'site' }, clients: null, item: 'x' });
  });

  test('a failed decision still shows what had been gathered', async () => {
    const decision = await rules.decide({ item: 'x' }, { deps: { configuration: { mode: 'broken' }, clients: null } });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide/broken action failed: router down');
    expect(decision.evidence).toStrictEqual({ configuration: { mode: 'broken' }, clients: null, item: 'x' });
  });

  test('a no_match decision shows only the keys present: absent ones are left out', async () => {
    const decision = await rules.decide({ item: 'skip' });
    expect(decision.status).toBe('no_match');
    expect(decision.evidence).toStrictEqual({ item: 'skip' });
  });

  test('when the initializer fails there is no working set, and the evidence is empty', async () => {
    const decision = await rules.decide({ item: 'x', routing: 'set' });
    expect(decision.status).toBe('failed');
    expect(decision.evidence).toStrictEqual({});
  });

  test('a rulebook without evidence: gives every decision an empty evidence', async () => {
    const plain = Rulebook.fromText(TRIAGE().replace('evidence: [configuration, clients]\n', ''), registry);
    expect((await plain.decide({ item: 'x' })).evidence).toStrictEqual({});
    expect((await plain.decide({ item: 'skip' })).evidence).toStrictEqual({});
  });

  test('evidence lists keys in their declared order', async () => {
    const decision = await Rulebook.fromText(TRIAGE({ evidence: '[item, clients, configuration]' }), registry).decide({ item: 'x' });
    expect(Object.keys(decision.evidence)).toEqual(['item', 'clients', 'configuration']);
  });
});

class Note { constructor() { this.text = 'held'; } }

// A decision whose evidence `memo` an action writes, and no expression reads.
const decideWithMemo = (memo, options) => {
  const settle = registry.actions.settle;
  const withMemo = { ...registry, actions: { ...registry.actions, settle: { ...settle, writes: ['routing', 'memo'], run: async (ws, context) => { await settle.run(ws, context); ws.memo = memo; } } } };
  return Rulebook.fromText(TRIAGE({ evidence: '[memo]' }), withMemo).decide({ item: 'x' }, options);
};

describe('a decision returns copies', () => {
  const rules = Rulebook.fromText(TRIAGE(), registry);

  test('changing a returned output or evidence value doesn\'t change the working set the run used', async () => {
    const keep = {};
    const configuration = { mode: 'site', limits: { max: 3 } };
    const decision = await rules.decide({ item: 'x' }, { deps: { configuration, keep } });
    decision.outputs.routing.route = 'changed';
    decision.evidence.configuration.limits.max = 99;
    expect(keep.ws.routing).toEqual({ route: 'hold' });
    expect(keep.ws.configuration.limits.max).toBe(3);
    expect(decision.evidence.configuration).not.toBe(configuration);
  });

  test('changing the working set after a decision doesn\'t change what it returned', async () => {
    const keep = {};
    const decision = await rules.decide({ item: 'x' }, { deps: { configuration: { mode: 'site', limits: { max: 3 } }, keep } });
    keep.ws.routing.route = 'changed';
    keep.ws.configuration.limits.max = 7;
    expect(decision.outputs.routing).toEqual({ route: 'hold' });
    expect(decision.evidence.configuration.limits.max).toBe(3);
  });

  // cel-js refuses a class instance in any key an expression touches, has() included ("Unsupported type"), so it's
  // in a key an action writes and no expression names.
  // A copy would drop the class, its private fields and its getters, so the value is refused rather than changed.
  test.each([
    ['itself', (memo) => memo, 'memo is an instance of Memo'],
    ['inside a list', (memo) => ({ notes: ['plain', memo] }), 'memo.notes[1] is an instance of Memo'],
    ['inside a Map', (memo) => new Map([['latest', memo]]), 'memo.get("latest") is an instance of Memo'],
  ])('a class instance, %s, fails the decision, naming where it is', async (_label, wrap, where) => {
    class Memo {
      #secret = 'kept inside';
      constructor() { this.text = 'held'; }
      get secret() { return this.#secret; }
    }
    const settle = registry.actions.settle;
    const withMemo = { ...registry, actions: { ...registry.actions, settle: { ...settle, writes: ['routing', 'memo'], run: async (ws, context) => { await settle.run(ws, context); ws.memo = wrap(new Memo()); } } } };
    const decision = await Rulebook.fromText(TRIAGE({ evidence: '[memo]' }), withMemo).decide({ item: 'x' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe(`decide: evidence "memo" can't be copied (${where}; a copy would drop its class, private fields and getters)`);
  });

  // What the walk reads is what structuredClone reads: enumerable own keys, getters called, a list's extra keys.
  test.each([
    ['behind a getter', () => ({ get latest() { return new Note(); } }), 'memo.latest is an instance of Note; a copy would drop its class, private fields and getters'],
    ['as a list\'s extra key', () => Object.assign(['plain'], { extra: new Note() }), 'memo.extra is an instance of Note; a copy would drop its class, private fields and getters'],
    ['in a Set', () => new Set([new Note()]), 'memo (a Set item) is an instance of Note; a copy would drop its class, private fields and getters'],
    ['as a Map key', () => new Map([[new Note(), 1]]), 'memo (a Map key) is an instance of Note; a copy would drop its class, private fields and getters'],
    ['a Buffer, which would come back as a Uint8Array', () => Buffer.from('a'), 'memo is an instance of Buffer; a copy would drop its class, private fields and getters'],
    ['a CEL uint', () => evaluate('1u'), 'memo is an instance of UnsignedInt; a CEL uint; store a number or a BigInt'],
  ])('a value is refused %s', async (_label, make, reason) => {
    const decision = await decideWithMemo(make());
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe(`decide: evidence "memo" can't be copied (${reason})`);
  });

  test('a key a copy skips (not enumerable) isn\'t refused', async () => {
    const memo = Object.defineProperty({ text: 'held' }, 'hidden', { value: new Note(), enumerable: false });
    const decision = await decideWithMemo(memo);
    expect(decision.status).toBe('completed');
    expect(decision.evidence.memo).toStrictEqual({ text: 'held' });
  });

  test('a value nested however deep resolves, never rejects', async () => {
    const deep = (bottom) => Array.from({ length: 10_000 }).reduce((inner) => ({ next: inner }), bottom);
    const withNote = await decideWithMemo(deep(new Note()));
    expect(withNote.status).toBe('failed');
    expect(withNote.error).toMatch(/^decide: evidence "memo" can't be copied \(memo(\.next)+ is an instance of Note; /);
    expect(['completed', 'failed']).toContain((await decideWithMemo(deep(null))).status);
  });

  test('plain data copies whole: objects, lists, Map, Set, Date, a typed array, null and no prototype', async () => {
    const memo = { list: [1, 'two'], map: new Map([['k', { v: 1 }]]), set: new Set([3]), when: new Date(0), bytes: new Uint8Array([1]), none: null, bare: Object.create(null) };
    const settle = registry.actions.settle;
    const withMemo = { ...registry, actions: { ...registry.actions, settle: { ...settle, writes: ['routing', 'memo'], run: async (ws, context) => { await settle.run(ws, context); ws.memo = memo; } } } };
    const decision = await Rulebook.fromText(TRIAGE({ evidence: '[memo]' }), withMemo).decide({ item: 'x' });
    expect(decision.status).toBe('completed');
    expect(decision.evidence.memo).toEqual(memo);
    expect(decision.evidence.memo).not.toBe(memo);
  });

  test('a getter that throws is a copy problem, and decide still resolves', async () => {
    const clients = { get count() { throw new Error('getter blew up'); } };
    const decision = await rules.decide({ item: 'x' }, { deps: { clients } });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: evidence "clients" can\'t be copied (getter blew up)');
  });

  test('a no_match run whose evidence can\'t be copied is failed, its explanation first', async () => {
    const text = TRIAGE().replace('      - id: hold\n        when: "true"\n        then: { action: settle, routing: hold }\n', '')
      .replace("    when: '!has(ws.routing)", "    exhaustive: false\n    when: '!has(ws.routing)");
    const decision = await Rulebook.fromText(text, registry).decide({ item: 'x' }, { deps: { clients: { explain() {} } } });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: no section decided; unset outputs: routing; sections: gather (when false), decide (when true, no rule held)'
      + '; decide: evidence "clients" can\'t be copied (explain() {} could not be cloned.)');
  });

  test('a value that can\'t be copied fails the decision, naming it', async () => {
    const decision = await rules.decide({ item: 'x' }, { deps: { clients: { count: 1, explain() {} } } });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: evidence "clients" can\'t be copied (explain() {} could not be cloned.)');
    expect(decision.evidence).toStrictEqual({ configuration: { mode: 'site' } });
    expect(decision).not.toHaveProperty('outputs');
  });

  test('an output that can\'t be copied fails the decision too', async () => {
    const withFunction = { ...registry, actions: { ...registry.actions, settle: { ...registry.actions.settle, run: async (ws) => { ws.routing = () => 'hold'; } } } };
    const decision = await Rulebook.fromText(TRIAGE(), withFunction).decide({ item: 'x' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toMatch(/^decide: output "routing" can't be copied \(.* could not be cloned\.\)$/);
  });

  test('on a run that ended otherwise, its own message comes first', async () => {
    const failed = await rules.decide({ item: 'x' }, { deps: { configuration: { mode: 'broken' }, clients: { explain() {} } } });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('decide/broken action failed: router down; decide: evidence "clients" can\'t be copied (explain() {} could not be cloned.)');
  });
});

// structuredClone leaves some keys out without an error; `onCopyLoss` says whether that fails the decision.
describe('onCopyLoss', () => {
  const tag = Symbol('tag');
  const LOSSES = [
    ['a symbol key', () => ({ text: 'held', [tag]: 'x' }), { text: 'held' }, 'memo has a symbol key, Symbol(tag)'],
    ['a list\'s symbol key, inside an object', () => ({ notes: Object.assign(['plain'], { [tag]: 'x' }) }), { notes: ['plain'] }, 'memo.notes has a symbol key, Symbol(tag)'],
    ['a key that isn\'t enumerable', () => Object.defineProperty({ text: 'held' }, 'hidden', { value: 1, enumerable: false }), { text: 'held' }, 'memo has a key that isn\'t enumerable, "hidden"'],
    ['a Map\'s own key', () => Object.assign(new Map([['k', 1]]), { extra: 'e' }), new Map([['k', 1]]), 'memo is a Map with a key of its own, "extra"'],
    ['a Map\'s own constructor key', () => Object.assign(new Map(), { constructor: 'e' }), new Map(), 'memo is a Map with a key of its own, "constructor"'],
    ['a Date\'s own key', () => Object.assign(new Date(0), { extra: 'e' }), new Date(0), 'memo is a Date with a key of its own, "extra"'],
    ['an ArrayBuffer\'s own key', () => Object.assign(new ArrayBuffer(1), { extra: 'e' }), new ArrayBuffer(1), 'memo is an ArrayBuffer with a key of its own, "extra"'],
    ['a typed array\'s own key', () => Object.assign(new Uint8Array([1]), { extra: 'e' }), new Uint8Array([1]), 'memo is a Uint8Array with a key of its own, "extra"'],
    ['a typed array\'s own key that reads like an item', () => Object.assign(new Uint8Array([1]), { '01': 'e' }), new Uint8Array([1]), 'memo is a Uint8Array with a key of its own, "01"'],
    ['a DataView\'s own key that reads like an item', () => Object.assign(new DataView(new ArrayBuffer(1)), { 0: 'e' }), new DataView(new ArrayBuffer(1)), 'memo is a DataView with a key of its own, "0"'],
  ];

  test.each(LOSSES)('by default (drop), %s is left out of the copy', async (_label, make, copied) => {
    for (const options of [undefined, { onCopyLoss: 'drop' }]) {
      const decision = await decideWithMemo(make(), options);
      expect(decision.status).toBe('completed');
      expect(decision.evidence.memo).toStrictEqual(copied);
    }
  });

  test.each(LOSSES)('with fail, %s fails the decision, naming where it is', async (_label, make, _copied, where) => {
    const decision = await decideWithMemo(make(), { onCopyLoss: 'fail' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe(`decide: evidence "memo" can't be copied (${where}, which a copy leaves out)`);
  });

  // A copy keeps the key but resets its value to 0, so a non-zero one is a loss too.
  test('a RegExp\'s non-zero lastIndex comes back 0 by default, and with fail fails the decision', async () => {
    const pattern = Object.assign(/x/g, { lastIndex: 5 });
    const dropped = await decideWithMemo({ pattern });
    expect(dropped.status).toBe('completed');
    expect(dropped.evidence.memo.pattern.lastIndex).toBe(0);
    const failed = await decideWithMemo({ pattern }, { onCopyLoss: 'fail' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('decide: evidence "memo" can\'t be copied (memo.pattern is a RegExp whose lastIndex is 5, which a copy resets to 0)');
  });

  test('a value whose keys change between reads is still named by the key found', async () => {
    let reads = 0;
    const shifting = new Proxy({}, { ownKeys: (target) => (reads++ === 0 ? ['hidden'] : Reflect.ownKeys(target)) });
    const decision = await decideWithMemo(shifting, { onCopyLoss: 'fail' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: evidence "memo" can\'t be copied (memo has a key that isn\'t enumerable, "hidden", which a copy leaves out)');
  });

  test('with fail, what a copy keeps passes: plain data, a list\'s extra string key, a RegExp\'s lastIndex key, a getter', async () => {
    const memo = { list: Object.assign([1], { extra: 'e' }), pattern: /x/g, map: new Map([['k', 1]]), when: new Date(0), bytes: new Uint8Array([1]), bare: Object.create(null), get computed() { return 2; } };
    const decision = await decideWithMemo(memo, { onCopyLoss: 'fail' });
    expect(decision.status).toBe('completed');
    expect(decision.evidence.memo).toStrictEqual(structuredClone(memo));
  });

  test.each(['drop', 'fail'])('a class instance fails the decision with %s', async (onCopyLoss) => {
    const decision = await decideWithMemo({ latest: new Note() }, { onCopyLoss });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: evidence "memo" can\'t be copied (memo.latest is an instance of Note; a copy would drop its class, private fields and getters)');
  });

  test('with fail, an output that would lose a key fails the decision too', async () => {
    const withSymbol = { ...registry, actions: { ...registry.actions, settle: { ...registry.actions.settle, run: async (ws) => { ws.routing = { route: 'hold', [tag]: 'x' }; } } } };
    const decision = await Rulebook.fromText(TRIAGE(), withSymbol).decide({ item: 'x' }, { onCopyLoss: 'fail' });
    expect(decision.status).toBe('failed');
    expect(decision.error).toBe('decide: output "routing" can\'t be copied (routing has a symbol key, Symbol(tag), which a copy leaves out)');
  });

  test('with fail, a value nested however deep, or a Proxy whose keys throw, resolves, never rejects', async () => {
    const deep = Array.from({ length: 10_000 }).reduce((inner) => ({ next: inner }), { [tag]: 'x' });
    const deepDecision = await decideWithMemo(deep, { onCopyLoss: 'fail' });
    expect(deepDecision.status).toBe('failed');
    expect(deepDecision.error).toMatch(/^decide: evidence "memo" can't be copied \(memo(\.next)+ has a symbol key, Symbol\(tag\), which a copy leaves out\)$/);
    const proxy = new Proxy({}, { ownKeys() { throw new Error('keys blew up'); } });
    const proxyDecision = await decideWithMemo(proxy, { onCopyLoss: 'fail' });
    expect(proxyDecision.status).toBe('failed');
    expect(proxyDecision.error).toBe('decide: evidence "memo" can\'t be copied (keys blew up)');
  });

  test.each([
    ['strict', '"strict"'],
    [null, 'null'],
    [{}, 'an object'],
    [true, 'a boolean'],
  ])('an onCopyLoss of %o is a TypeError', async (onCopyLoss, given) => {
    const rules = Rulebook.fromText(TRIAGE(), registry);
    await expect(rules.decide({ item: 'x' }, { onCopyLoss })).rejects.toThrow(new TypeError(`rulebook.decide: onCopyLoss must be "drop" or "fail", got ${given}`));
  });
});
